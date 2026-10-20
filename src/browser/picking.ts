import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '../shared/keys';
import { normalizeHttpUrl } from '../core/url';
import { requireTabId, waitForTabComplete } from './tabs';
import type { PickedMessage } from '../shared/messages';

/**
 * Background side of the element picker.
 *
 * 1. The editor asks to pick an element, optionally naming the page.
 * 2. We open that page (or take the most recently used web tab), bring it to the front and
 *    inject the picker.
 * 3. When the user confirms, the picker messages us; we forward the result to the editor and
 *    bring the editor tab back to the front.
 */

const PICKER_SCRIPT = '/content-scripts/picker.js';

interface PendingPick {
  editorTabId: number | undefined;
}

function isWebUrl(url: string | undefined): boolean {
  return !!url && /^https?:\/\//i.test(url);
}

async function findTargetTab(editorTabId: number | undefined, url: string | undefined): Promise<number> {
  const normalized = url ? normalizeHttpUrl(url) : null;
  if (normalized) {
    const tab = await browser.tabs.create({ url: normalized, active: true });
    const tabId = requireTabId(tab);
    await waitForTabComplete(tabId);
    return tabId;
  }

  const tabs = await browser.tabs.query({});
  const lastAccessed = (tab: unknown) => (tab as { lastAccessed?: number }).lastAccessed ?? 0;
  const candidates = tabs
    .filter((tab) => tab.id !== undefined && tab.id !== editorTabId && isWebUrl(tab.url))
    .sort((a, b) => lastAccessed(b) - lastAccessed(a));
  const best = candidates[0];
  if (!best) {
    throw new Error('Open the page you want to watch in a tab, or type its URL first.');
  }
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

export async function startPicking(editorTabId: number | undefined, url: string | undefined): Promise<void> {
  try {
    const targetTabId = await findTargetTab(editorTabId, url);
    await browser.storage.local.set({
      [STORAGE_KEYS.pendingPick]: { editorTabId } satisfies PendingPick,
    });
    await focusTab(targetTabId);
    await browser.scripting.executeScript({ target: { tabId: targetTabId }, files: [PICKER_SCRIPT] });
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

export async function finishPicking(message: PickedMessage): Promise<void> {
  const pending = await takePending();
  await tellEditor({
    type: 'bf:pick-result',
    selector: message.selector,
    url: message.url,
    sample: message.sample,
  });
  await returnToEditor(pending);
}

export async function cancelPicking(): Promise<void> {
  await returnToEditor(await takePending());
}
