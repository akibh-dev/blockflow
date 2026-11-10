import type { ErrorCode } from './errors';
import type { Payload } from './types';
import type { ConsoleEntry } from './network';

/**
 * A run is one trip of data through a workflow: from a start block firing (or the Run button)
 * until every path has finished. Runs are what the editor shows step by step.
 */

/** call = started by a Run Workflow block; event = a page visit or context menu. */
export type RunTrigger = 'manual' | 'start' | 'timer' | 'call' | 'event';
/** How the editor names each trigger ("Started by: …"). */
export const TRIGGER_LABELS: Record<RunTrigger, string> = {
  manual: 'Run button',
  start: 'turned on',
  timer: 'schedule',
  event: 'page event',
  call: 'called by another workflow',
};
/** interrupted = the worker died mid-run (set by `markInterrupted`). */
export type RunStatus = 'running' | 'passed' | 'failed' | 'cancelled' | 'interrupted';
/** handled = failed, but the failure was dealt with (continue / error output). */
export type StepStatus = 'running' | 'passed' | 'failed' | 'handled' | 'skipped';

/** One block's execution within a run. Payloads are masked and compacted. */
export interface StepRecord {
  nodeId: string;
  blockType: string;
  status: StepStatus;
  /** ISO time. */
  startedAt: string;
  durationMs?: number;
  attempts: number;
  input?: Payload;
  output?: Payload;
  /** The output the result was sent from. */
  port?: string;
  error?: string;
  /** Set with `error`: what kind of failure it was (src/core/errors.ts). */
  code?: ErrorCode;
  /** The locator the failing step used. */
  locator?: string;
  /** URL of the page when the step failed (page steps). */
  url?: string;
  /** For `locator.strict`: up to 5 descriptions of the elements that matched. */
  matches?: string[];
  /** The node's id in the file it was imported from (`NodeDef.origin`), so a report maps back to the script. */
  sourceId?: string;
  /** Id of a screenshot taken for this step (see Host.screenshots). */
  screenshot?: string;
  /** For Run Workflow steps: the run of the called workflow. */
  childRunId?: string;
  /** Bounded page console/exception diagnostics, with secret values masked by the engine. */
  console?: ConsoleEntry[];
  /** M5.1 trace of this step (when the run or the step was traced). */
  trace?: StepTrace;
}

/** M5.1: what the page looked like around one step. Screenshot ids are blobStore keys, like `screenshot`. */
export interface StepTrace {
  /** Screenshot before the block ran. */
  before?: string;
  /** Screenshot after it finished (passed or failed). */
  after?: string;
  /** The element the step acted on, in CSS pixels of the screenshot (page steps with a locator). */
  box?: { x: number; y: number; width: number; height: number };
  /** Page URL after the step. */
  url?: string;
  /** Requests seen during the step when CDP was on: count, failed count and the slowest few (metadata only). */
  network?: { requests: number; failed: number; slowest?: { url: string; method: string; status?: number; ms: number }[] };
}

/** M5: how a run was started (Run, Debug, Run from here, traced). */
export interface RunOptions {
  /** Record a trace for every step (`StepSettings.trace` traces single steps). */
  trace?: boolean;
  /** Debug run: pause at breakpoints (`StepSettings.pause`); `pauseOnError` also pauses before a failure is handled. */
  debug?: { pauseOnError?: boolean };
  /** M5.5 "Run from here": start at this node with this input (the step's input from an earlier run) instead of the start blocks. */
  startAt?: { nodeId: string; input: Payload };
}

/** One run, as stored in `bf:runs` and shown in the editor. */
export interface RunRecord {
  id: string;
  workflowId: string;
  workflowName: string;
  trigger: RunTrigger;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  steps: StepRecord[];
  /** Steps not kept because the run was very long. */
  droppedSteps?: number;
  /** Why the run failed or stopped, in one line. */
  error?: string;
  /** Set when a Run Workflow block started this run. */
  parentRunId?: string;
  /** This run successfully acquired a Chromium debugger session (CDP). */
  usedDebugger?: boolean;
  /** M5: traced / debug run, or "Run from here" (the node it started at). */
  mode?: { trace?: boolean; debug?: boolean; startedAt?: string };
}

/** Receives a fresh copy of a run after every change. The background stores it; tests collect it. */
export type RunObserver = (run: RunRecord) => void;

/** Steps stored per run; later ones are only counted in `droppedSteps`. */
export const MAX_STEPS_KEPT = 300;
const MAX_PAYLOAD_CHARS = 3_000;

/**
 * Keeps a payload small enough to store with the run. Big payloads (a scraped page, a large API
 * response) are replaced by a preview, so run history cannot fill up storage.
 */
export function compactPayload(payload: Payload | undefined): Payload | undefined {
  if (!payload) return payload;
  let text: string;
  try {
    text = JSON.stringify(payload);
  } catch {
    return { $preview: '[not serialisable]' };
  }
  if (text.length <= MAX_PAYLOAD_CHARS) return payload;
  return { $preview: `${text.slice(0, MAX_PAYLOAD_CHARS)}…`, $size: text.length };
}

/** Runs still marked "running" when the background worker starts again never finished. */
export function markInterrupted(runs: RunRecord[], liveIds: Set<string>, now: string): RunRecord[] {
  return runs.map((run) =>
    run.status === 'running' && !liveIds.has(run.id)
      ? {
          ...run,
          status: 'interrupted',
          endedAt: now,
          error: 'The background worker stopped before this run finished.',
          steps: run.steps.map((step) => (step.status === 'running' ? { ...step, status: 'failed', error: 'Interrupted' } : step)),
        }
      : run,
  );
}

const MASK = '•••';

/** Replaces every secret value in `text`. Very short values are left alone (they would mask everything). */
export function maskText(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 3) out = out.split(secret).join(MASK);
  return out;
}

/** `maskText` over a JSON-serialisable value (secrets are matched in their JSON-escaped form). */
export function maskPayload<T>(value: T, secrets: string[]): T {
  if (secrets.length === 0 || value === undefined) return value;
  try {
    return JSON.parse(maskText(JSON.stringify(value), secrets.map((secret) => JSON.stringify(secret).slice(1, -1)))) as T;
  } catch {
    return value;
  }
}
