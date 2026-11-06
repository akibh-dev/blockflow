import { browser } from 'wxt/browser';
import { urlMatches } from '../core/urlPattern';
import { sleep } from './tabs';
import { CodedError } from '../core/errors';
import type { WaitUntil } from '../core/page';

/** Waiting for pages: load, network idle, URL changes (including single-page-app route changes). */

/** What blocks need to know about a tab. `url` falls back to `pendingUrl` while a navigation starts. */
export interface TabInfo {
  url: string;
  title: string;
  loading: boolean;
}

/** The tab's URL, title and loading state, or null when the tab no longer exists. */
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
        throw new CodedError('timeout', `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the network to be idle (${inFlight.size} requests still loading)`);
      }
      if ((await tabInfo(tabId)) === null) throw new CodedError('tab.closed', 'The tab was closed');
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
    if (!last) throw new CodedError('tab.closed', 'The tab was closed');
    if (!last.loading) return;
    if (Date.now() >= deadline) throw new CodedError('navigation.failed', `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${last.url || 'the page'} to load`, { url: last.url });
    await sleep(100);
  }
}

/**
 * Waits for `until`: 'none' returns at once, 'load' polls until the tab is not loading, 'networkidle'
 * additionally waits for 500 ms without requests (in the time left of `timeoutMs`, at least 1 s).
 */
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
    if (!info) throw new CodedError('tab.closed', 'The tab was closed');
    last = info.url;
    if (urlMatches(info.url, pattern)) return info.url;
    if (Date.now() >= deadline) throw new CodedError('timeout', `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the URL to match ${pattern} (it is ${last})`, { url: last });
    await sleep(150);
  }
}

// --- network log for Wait For "response" -----------------------------------------------------
//
// Listening to every request of every tab would wake the background worker for all browsing, so
// only tabs a run uses are watched: from Open Tab on, or from the first wait. In memory: a run
// keeps the worker awake anyway.

interface Response {
  url: string;
  status: number;
  method: string;
  at: number;
  used: boolean;
}

const logs = new Map<number, Response[]>();

/**
 * Starts a per-tab response log (last 300 entries, in memory) for Wait For "response". Idempotent; the
 * listeners are removed when the tab closes. Lost if the worker restarts.
 */
export function watchNetwork(tabId: number): void {
  if (logs.has(tabId)) return;
  const entries: Response[] = [];
  logs.set(tabId, entries);
  const filter = { urls: ['<all_urls>'], tabId };
  const done = (details: { url: string; statusCode?: number; method: string; tabId: number }): undefined => {
    if (details.tabId !== tabId) return undefined;
    entries.push({ url: details.url, status: details.statusCode ?? 0, method: details.method, at: Date.now(), used: false });
    if (entries.length > 300) entries.splice(0, entries.length - 300);
    return undefined;
  };
  browser.webRequest.onCompleted.addListener(done, filter);
  browser.webRequest.onErrorOccurred.addListener(done, filter);
  const closed = (closedId: number) => {
    if (closedId !== tabId) return;
    browser.webRequest.onCompleted.removeListener(done);
    browser.webRequest.onErrorOccurred.removeListener(done);
    browser.tabs.onRemoved.removeListener(closed);
    logs.delete(tabId);
  };
  browser.tabs.onRemoved.addListener(closed);
}

/** "200", "2xx", "200,201", or "" for any. */
export function statusMatches(status: number, wanted: string): boolean {
  const options = wanted.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (options.length === 0) return true;
  return options.some((option) => (/^\dxx$/.test(option) ? Math.floor(status / 100) === Number(option[0]) : Number(option) === status));
}

/**
 * Resolves with the first unused logged response of this tab whose URL matches `pattern` and whose status
 * matches `status`, looking back `lookBackMs` before the call. A response is consumed once matched.
 */
export async function waitForResponse(
  tabId: number,
  pattern: string,
  status: string,
  lookBackMs: number,
  timeoutMs: number,
): Promise<{ url: string; status: number; method: string }> {
  watchNetwork(tabId);
  const since = Date.now() - lookBackMs;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = logs.get(tabId) ?? [];
    const found = entries.find((entry) => !entry.used && entry.at >= since && urlMatches(entry.url, pattern) && statusMatches(entry.status, status));
    if (found) {
      found.used = true;
      return { url: found.url, status: found.status, method: found.method };
    }
    if ((await tabInfo(tabId)) === null) throw new CodedError('tab.closed', 'The tab was closed');
    if (Date.now() >= deadline) {
      const seen = entries.filter((entry) => urlMatches(entry.url, pattern)).map((entry) => entry.status);
      throw new CodedError('timeout', `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for a response from ${pattern}${status ? ` with status ${status}` : ''}${seen.length ? ` (saw status ${[...new Set(seen)].join(', ')})` : ''}`);
    }
    await sleep(150);
  }
}
