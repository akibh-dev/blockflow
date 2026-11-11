import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '../shared/keys';
import { getLimits } from './limits';
import type { RunRecord } from '../core/runs';
import { migrateWorkflows } from '../core/migrate';
import { workflowStatePrefix } from '../core/timerKey';
import type { LogEntry, Workflow } from '../core/types';

// --- workflows -------------------------------------------------------------

/**
 * All saved workflows from `bf:workflows` ([] if missing or not an array), migrated to the current
 * schema version (core/migrate.ts). Storage itself is rewritten once by `migrateStoredWorkflows`.
 */
export async function loadWorkflows(): Promise<Workflow[]> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.workflows);
  const value = stored[STORAGE_KEYS.workflows];
  return Array.isArray(value) ? migrateWorkflows(value as Workflow[]).workflows : [];
}

/** Rewrites `bf:workflows` at the current schema version when any workflow is older. True when it did. */
export async function migrateStoredWorkflows(): Promise<boolean> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.workflows);
  const value = stored[STORAGE_KEYS.workflows];
  if (!Array.isArray(value)) return false;
  const { workflows, changed } = migrateWorkflows(value as Workflow[]);
  if (changed) await saveWorkflows(workflows);
  return changed;
}

/** Replaces `bf:workflows`. The worker reacts through `storage.onChanged`. */
export async function saveWorkflows(workflows: Workflow[]): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.workflows]: workflows });
}

/**
 * Removes a deleted workflow's block state (`bf:state:<workflowId>::…`, see `stateKey`). Its timers
 * are cleared through the scheduler.
 */
export async function clearWorkflowState(workflowId: string): Promise<void> {
  const prefix = STORAGE_KEYS.statePrefix + workflowStatePrefix(workflowId);
  const keys = Object.keys(await browser.storage.local.get(null)).filter((key) => key.startsWith(prefix));
  if (keys.length > 0) await browser.storage.local.remove(keys);
}

// --- logs ------------------------------------------------------------------

/** The run log from `bf:logs`. */
export async function loadLogs(): Promise<LogEntry[]> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.logs);
  const value = stored[STORAGE_KEYS.logs];
  return Array.isArray(value) ? (value as LogEntry[]) : [];
}

// Appends are queued so two log lines written back-to-back do not overwrite each other.
let writeQueue: Promise<void> = Promise.resolve();

/** Appends one log line (serialised, capped at the log limit of Settings → Limits). Never rejects. */
export function appendLog(entry: LogEntry): Promise<void> {
  writeQueue = writeQueue
    .then(async () => {
      const entries = await loadLogs();
      entries.push(entry);
      const { logEntries } = await getLimits();
      await browser.storage.local.set({ [STORAGE_KEYS.logs]: entries.slice(-logEntries) });
    })
    .catch(() => {
      // Logging must never break a workflow.
    });
  return writeQueue;
}

/** Deletes the run log (editor's Clear). */
export async function clearLogs(): Promise<void> {
  await browser.storage.local.remove(STORAGE_KEYS.logs);
}

// --- runs ------------------------------------------------------------------

/** Run history from `bf:runs`. */
export async function loadRuns(): Promise<RunRecord[]> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.runs);
  const value = stored[STORAGE_KEYS.runs];
  return Array.isArray(value) ? (value as RunRecord[]) : [];
}

// All run writes go through one queue, so a run update can never overwrite another.
let runQueue: Promise<void> = Promise.resolve();
const pendingRuns = new Map<string, RunRecord>();
let flushQueued = false;

/** Applies `change` to the stored run list, after every earlier write. */
export function updateRuns(change: (runs: RunRecord[]) => RunRecord[]): Promise<void> {
  runQueue = runQueue
    .then(async () => {
      const runs = change(await loadRuns());
      const { runHistory } = await getLimits();
      await browser.storage.local.set({ [STORAGE_KEYS.runs]: runs.slice(-runHistory) });
    })
    .catch(() => {
      // Run history must never break a workflow.
    });
  return runQueue;
}

/**
 * Saves the latest copy of a run. A run reports every step, so updates that arrive while a
 * write is in progress are merged into one write instead of queueing one write each.
 */
export function saveRun(run: RunRecord): void {
  pendingRuns.set(run.id, run);
  if (flushQueued) return;
  flushQueued = true;
  void updateRuns((runs) => {
    flushQueued = false;
    const next = [...runs];
    for (const update of pendingRuns.values()) {
      const index = next.findIndex((candidate) => candidate.id === update.id);
      if (index >= 0) next[index] = update;
      else next.push(update);
    }
    pendingRuns.clear();
    return next;
  });
}

/** Deletes finished runs; runs still marked running are kept. */
export async function clearRuns(): Promise<void> {
  await updateRuns((runs) => runs.filter((run) => run.status === 'running'));
}
