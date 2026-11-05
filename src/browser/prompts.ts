import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '../shared/keys';
import { sleep } from './tabs';

/**
 * Manual Step: the run waits until the user presses Continue (in the notification or in the
 * editor's banner) or Fail. Pending questions are listed in storage for the editor; the answers
 * live in this worker's memory, which stays awake because the wait keeps calling extension APIs.
 */

/** A Manual Step waiting for an answer, as listed in `bf:prompts` for the editor's banner. */
export interface PendingPrompt {
  runId: string;
  workflowName: string;
  message: string;
  askedAt: string;
}

const answers = new Map<string, boolean | undefined>();
const NOTIFICATION_PREFIX = 'bf-prompt:';

async function listPrompts(): Promise<PendingPrompt[]> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.prompts);
  return (stored[STORAGE_KEYS.prompts] as PendingPrompt[] | undefined) ?? [];
}

async function setPrompts(change: (prompts: PendingPrompt[]) => PendingPrompt[]): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.prompts]: change(await listPrompts()) });
}

/**
 * `Host.prompt.ask`: lists the question, shows a notification and polls (every 500 ms) for `answerPrompt`.
 * Resolves true for Continue, false for Fail; throws after `timeoutMs`. Always removes the prompt and notification.
 */
export async function askUser(options: { runId: string; workflowName: string; message: string; timeoutMs: number }): Promise<boolean> {
  answers.set(options.runId, undefined);
  await setPrompts((prompts) => [
    ...prompts.filter((prompt) => prompt.runId !== options.runId),
    { runId: options.runId, workflowName: options.workflowName, message: options.message, askedAt: new Date().toISOString() },
  ]);
  const notificationId = NOTIFICATION_PREFIX + options.runId;
  try {
    await browser.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: browser.runtime.getURL('/icon/128.png'),
      title: `${options.workflowName}: your turn`,
      message: options.message,
      requireInteraction: true,
      // Firefox has no notification buttons: clicking the notification means Continue there.
      ...(import.meta.env.FIREFOX ? {} : { buttons: [{ title: 'Continue' }, { title: 'Fail the run' }] }),
    });
  } catch {
    // The editor banner still works without a notification.
  }
  const deadline = Date.now() + options.timeoutMs;
  try {
    for (;;) {
      const answer = answers.get(options.runId);
      if (answer !== undefined) return answer;
      if (Date.now() >= deadline) throw new Error(`Nobody answered within ${Math.round(options.timeoutMs / 1000)}s`);
      // Any extension call keeps the worker from being stopped while we wait.
      await browser.runtime.getPlatformInfo();
      await sleep(500);
    }
  } finally {
    answers.delete(options.runId);
    await setPrompts((prompts) => prompts.filter((prompt) => prompt.runId !== options.runId));
    await browser.notifications.clear(notificationId).catch(() => false);
  }
}

/** From the notification or the editor. Unknown run ids are ignored (the worker restarted). */
export function answerPrompt(runId: string, ok: boolean): void {
  if (answers.has(runId)) answers.set(runId, ok);
}

/** The run id behind one of our Manual Step notifications, or null for any other notification. */
export function promptRunId(notificationId: string): string | null {
  return notificationId.startsWith(NOTIFICATION_PREFIX) ? notificationId.slice(NOTIFICATION_PREFIX.length) : null;
}

/** Prompts left over from a worker that stopped: nobody can answer them any more. */
export async function clearStalePrompts(): Promise<void> {
  await setPrompts((prompts) => prompts.filter((prompt) => answers.has(prompt.runId)));
}
