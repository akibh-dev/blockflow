import type { Payload } from './types';

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
  /** Id of a screenshot taken for this step (see Host.screenshots). */
  screenshot?: string;
  /** For Run Workflow steps: the run of the called workflow. */
  childRunId?: string;
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
