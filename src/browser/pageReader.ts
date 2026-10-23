import { browser } from 'wxt/browser';
import { actInTab } from './pageDriver';
import { STORAGE_KEYS } from '../shared/keys';
import { reloadAndWait, requireTabId, tabExists, waitForTabComplete } from './tabs';
import type { ReadElementOptions, ReadElementResult } from '../core/types';

/** How long to keep retrying for an element that has not rendered yet (single-page apps). */
const ELEMENT_WAIT_MS = 6_000;

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

/**
 * Reads through the page agent, so any locator works (text=, role=…), not just CSS. Waits up to
 * ELEMENT_WAIT_MS for the element, since single-page apps render after "load".
 */
export async function readElement(options: ReadElementOptions): Promise<ReadElementResult> {
  const tabId = await ensureWatchTab(options.url, options.reload);
  try {
    const result = await actInTab(
      tabId,
      { op: 'read', locator: options.selector, kind: options.read?.kind ?? 'text', ...(options.read?.name ? { name: options.read.name } : {}) },
      ELEMENT_WAIT_MS,
    );
    return { found: true, text: String(result.text ?? ''), count: Number(result.count ?? 0) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Timed out')) return { found: false, text: '' };
    return { found: false, text: '', error: message };
  }
}
