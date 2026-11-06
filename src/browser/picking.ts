import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '../shared/keys';
import { normalizeHttpUrl } from '../core/url';
import { actInTab } from './pageDriver';
import { requireTabId, waitForTabComplete } from './tabs';
import { snapshotDocument } from '../core/page';
import type { FormFieldRow, SnapshotResult } from '../core/page';
import type { PickerMode } from '../dom/picker';
import type { PickedMessage, PickerSyncMessage, SnapshotResultMessage } from '../shared/messages';

/**
 * Background side of the element picker.
 *
 * 1. The editor asks to pick an element, optionally naming the page (the block's own URL, or the URL
 *    of an Open Tab before it).
 * 2. We reuse this editor's picker tab (or open the page, or take the most recently used web tab),
 *    bring it to the front and inject the picker into every frame.
 * 3. The pickers of the tab's frames talk through us (`bf:picker-sync`, relayed to the whole tab).
 * 4. When the user confirms, the picker messages us; we stop the pickers in every frame, forward the
 *    result to the editor and bring the editor tab back to the front.
 */

const PICKER_SCRIPT = '/content-scripts/picker.js';
/** `Record<editorTabId, tabId>` in storage.session: the tab each editor picks in, reused for the next pick. */
const PICKER_TABS_KEY = 'bf:picker-tabs';

/** Stored in `bf:pending-pick` while the picker is open. */
interface PendingPick {
  editorTabId: number | undefined;
  mode?: PickerMode;
  /** The tab the picker runs in. */
  tabId?: number;
}

function isWebUrl(url: string | undefined): boolean {
  return !!url && /^https?:\/\//i.test(url);
}

function sameOrigin(a: string | undefined, b: string): boolean {
  try {
    return !!a && new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function samePage(a: string | undefined, b: string): boolean {
  return !!a && a.split('#')[0] === b.split('#')[0];
}

async function pickerTabs(): Promise<Record<string, number>> {
  return ((await browser.storage.session.get(PICKER_TABS_KEY))[PICKER_TABS_KEY] as Record<string, number> | undefined) ?? {};
}

/** The tab this editor picked in last time, if it still exists and shows a web page. */
async function rememberedTab(editorTabId: number | undefined): Promise<{ id: number; url: string | undefined } | null> {
  if (editorTabId === undefined) return null;
  const tabId = (await pickerTabs())[String(editorTabId)];
  if (tabId === undefined) return null;
  try {
    const tab = await browser.tabs.get(tabId);
    return isWebUrl(tab.url) ? { id: tabId, url: tab.url } : null;
  } catch {
    return null;
  }
}

async function remember(editorTabId: number | undefined, tabId: number): Promise<void> {
  if (editorTabId === undefined) return;
  await browser.storage.session.set({ [PICKER_TABS_KEY]: { ...(await pickerTabs()), [String(editorTabId)]: tabId } });
}

/** The user's most recently used web tab other than the editor (BlockFlow never navigates it). */
async function lastUsedWebTab(editorTabId: number | undefined): Promise<{ id?: number; url?: string } | undefined> {
  const tabs = await browser.tabs.query({});
  const lastAccessed = (tab: unknown) => (tab as { lastAccessed?: number }).lastAccessed ?? 0;
  return tabs
    .filter((tab) => tab.id !== undefined && tab.id !== editorTabId && isWebUrl(tab.url))
    .sort((a, b) => lastAccessed(b) - lastAccessed(a))[0];
}

/**
 * Where to pick. One picker tab per editor is opened and reused: a block's own URL sends it there
 * (unless it already shows that page); an upstream Open Tab's URL only when it shows another site,
 * since the element may be on a later page of the same site. Without a picker tab, an upstream URL
 * first looks for the user's last-used tab on that site, and no URL at all takes the last-used web tab.
 */
async function findTargetTab(editorTabId: number | undefined, url: string | undefined, urlFrom: 'block' | 'upstream'): Promise<number> {
  const normalized = url ? normalizeHttpUrl(url) : null;
  const reuse = await rememberedTab(editorTabId);
  if (normalized) {
    if (reuse) {
      const keep = urlFrom === 'upstream' ? sameOrigin(reuse.url, normalized) : samePage(reuse.url, normalized);
      if (!keep) {
        await browser.tabs.update(reuse.id, { url: normalized });
        await waitForTabComplete(reuse.id);
      }
      return reuse.id;
    }
    if (urlFrom === 'upstream') {
      const last = await lastUsedWebTab(editorTabId);
      if (last && sameOrigin(last.url, normalized)) return requireTabId(last);
    }
    const tab = await browser.tabs.create({ url: normalized, active: true });
    const tabId = requireTabId(tab);
    await remember(editorTabId, tabId);
    await waitForTabComplete(tabId);
    return tabId;
  }
  if (reuse) return reuse.id;
  const best = await lastUsedWebTab(editorTabId);
  if (!best) throw new Error('Open the page you want to pick from in a tab, or type its URL first.');
  return requireTabId(best);
}

async function focusTab(tabId: number): Promise<void> {
  const tab = await browser.tabs.update(tabId, { active: true });
  if (tab?.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
}

async function tellEditor(message: unknown): Promise<void> {
  try {
    await browser.runtime.sendMessage(message);
  } catch {
    // The editor may have been closed; nothing to tell.
  }
}

/** Removes the picker from every frame of the tab (after a pick or a cancel). */
async function stopPickers(tabId: number | undefined): Promise<void> {
  if (tabId === undefined) return;
  await browser.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const holder = window as unknown as { __blockflowPicker?: { stop(): void } };
        holder.__blockflowPicker?.stop();
        holder.__blockflowPicker = undefined;
      },
    })
    .catch(() => {});
}

/**
 * Handles `bf:start-pick`: finds or opens the target tab, focuses it and injects the picker into every
 * frame (top frame first, with the toolbar). Failures are reported to the editor as `bf:pick-error`, never thrown.
 */
export async function startPicking(
  editorTabId: number | undefined,
  url: string | undefined,
  mode: PickerMode = 'action',
  urlFrom: 'block' | 'upstream' = 'block',
): Promise<void> {
  try {
    const targetTabId = await findTargetTab(editorTabId, url, urlFrom);
    // A pick still open somewhere (another tab, or this one) ends first.
    const previous = await takePending();
    if (previous?.tabId !== undefined && previous.tabId !== targetTabId) await stopPickers(previous.tabId);
    await browser.storage.local.set({
      [STORAGE_KEYS.pendingPick]: { editorTabId, mode, tabId: targetTabId } satisfies PendingPick,
    });
    await focusTab(targetTabId);
    await browser.scripting.executeScript({
      target: { tabId: targetTabId, allFrames: true },
      func: (pickMode: PickerMode) => {
        (window as unknown as { __blockflowPickerMode?: PickerMode }).__blockflowPickerMode = pickMode;
      },
      args: [mode],
    });
    await browser.scripting.executeScript({ target: { tabId: targetTabId, allFrames: true }, files: [PICKER_SCRIPT] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await tellEditor({ type: 'bf:pick-error', message: `Could not start the picker: ${message}` });
  }
}

async function takePending(): Promise<PendingPick | undefined> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.pendingPick);
  await browser.storage.local.remove(STORAGE_KEYS.pendingPick);
  return stored[STORAGE_KEYS.pendingPick] as PendingPick | undefined;
}

async function returnToEditor(pending: PendingPick | undefined): Promise<void> {
  if (pending?.editorTabId === undefined) return;
  try {
    await focusTab(pending.editorTabId);
  } catch {
    // Editor tab was closed.
  }
}

/** Handles `bf:picker-sync`: passes one picker's message on to the pickers in every frame of its tab. */
export async function relayPickerSync(message: PickerSyncMessage, tabId: number | undefined): Promise<void> {
  if (tabId === undefined) return;
  await browser.tabs.sendMessage(tabId, message).catch(() => {});
}

/**
 * Handles `bf:picked`: stops the pickers in the tab's other frames; in form mode asks the agent for the
 * form's fields (`detect-form`), then sends `bf:pick-result` (or `bf:pick-error`) to the editor and
 * focuses the editor tab again. A pick inside a frame reports the tab's URL, not the frame's.
 */
export async function finishPicking(message: PickedMessage, sender: { tabId?: number; frameId?: number; tabUrl?: string }): Promise<void> {
  const pending = await takePending();
  const pickedTabId = sender.tabId;
  await stopPickers(pickedTabId);
  let fields: FormFieldRow[] | undefined;
  if (pending?.mode === 'form' && pickedTabId !== undefined) {
    try {
      const result = await actInTab(pickedTabId, { op: 'detect-form', locator: message.selector }, 5_000);
      fields = result.fields as FormFieldRow[];
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await tellEditor({ type: 'bf:pick-error', message: `Could not read the form: ${text}` });
      await returnToEditor(pending);
      return;
    }
  }
  await tellEditor({
    type: 'bf:pick-result',
    selector: message.selector,
    ...(message.candidates ? { candidates: message.candidates } : {}),
    url: sender.frameId && sender.tabUrl ? sender.tabUrl : message.url,
    sample: message.sample,
    ...(fields ? { fields } : {}),
  });
  await returnToEditor(pending);
}

/**
 * Handles `bf:snapshot-page` (the editor's "📸 Snapshot page" button): finds or opens the page the same
 * way as picking (`findTargetTab`, so the next pick reuses the tab), runs the `snapshot` op, brings the
 * editor back to the front (it copies to the clipboard, which needs focus) and sends `bf:snapshot-result`.
 */
export async function snapshotForEditor(editorTabId: number | undefined, url: string | undefined): Promise<void> {
  let reply: SnapshotResultMessage;
  try {
    const tabId = await findTargetTab(editorTabId, url, 'block');
    const result = (await actInTab(tabId, { op: 'snapshot' }, 15_000)) as unknown as SnapshotResult;
    reply = { type: 'bf:snapshot-result', text: snapshotDocument(result), lines: result.lines, truncated: result.truncated };
  } catch (error) {
    reply = { type: 'bf:snapshot-result', error: `Could not snapshot the page: ${error instanceof Error ? error.message : String(error)}` };
  }
  await returnToEditor({ editorTabId });
  await tellEditor(reply);
}

/** Handles `bf:pick-cancelled` (and a picker's own `bf:pick-error`): ends the pick in every frame and focuses the editor tab. Sends the editor nothing. */
export async function cancelPicking(tabId?: number): Promise<void> {
  const pending = await takePending();
  await stopPickers(tabId ?? pending?.tabId);
  await returnToEditor(pending);
}
