import { browser } from 'wxt/browser';

/**
 * Tabs BlockFlow opened itself (Open Tab, watch tabs). Page Visited ignores them, so a workflow
 * that opens a page matching its own trigger cannot start itself forever. Kept in session storage:
 * tab ids mean nothing after the browser restarts.
 */
const KEY = 'bf:own-tabs';
const MAX = 200;

/** Remembers a tab BlockFlow opened (moved to the end of the list; the oldest drop off after MAX). */
export async function addOwnTab(tabId: number): Promise<void> {
  const stored = await browser.storage.session.get(KEY);
  const tabs = ((stored[KEY] as number[] | undefined) ?? []).filter((id) => id !== tabId);
  await browser.storage.session.set({ [KEY]: [...tabs, tabId].slice(-MAX) });
}

/** True if BlockFlow opened this tab in this browser session (Page Visited skips it). */
export async function isOwnTab(tabId: number): Promise<boolean> {
  const stored = await browser.storage.session.get(KEY);
  return ((stored[KEY] as number[] | undefined) ?? []).includes(tabId);
}
