import { browser } from 'wxt/browser';
import { MAX_LOG_ENTRIES, STORAGE_KEYS } from '../shared/keys';
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
