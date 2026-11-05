/**
 * React hooks that mirror `browser.storage.local` keys into component state. Each hook loads the key
 * once, then follows `storage.onChanged`, so whatever the background worker writes (logs, runs,
 * prompts, recording) shows up without polling. Workflows are not read through these hooks: the
 * editor owns `bf:workflows` and loads it once (see `Editor.tsx`).
 */
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { loadLogs, loadRuns } from '../../browser/stores';
import type { RunRecord } from '../../core/runs';
import type { PendingPrompt } from '../../browser/prompts';
import { STORAGE_KEYS } from '../../shared/keys';
import type { LogEntry } from '../../core/types';

/** Live view of the run log (`bf:logs`) written by the background worker, oldest first. */
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

/** Live view of run history (`bf:runs`, newest last), written by the background worker step by step. */
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

/**
 * Any storage.local key, kept live, like `useState` backed by storage.
 *
 * Returns `[value, save]`. `save` updates local state at once, then writes the key; the write echoes
 * back through `onChanged` (harmless). A removed key falls back to `fallback`. `fallback` must be
 * stable per call site (it is not an effect dependency).
 */
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

/** Manual Steps waiting for an answer (`bf:prompts`, written by the background's prompt host). */
export function usePrompts(): PendingPrompt[] {
  return useStorageValue<PendingPrompt[]>(STORAGE_KEYS.prompts, [])[0];
}
