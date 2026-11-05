import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '../shared/keys';
import { addOwnTab } from './ownTabs';
import { requireTabId, waitForTabComplete } from './tabs';
import type { RecordedStep } from '../core/recording';

/**
 * Background side of the recorder. One recording at a time, kept in storage so the editor can show
 * it live and turn it into blocks when it stops.
 */

/** The recording kept in `bf:recording`. `status: 'stopped'` tells the editor to turn `steps` into blocks. */
export interface RecordingState {
  workflowId: string;
  tabId: number;
  startUrl: string;
  lastUrl: string;
  steps: RecordedStep[];
  status: 'recording' | 'stopped';
}

const RECORDER_SCRIPT = '/content-scripts/recorder.js';

/** The current recording, if any. */
export async function loadRecording(): Promise<RecordingState | undefined> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.recording);
  return stored[STORAGE_KEYS.recording] as RecordingState | undefined;
}

// Steps arrive quickly (type, change, click): one write at a time.
let queue: Promise<void> = Promise.resolve();
/** Read-modify-write of `bf:recording`, serialised. `change` returning undefined skips the write. */
function update(change: (state: RecordingState) => RecordingState | undefined): Promise<void> {
  queue = queue
    .then(async () => {
      const state = await loadRecording();
      if (!state) return;
      const next = change(state);
      if (next) await browser.storage.local.set({ [STORAGE_KEYS.recording]: next });
    })
    .catch(() => {});
  return queue;
}

/** Injects the recorder content script; it guards itself against running twice in one document. */
async function inject(tabId: number): Promise<void> {
  await browser.scripting.executeScript({ target: { tabId }, files: [RECORDER_SCRIPT] }).catch(() => {
    // Pages the browser protects (chrome://, the web store) cannot be recorded.
  });
}

/** Handles `bf:start-recording`: opens `url` in a new active tab, stores a fresh recording and injects the recorder. */
export async function startRecording(workflowId: string, url: string): Promise<void> {
  const tab = await browser.tabs.create({ url, active: true });
  const tabId = requireTabId(tab);
  await addOwnTab(tabId).catch(() => {});
  await browser.storage.local.set({
    [STORAGE_KEYS.recording]: { workflowId, tabId, startUrl: url, lastUrl: url, steps: [], status: 'recording' } satisfies RecordingState,
  });
  await waitForTabComplete(tabId).catch(() => {});
  await inject(tabId);
}

/** Handles `bf:recorded`: appends the step, but only from the recording tab and while recording. */
export function recordStep(step: RecordedStep, fromTabId: number | undefined): Promise<void> {
  return update((state) => (state.status === 'recording' && state.tabId === fromTabId ? { ...state, steps: [...state.steps, step] } : undefined));
}

/** From tabs.onUpdated: a new address (page load or SPA route) is a step; a finished load needs the recorder again. */
export async function onRecordedTabUpdated(tabId: number, change: { url?: string; status?: string }): Promise<void> {
  const state = await loadRecording();
  if (!state || state.status !== 'recording' || state.tabId !== tabId) return;
  if (change.url && change.url !== state.lastUrl) {
    const url = change.url;
    await update((current) => ({ ...current, lastUrl: url, steps: [...current.steps, { kind: 'navigated', url }] }));
  }
  if (change.status === 'complete') await inject(tabId);
}

/**
 * Handles `bf:stop-recording` (from the editor or the in-page toolbar): marks the recording stopped and
 * removes the recorder from the page. The editor converts and then deletes `bf:recording`.
 */
export async function stopRecording(): Promise<void> {
  const state = await loadRecording();
  if (!state) return;
  await update((current) => ({ ...current, status: 'stopped' }));
  await browser.scripting
    .executeScript({
      target: { tabId: state.tabId },
      func: () => {
        const holder = globalThis as { __blockflowRecorder?: { stop(): void } };
        holder.__blockflowRecorder?.stop();
        holder.__blockflowRecorder = undefined;
      },
    })
    .catch(() => {});
}
