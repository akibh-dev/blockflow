import { browser } from 'wxt/browser';
import type { AgentRequest } from '../core/page';
import { hasTemplate } from '../core/template';
import type { DebugPause } from '../core/types';
import { act } from './pageDriver';
import { loadWorkflows } from './stores';
import { sleep } from './tabs';

/**
 * M5.2 debug channel (`Host.debug`): a debug run that reaches a breakpoint (or the next step after Step,
 * or a failure with "pause on error") waits here for the user.
 *
 * - The pause is listed in `storage.session` under `bf:debug-pause` (`PausedRun[]`), so an editor that
 *   opens later still shows it (`DebugBanner`). `storage.session` outlives a worker restart, but the
 *   paused run does not: `clearStaleDebugPauses` at worker start removes what nobody can answer.
 * - The answer is a `bf:debug-answer` message (Continue / Step / Stop), or Stop (`bf:stop-run`), which
 *   answers `stop`. Answers live in this worker's memory, like Manual Step answers (prompts.ts).
 * - While waiting, the channel polls every POLL_MS and calls an extension API each time, so the MV3
 *   worker is not stopped after 30 s idle (the background's `scheduler.hold` for live runs does too).
 * - The step's element is outlined on the page (page op `highlight`) while paused and cleared after.
 */

/** storage.session key: `PausedRun[]`, the debug runs waiting for Continue / Step / Stop. */
export const DEBUG_PAUSE_KEY = 'bf:debug-pause';

export type DebugAction = 'continue' | 'step' | 'stop';

/** One paused debug run, as listed in `bf:debug-pause` for the editor's banner. */
export interface PausedRun extends DebugPause {
  workflowName: string;
  /** ISO time the run paused. */
  pausedAt: string;
}

/** How often the wait looks for an answer (and pings the worker awake). */
export const POLL_MS = 500;
/** A pause nobody answers ends the run after this long (so a forgotten pause does not keep the worker up forever). */
export const MAX_PAUSE_MS = 60 * 60 * 1000;
/** How long the highlight may look for the element before giving up quietly. */
const HIGHLIGHT_TIMEOUT_MS = 2000;

export interface DebugChannelDeps {
  read(): Promise<PausedRun[]>;
  write(pauses: PausedRun[]): Promise<void>;
  /** Outline (or `clear`) the element; failures are ignored. */
  highlight(tabId: number, locator: string, clear: boolean): Promise<void>;
  /** Any extension API call: keeps the MV3 worker awake. */
  keepAlive(): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  workflowName(id: string): Promise<string | undefined>;
  /** Optional: logged when a pause times out. */
  warn?(message: string): void;
}

export interface DebugChannel {
  /** `Host.debug.pause`. */
  pause(info: DebugPause): Promise<DebugAction>;
  /** Answers a paused run. False when that run is not paused in this worker (unknown or already answered). */
  answer(runId: string, action: DebugAction): boolean;
  /** Is `runId` waiting in this worker? */
  isPaused(runId: string): boolean;
  /** Removes listed pauses this worker is not waiting on (left by a worker that stopped). */
  clearStale(): Promise<void>;
}

export function createDebugChannel(deps: DebugChannelDeps): DebugChannel {
  const answers = new Map<string, DebugAction | undefined>();
  // Read-modify-write of the list, one at a time (several runs may pause at once).
  let queue: Promise<unknown> = Promise.resolve();
  const update = (change: (pauses: PausedRun[]) => PausedRun[]): Promise<void> => {
    const next = queue.then(async () => deps.write(change(await deps.read())));
    queue = next.catch(() => {});
    return next;
  };

  const highlightable = (info: DebugPause): info is DebugPause & { tabId: number; locator: string } =>
    info.tabId !== undefined && typeof info.locator === 'string' && info.locator.trim() !== '' && !hasTemplate(info.locator);

  return {
    async pause(info) {
      answers.set(info.runId, undefined);
      const workflowName = (await deps.workflowName(info.workflowId).catch(() => undefined)) ?? '';
      const entry: PausedRun = { ...info, workflowName, pausedAt: new Date(deps.now()).toISOString() };
      await update((pauses) => [...pauses.filter((pause) => pause.runId !== info.runId), entry]);
      if (highlightable(info)) void deps.highlight(info.tabId, info.locator, false).catch(() => {});
      const deadline = deps.now() + MAX_PAUSE_MS;
      try {
        for (;;) {
          const answer = answers.get(info.runId);
          if (answer !== undefined) return answer;
          if (deps.now() >= deadline) {
            deps.warn?.(`Debugger: nobody answered within ${Math.round(MAX_PAUSE_MS / 60_000)} minutes; the run stops`);
            return 'stop';
          }
          await deps.keepAlive().catch(() => {});
          await deps.sleep(POLL_MS);
        }
      } finally {
        answers.delete(info.runId);
        await update((pauses) => pauses.filter((pause) => pause.runId !== info.runId)).catch(() => {});
        if (highlightable(info)) await deps.highlight(info.tabId, info.locator, true).catch(() => {});
      }
    },
    answer(runId, action) {
      if (!answers.has(runId) || answers.get(runId) !== undefined) return false;
      answers.set(runId, action);
      return true;
    },
    isPaused: (runId) => answers.has(runId),
    async clearStale() {
      await update((pauses) => pauses.filter((pause) => answers.has(pause.runId)));
    },
  };
}

/** The page op request for the element outline (`highlight`, src/core/page.ts) while paused, and its clearing. */
export function highlightRequest(locator: string, clear: boolean): AgentRequest {
  return clear ? { op: 'highlight', locator, clear: true } : { op: 'highlight', locator, label: 'BlockFlow: paused here' };
}

async function readPauses(): Promise<PausedRun[]> {
  const stored = await browser.storage.session.get(DEBUG_PAUSE_KEY);
  const list = stored[DEBUG_PAUSE_KEY];
  return Array.isArray(list) ? (list as PausedRun[]) : [];
}

/** The extension's channel (one per worker). */
export const debugChannel = createDebugChannel({
  read: readPauses,
  write: async (pauses) => {
    await browser.storage.session.set({ [DEBUG_PAUSE_KEY]: pauses });
  },
  highlight: async (tabId, locator, clear) => {
    await act(tabId, highlightRequest(locator, clear), HIGHLIGHT_TIMEOUT_MS);
  },
  keepAlive: async () => {
    await browser.runtime.getPlatformInfo();
  },
  sleep,
  now: () => Date.now(),
  workflowName: async (id) => (await loadWorkflows()).find((workflow) => workflow.id === id)?.name,
  warn: (message) => console.warn(`[BlockFlow] ${message}`),
});

/** `Host.debug` for createExtensionHost. */
export const pauseForDebug = (info: DebugPause): Promise<DebugAction> => debugChannel.pause(info);
/** From `bf:debug-answer` (and `stop` from Stop). Unknown run ids are ignored. */
export const answerDebug = (runId: string, action: DebugAction): boolean => debugChannel.answer(runId, action);
/** At worker start: pauses of runs that died with the previous worker. */
export const clearStaleDebugPauses = (): Promise<void> => debugChannel.clearStale();
