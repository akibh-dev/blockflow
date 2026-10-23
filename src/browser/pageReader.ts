import { browser } from 'wxt/browser';
import { readSelectorInPage } from '../dom/readElement';
import { STORAGE_KEYS } from '../shared/keys';
import { reloadAndWait, requireTabId, sleep, tabExists, waitForTabComplete } from './tabs';
import type { ReadElementOptions, ReadElementResult } from '../core/types';

/** How long to keep retrying for an element that has not rendered yet (single-page apps). */
const ELEMENT_WAIT_MS = 6_000;
const RETRY_EVERY_MS = 500;

type TabMap = Record<string, number>;

async function loadTabMap(): Promise<TabMap> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.watchTabs);
  return (stored[STORAGE_KEYS.watchTabs] as TabMap | undefined) ?? {};
}

async function saveTabMap(map: TabMap): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.watchTabs]: map });
}

/**
 * Finds or creates the background tab used to watch `url`.
 * BlockFlow only reuses tabs it opened itself, so it never reloads a page you are working in.
 */
async function ensureWatchTab(url: string, reload: boolean): Promise<number> {
  const map = await loadTabMap();
  const known = map[url];
  if (known !== undefined && (await tabExists(known))) {
    if (reload) await reloadAndWait(known);
    else await waitForTabComplete(known);
    return known;
  }

  const tab = await browser.tabs.create({ url, active: false });
  const tabId = requireTabId(tab);
  await saveTabMap({ ...map, [url]: tabId });
  await waitForTabComplete(tabId);
  return tabId;
}

async function readOnce(tabId: number, options: ReadElementOptions): Promise<ReadElementResult> {
  const [injection] = await browser.scripting.executeScript({
    target: { tabId },
    func: readSelectorInPage,
    args: [options.selector, options.read?.kind ?? 'text', options.read?.name ?? ''],
  });
  return (injection?.result as ReadElementResult | undefined) ?? { found: false, text: '' };
}

export async function readElement(options: ReadElementOptions): Promise<ReadElementResult> {
  const tabId = await ensureWatchTab(options.url, options.reload);
  const deadline = Date.now() + ELEMENT_WAIT_MS;
  for (;;) {
    const result = await readOnce(tabId, options);
    if (result.found || result.error || Date.now() >= deadline) return result;
    await sleep(RETRY_EVERY_MS);
  }
}
