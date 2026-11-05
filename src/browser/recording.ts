import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '../shared/keys';
import { addOwnTab } from './ownTabs';
import { requireTabId, sleep, waitForTabComplete } from './tabs';
import type { RecordedStep } from '../core/recording';
import type { RecorderSyncMessage } from '../shared/messages';

/**
 * Background side of the recorder. One recording at a time, kept in storage so the editor can show
 * it live and turn it into blocks when it stops. The recorder runs in every frame of the recording
 * tab, and follows the tabs the page opens (popups): their steps are marked `tab: 'popup'`.
 */

/** A tab the recorded page opened, and the last address recorded for it. */
interface RecordedPopup {
  tabId: number;
  lastUrl: string;
}

/** The recording kept in `bf:recording`. `status: 'stopped'` tells the editor to turn `steps` into blocks. */
export interface RecordingState {
  workflowId: string;
  tabId: number;
  startUrl: string;
  lastUrl: string;
  steps: RecordedStep[];
  status: 'recording' | 'stopped';
  /** Tabs opened by the recording tab (or by one of these) while recording. */
  popups?: RecordedPopup[];
}

const RECORDER_SCRIPT = '/content-scripts/recorder.js';
/** A popup is reported after this pause, so the click that opened it (a message from the page) is recorded first. */
const POPUP_SETTLE_MS = 300;

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

/** Injects the recorder content script into every frame; it guards itself against running twice in one document. */
async function inject(tabId: number): Promise<void> {
  await browser.scripting.executeScript({ target: { tabId, allFrames: true }, files: [RECORDER_SCRIPT] }).catch(() => {
    // Pages the browser protects (chrome://, the web store) cannot be recorded.
  });
}

/** `''` for the recording tab, `'popup'` for a tab it opened, null for any other tab. */
function tabLabel(state: RecordingState, tabId: number | undefined): '' | 'popup' | null {
  if (tabId === undefined) return null;
  if (tabId === state.tabId) return '';
  return state.popups?.some((popup) => popup.tabId === tabId) ? 'popup' : null;
}

/** Handles `bf:start-recording`: opens `url` in a new active tab, stores a fresh recording and injects the recorder. */
export async function startRecording(workflowId: string, url: string): Promise<void> {
  const tab = await browser.tabs.create({ url, active: true });
  const tabId = requireTabId(tab);
  await addOwnTab(tabId).catch(() => {});
  await browser.storage.local.set({
    [STORAGE_KEYS.recording]: { workflowId, tabId, startUrl: url, lastUrl: url, steps: [], status: 'recording', popups: [] } satisfies RecordingState,
  });
  await waitForTabComplete(tabId).catch(() => {});
  await inject(tabId);
}

/** Handles `bf:recorded`: appends the step, but only from the recording tab (any frame) or its popups, and while recording. */
export function recordStep(step: RecordedStep, fromTabId: number | undefined): Promise<void> {
  return update((state) => {
    const label = tabLabel(state, fromTabId);
    if (state.status !== 'recording' || label === null) return undefined;
    return { ...state, steps: [...state.steps, label ? { ...step, tab: label } : step] };
  });
}

/**
 * From `webNavigation.onCreatedNavigationTarget`: a tab opened by the recording tab (or one of its
 * popups) is recorded as a `popup` step and followed: the recorder is injected when it has loaded.
 */
export async function onRecordedPopup(tabId: number, openerTabId: number, url: string): Promise<void> {
  const state = await loadRecording();
  if (!state || state.status !== 'recording') return;
  const opener = tabLabel(state, openerTabId);
  if (opener === null) return;
  await addOwnTab(tabId).catch(() => {});
  await sleep(POPUP_SETTLE_MS);
  await update((current) => ({
    ...current,
    popups: [...(current.popups ?? []), { tabId, lastUrl: url }],
    steps: [...current.steps, { kind: 'popup', url, ...(opener ? { tab: opener } : {}) }],
  }));
  // It may have finished loading during the pause (onUpdated came before it was known).
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  if (tab?.status === 'complete') await inject(tabId);
}

/** From tabs.onUpdated: a new address (page load or SPA route) is a step; a finished load needs the recorder again. */
export async function onRecordedTabUpdated(tabId: number, change: { url?: string; status?: string }): Promise<void> {
  const state = await loadRecording();
  if (!state || state.status !== 'recording') return;
  const label = tabLabel(state, tabId);
  if (label === null) return;
  const url = change.url;
  if (url) {
    await update((current) => {
      if (label === '') {
        if (url === current.lastUrl) return undefined;
        return { ...current, lastUrl: url, steps: [...current.steps, { kind: 'navigated', url }] };
      }
      const popup = current.popups?.find((candidate) => candidate.tabId === tabId);
      if (!popup || url === popup.lastUrl || url === 'about:blank') return undefined;
      return {
        ...current,
        popups: current.popups?.map((candidate) => (candidate === popup ? { ...popup, lastUrl: url } : candidate)),
        steps: [...current.steps, { kind: 'navigated', url, tab: 'popup' }],
      };
    });
  }
  if (change.status === 'complete') await inject(tabId);
}

/** Handles `bf:recorder-sync`: the toolbar's mode, passed on to the recorders in every frame of that tab. */
export async function relayRecorderSync(message: RecorderSyncMessage, tabId: number | undefined): Promise<void> {
  if (tabId === undefined) return;
  await browser.tabs.sendMessage(tabId, message).catch(() => {});
}

/**
 * Handles `bf:stop-recording` (from the editor or the in-page toolbar): marks the recording stopped and
 * removes the recorder from every frame of the recording tab and its popups. The editor converts and
 * then deletes `bf:recording`.
 */
export async function stopRecording(): Promise<void> {
  const state = await loadRecording();
  if (!state) return;
  await update((current) => ({ ...current, status: 'stopped' }));
  for (const tabId of [state.tabId, ...(state.popups ?? []).map((popup) => popup.tabId)]) {
    await browser.scripting
      .executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          const holder = globalThis as { __blockflowRecorder?: { stop(): void } };
          holder.__blockflowRecorder?.stop();
          holder.__blockflowRecorder = undefined;
        },
      })
      .catch(() => {});
  }
}
