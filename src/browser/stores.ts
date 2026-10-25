import { browser } from 'wxt/browser';
import { MAX_LOG_ENTRIES, MAX_RUNS, STORAGE_KEYS } from '../shared/keys';
import type { RunRecord } from '../core/runs';
import type { LogEntry, Workflow } from '../core/types';

// --- workflows -------------------------------------------------------------

export async function loadWorkflows(): Promise<Workflow[]> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.workflows);
  const value = stored[STORAGE_KEYS.workflows];
  return Array.isArray(value) ? (value as Workflow[]) : [];
}

export async function saveWorkflows(workflows: Workflow[]): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.workflows]: workflows });
}

// --- logs ------------------------------------------------------------------

export async function loadLogs(): Promise<LogEntry[]> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.logs);
  const value = stored[STORAGE_KEYS.logs];
  return Array.isArray(value) ? (value as LogEntry[]) : [];
}

// Appends are queued so two log lines written back-to-back do not overwrite each other.
let writeQueue: Promise<void> = Promise.resolve();

export function appendLog(entry: LogEntry): Promise<void> {
  writeQueue = writeQueue
    .then(async () => {
      const entries = await loadLogs();
      entries.push(entry);
      await browser.storage.local.set({ [STORAGE_KEYS.logs]: entries.slice(-MAX_LOG_ENTRIES) });
    })
    .catch(() => {
      // Logging must never break a workflow.
    });
  return writeQueue;
}

export async function clearLogs(): Promise<void> {
  await browser.storage.local.remove(STORAGE_KEYS.logs);
}

// --- runs ------------------------------------------------------------------

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
      await browser.storage.local.set({ [STORAGE_KEYS.runs]: runs.slice(-MAX_RUNS) });
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

export async function clearRuns(): Promise<void> {
  await updateRuns((runs) => runs.filter((run) => run.status === 'running'));
}
