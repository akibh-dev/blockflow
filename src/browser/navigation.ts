import { browser } from 'wxt/browser';
import { urlMatches } from '../core/urlPattern';
import { sleep } from './tabs';
import type { WaitUntil } from '../core/page';

/** Waiting for pages: load, network idle, URL changes (including single-page-app route changes). */

export interface TabInfo {
  url: string;
  title: string;
  loading: boolean;
}

export async function tabInfo(tabId: number): Promise<TabInfo | null> {
  try {
    const tab = await browser.tabs.get(tabId);
    return { url: tab.url ?? tab.pendingUrl ?? '', title: tab.title ?? '', loading: tab.status === 'loading' };
  } catch {
    return null;
  }
}

/**
 * Resolves when no request of this tab has been in flight for `idleMs`. Requests that started
 * before this call are not seen, so call it right after the load, as Open Tab and Wait For do.
 */
export async function waitForNetworkIdle(tabId: number, idleMs: number, timeoutMs: number): Promise<void> {
  const inFlight = new Set<string>();
  let lastActivity = Date.now();
  // Observing only: the listeners return nothing (MV3 does not allow blocking here anyway).
  const started = (details: { tabId: number; requestId: string }): undefined => {
    if (details.tabId !== tabId) return undefined;
    inFlight.add(details.requestId);
    lastActivity = Date.now();
    return undefined;
  };
  const ended = (details: { tabId: number; requestId: string }): undefined => {
    if (details.tabId !== tabId) return undefined;
    inFlight.delete(details.requestId);
    lastActivity = Date.now();
    return undefined;
  };
  const filter = { urls: ['<all_urls>'], tabId };
  browser.webRequest.onBeforeRequest.addListener(started, filter);
  browser.webRequest.onCompleted.addListener(ended, filter);
  browser.webRequest.onErrorOccurred.addListener(ended, filter);
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      if (inFlight.size === 0 && Date.now() - lastActivity >= idleMs) return;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the network to be idle (${inFlight.size} requests still loading)`);
      }
      if ((await tabInfo(tabId)) === null) throw new Error('The tab was closed');
      await sleep(100);
    }
  } finally {
    browser.webRequest.onBeforeRequest.removeListener(started);
    browser.webRequest.onCompleted.removeListener(ended);
    browser.webRequest.onErrorOccurred.removeListener(ended);
  }
}

/**
 * Polls instead of listening for tabs.onUpdated, so a "complete" event that fired before we
 * started listening cannot be missed, and each poll keeps the background worker awake.
 */
async function waitForComplete(tabId: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: TabInfo | null = null;
  for (;;) {
    last = await tabInfo(tabId);
    if (!last) throw new Error('The tab was closed');
    if (!last.loading) return;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${last.url || 'the page'} to load`);
    await sleep(100);
  }
}

export async function waitForLoad(tabId: number, until: WaitUntil, timeoutMs: number): Promise<void> {
  if (until === 'none') return;
  const started = Date.now();
  await waitForComplete(tabId, timeoutMs);
  if (until === 'networkidle') await waitForNetworkIdle(tabId, 500, Math.max(1000, timeoutMs - (Date.now() - started)));
}

/** Polls the tab's URL, which also changes on history.pushState, so SPA route changes count. */
export async function waitForUrl(tabId: number, pattern: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    const info = await tabInfo(tabId);
    if (!info) throw new Error('The tab was closed');
    last = info.url;
    if (urlMatches(info.url, pattern)) return info.url;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the URL to match ${pattern} (it is ${last})`);
    await sleep(150);
  }
}
