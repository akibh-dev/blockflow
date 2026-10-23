import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { loadLogs, loadRuns } from '../../browser/stores';
import type { RunRecord } from '../../core/runs';
import type { PendingPrompt } from '../../browser/prompts';
import { STORAGE_KEYS } from '../../shared/keys';
import type { LogEntry } from '../../core/types';

/** Live view of the run log written by the background worker. */
export function useLogs(): LogEntry[] {
  const [logs, setLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    let alive = true;
    void loadLogs().then((entries) => {
      if (alive) setLogs(entries);
    });
    const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'local') return;
      const change = changes[STORAGE_KEYS.logs];
      if (change) setLogs((change.newValue as LogEntry[] | undefined) ?? []);
    };
    browser.storage.onChanged.addListener(listener);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(listener);
    };
  }, []);

  return logs;
}

/** Live view of run history, written by the background worker step by step. */
export function useRuns(): RunRecord[] {
  const [runs, setRuns] = useState<RunRecord[]>([]);

  useEffect(() => {
    let alive = true;
    void loadRuns().then((stored) => {
      if (alive) setRuns(stored);
    });
    const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'local') return;
      const change = changes[STORAGE_KEYS.runs];
      if (change) setRuns((change.newValue as RunRecord[] | undefined) ?? []);
    };
    browser.storage.onChanged.addListener(listener);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(listener);
    };
  }, []);

  return runs;
}

/** Any storage.local key, kept live. */
export function useStorageValue<T>(key: string, fallback: T): [T, (next: T) => Promise<void>] {
  const [value, setValue] = useState<T>(fallback);

  useEffect(() => {
    let alive = true;
    void browser.storage.local.get(key).then((stored) => {
      if (alive && stored[key] !== undefined) setValue(stored[key] as T);
    });
    const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'local' && changes[key]) setValue((changes[key].newValue as T | undefined) ?? fallback);
    };
    browser.storage.onChanged.addListener(listener);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(listener);
    };
    // `fallback` is a constant per call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const save = async (next: T) => {
    setValue(next);
    await browser.storage.local.set({ [key]: next });
  };
  return [value, save];
}

/** Manual Steps waiting for an answer. */
export function usePrompts(): PendingPrompt[] {
  return useStorageValue<PendingPrompt[]>(STORAGE_KEYS.prompts, [])[0];
}
