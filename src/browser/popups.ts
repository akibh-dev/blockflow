import { browser } from 'wxt/browser';
import { sleep } from './tabs';

/**
 * Tabs opened by other tabs (window.open, target=_blank), remembered for Wait for Popup. The
 * background records them from webNavigation.onCreatedNavigationTarget (see background.ts for why not
 * tabs.onCreated); popups can open before the block starts waiting. Kept in storage.session.
 */
const KEY = 'bf:popups';

/** One tab opened by another tab, kept for two minutes (the last 50). */
interface PopupRecord {
  tabId: number;
  openerTabId: number;
  at: number;
}

async function list(): Promise<PopupRecord[]> {
  return ((await browser.storage.session.get(KEY))[KEY] as PopupRecord[] | undefined) ?? [];
}

/** Called by the background for every `webNavigation.onCreatedNavigationTarget`. */
export async function recordPopup(tabId: number, openerTabId: number): Promise<void> {
  // Both listeners may report the same tab.
  const records = (await list()).filter((record) => Date.now() - record.at < 120_000 && record.tabId !== tabId);
  await browser.storage.session.set({ [KEY]: [...records, { tabId, openerTabId, at: Date.now() }].slice(-50) });
}

/**
 * `Host.tabs.waitForPopup`: the id of a tab opened by `openerTabId` since `lookBackMs` ago, polling
 * every 200 ms. Claims the record, so each popup is returned once.
 */
export async function waitForPopup(openerTabId: number, lookBackMs: number, timeoutMs: number): Promise<number> {
  const since = Date.now() - lookBackMs;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const records = await list();
    const found = records.find((record) => record.openerTabId === openerTabId && record.at >= since);
    if (found) {
      // Claimed: a second Wait for Popup waits for the next one.
      await browser.storage.session.set({ [KEY]: records.filter((record) => record !== found && record.tabId !== found.tabId) });
      return found.tabId;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s: no new tab was opened by this page`);
    await sleep(200);
  }
}
