import { browser } from 'wxt/browser';
import { urlMatches } from '../core/urlPattern';
import { sleep } from './tabs';
import { CodedError } from '../core/errors';
import { hasDebugger, withDebugger } from './cdp';
import type { WaitUntil } from '../core/page';
import type { RequestInfo, ResponseInfo } from '../core/types';

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

/** A request a watched tab sent (Wait For "request"). */
interface Request {
  url: string;
  method: string;
  type: string;
  postData?: string;
  at: number;
  used: boolean;
}

const logs = new Map<number, Response[]>();
const requestLogs = new Map<number, Request[]>();

/** Request and response bodies are kept up to this many characters. */
const MAX_BODY_CHARS = 200_000;

/** `webRequest`'s request body as text: raw bytes as UTF-8, form fields URL-encoded. */
function postDataOf(body: { raw?: { bytes?: ArrayBuffer }[]; formData?: Record<string, string[]> } | null | undefined): string | undefined {
  if (!body) return undefined;
  if (body.formData) {
    const form = new URLSearchParams();
    for (const [key, values] of Object.entries(body.formData)) for (const value of values) form.append(key, value);
    return form.toString().slice(0, MAX_BODY_CHARS);
  }
  const parts = (body.raw ?? []).map((part) => part.bytes).filter((bytes): bytes is ArrayBuffer => bytes instanceof ArrayBuffer);
  if (parts.length === 0) return undefined;
  const decoder = new TextDecoder();
  return parts.map((bytes) => decoder.decode(bytes)).join('').slice(0, MAX_BODY_CHARS);
}

/**
 * Starts a per-tab response log (last 300 entries, in memory) for Wait For "response". Idempotent; the
 * listeners are removed when the tab closes. Lost if the worker restarts.
 */
export function watchNetwork(tabId: number): void {
  if (logs.has(tabId)) return;
  const entries: Response[] = [];
  logs.set(tabId, entries);
  const requests: Request[] = [];
  requestLogs.set(tabId, requests);
  const filter = { urls: ['<all_urls>'], tabId };
  const sent = (details: { url: string; method: string; type: string; tabId: number; requestBody?: unknown }): undefined => {
    if (details.tabId !== tabId) return undefined;
    const postData = postDataOf(details.requestBody as Parameters<typeof postDataOf>[0]);
    requests.push({ url: details.url, method: details.method, type: details.type, ...(postData !== undefined ? { postData } : {}), at: Date.now(), used: false });
    if (requests.length > 300) requests.splice(0, requests.length - 300);
    return undefined;
  };
  browser.webRequest.onBeforeRequest.addListener(sent, filter, ['requestBody']);
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
    browser.webRequest.onBeforeRequest.removeListener(sent);
    browser.tabs.onRemoved.removeListener(closed);
    logs.delete(tabId);
    requestLogs.delete(tabId);
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
  options: { method?: string; captureBody?: boolean } = {},
): Promise<ResponseInfo> {
  watchNetwork(tabId);
  if (options.captureBody) return waitForResponseBody(tabId, pattern, status, options.method ?? '', timeoutMs);
  const since = Date.now() - lookBackMs;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = logs.get(tabId) ?? [];
    const found = entries.find(
      (entry) => !entry.used && entry.at >= since && urlMatches(entry.url, pattern) && statusMatches(entry.status, status) && methodMatches(entry.method, options.method ?? ''),
    );
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

/** "POST", "get,post", or "" for any (case does not matter). */
export function methodMatches(method: string, wanted: string): boolean {
  const options = wanted.split(',').map((part) => part.trim().toUpperCase()).filter(Boolean);
  return options.length === 0 || options.includes(method.toUpperCase());
}

/**
 * `Host.tabs.waitForRequest`: the first unused logged request of this tab (from Open Tab on, or from the
 * first wait) whose URL matches `pattern` and method `method`, looking back `lookBackMs`. Consumed once matched.
 */
export async function waitForRequest(tabId: number, pattern: string, method: string, lookBackMs: number, timeoutMs: number): Promise<RequestInfo> {
  watchNetwork(tabId);
  const since = Date.now() - lookBackMs;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = requestLogs.get(tabId) ?? [];
    const found = entries.find((entry) => !entry.used && entry.at >= since && urlMatches(entry.url, pattern) && methodMatches(entry.method, method));
    if (found) {
      found.used = true;
      return { url: found.url, method: found.method, type: found.type, ...(found.postData !== undefined ? { postData: found.postData } : {}) };
    }
    if ((await tabInfo(tabId)) === null) throw new CodedError('tab.closed', 'The tab was closed');
    if (Date.now() >= deadline) {
      const seen = entries.filter((entry) => urlMatches(entry.url, pattern)).map((entry) => entry.method);
      throw new CodedError('timeout', `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for a request to ${pattern}${method ? ` (${method})` : ''}${seen.length ? ` (saw ${[...new Set(seen)].join(', ')})` : ''}`);
    }
    await sleep(150);
  }
}

/**
 * Wait For "response" with `captureBody` (Chromium, debugger permission): attaches the debugger with the
 * Network domain on and waits for the next matching response that finishes loading, then reads its body
 * (`Network.getResponseBody`). Only responses that start after this call can be read: the browser keeps
 * bodies only for requests it saw with the debugger attached.
 */
async function waitForResponseBody(tabId: number, pattern: string, status: string, method: string, timeoutMs: number): Promise<ResponseInfo> {
  if (!browser.debugger || !(await hasDebugger())) {
    throw new CodedError(
      'permission.missing',
      'Reading a response body needs the "debugger" permission, which only Chrome, Edge and Brave have: press Grant on the Wait For block. Without it, switch "Capture the body" off (the response\'s URL, status and method still work).',
    );
  }
  return withDebugger(tabId, async (send) => {
    const methods = new Map<string, string>();
    const candidates = new Map<string, ResponseInfo>();
    const finished: string[] = [];
    const listener = (source: { tabId?: number }, event: string, params?: object) => {
      if (source.tabId !== tabId || !params) return;
      const p = params as { requestId: string; request?: { method: string }; response?: { url: string; status: number } };
      if (event === 'Network.requestWillBeSent' && p.request) methods.set(p.requestId, p.request.method);
      else if (event === 'Network.responseReceived' && p.response) {
        const requestMethod = methods.get(p.requestId) ?? 'GET';
        if (urlMatches(p.response.url, pattern) && statusMatches(p.response.status, status) && methodMatches(requestMethod, method)) {
          candidates.set(p.requestId, { url: p.response.url, status: p.response.status, method: requestMethod });
        }
      } else if (event === 'Network.loadingFinished' && candidates.has(p.requestId)) finished.push(p.requestId);
      else if (event === 'Network.loadingFailed') candidates.delete(p.requestId);
    };
    browser.debugger.onEvent.addListener(listener);
    try {
      await send('Network.enable', {});
      const deadline = Date.now() + timeoutMs;
      while (finished.length === 0) {
        if ((await tabInfo(tabId)) === null) throw new CodedError('tab.closed', 'The tab was closed');
        if (Date.now() >= deadline) {
          throw new CodedError(
            'timeout',
            `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for a response from ${pattern}${status ? ` with status ${status}` : ''} to read its body (only responses that start after the Wait For starts can be read)`,
          );
        }
        await sleep(100);
      }
      const requestId = finished[0] as string;
      const response = candidates.get(requestId) as ResponseInfo;
      const body = (await send('Network.getResponseBody', { requestId })) as { body: string; base64Encoded: boolean };
      return body.base64Encoded ? { ...response, bodyBase64: body.body.slice(0, MAX_BODY_CHARS) } : { ...response, body: body.body.slice(0, MAX_BODY_CHARS) };
    } finally {
      browser.debugger.onEvent.removeListener(listener);
    }
  });
}
