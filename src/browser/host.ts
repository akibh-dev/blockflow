import { browser } from 'wxt/browser';
import { uid } from '../core/id';
import { STORAGE_KEYS } from '../shared/keys';
import { readDataset, saveScreenshot, writeDataset } from './blobStore';
import { actOnHtml } from './htmlParse';
import { tabInfo, waitForLoad, waitForResponse, waitForUrl, watchNetwork } from './navigation';
import { addOwnTab } from './ownTabs';
import { askUser } from './prompts';
import { loadWorkflows } from './stores';
import { act } from './pageDriver';
import { captureWithDebugger } from './cdp';
import { waitForPopup } from './popups';
import { readElement } from './pageReader';
import { requireTabId, sleep } from './tabs';
import type { Host, HttpRequestOptions, HttpResult, NavigateOptions, NotifyOptions, OpenTabOptions, TabInfo, Scheduler, StateStore } from '../core/types';

/** `Host.state`: block state in `storage.local` under `bf:state:<key>`. Removed when its workflow is deleted (background). */
class StorageState implements StateStore {
  async get(key: string): Promise<unknown> {
    const storageKey = STORAGE_KEYS.statePrefix + key;
    const stored = await browser.storage.local.get(storageKey);
    return stored[storageKey];
  }

  async set(key: string, value: unknown): Promise<void> {
    await browser.storage.local.set({ [STORAGE_KEYS.statePrefix + key]: value });
  }
}

/**
 * `Host.tabs.open`: reuses `reuseTabId` if it still exists, else navigates the active tab (`newTab: false`),
 * else opens a tab or window. Marks the tab as BlockFlow's own and starts its response log.
 */
async function openTab({ url, newTab, active, reuseTabId, newWindow, waitUntil = 'none', timeoutMs = 30_000 }: OpenTabOptions): Promise<{ tabId: number }> {
  let tabId: number | undefined;
  if (reuseTabId !== undefined && (await tabInfo(reuseTabId))) {
    await browser.tabs.update(reuseTabId, { url, ...(active ? { active: true } : {}) });
    tabId = reuseTabId;
  } else if (!newTab) {
    const [current] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (current?.id !== undefined) {
      await browser.tabs.update(current.id, { url });
      tabId = current.id;
    }
  }
  if (tabId === undefined) {
    if (newWindow) {
      const window = await browser.windows.create({ url, focused: active });
      tabId = requireTabId(window?.tabs?.[0] ?? {});
    } else {
      tabId = requireTabId(await browser.tabs.create({ url, active }));
    }
  }
  await addOwnTab(tabId).catch(() => {});
  watchNetwork(tabId);
  // Give the navigation a moment to start, so "complete" is not the previous page's.
  if (waitUntil !== 'none') {
    await sleep(100);
    await waitForLoad(tabId, waitUntil, timeoutMs);
  }
  return { tabId };
}

/**
 * Back/forward. Chromium's `tabs.goBack/goForward` skip history entries added without a user gesture
 * (its back-button intervention), so after Open Tab → Navigate goto they fail with "Cannot find a
 * next page in history". `history.back()/forward()` run in the page are not affected: use them then.
 */
async function goHistory(tabId: number, action: 'back' | 'forward'): Promise<void> {
  try {
    await (action === 'back' ? browser.tabs.goBack(tabId) : browser.tabs.goForward(tabId));
  } catch {
    await browser.scripting.executeScript({
      target: { tabId },
      func: (back: boolean) => (back ? history.back() : history.forward()),
      args: [action === 'back'],
    });
  }
}

/** `Host.tabs.navigate`: goto / back / forward / reload, then waits per `waitUntil`; returns the final URL. */
async function navigate(tabId: number, { action, url, waitUntil, timeoutMs }: NavigateOptions): Promise<{ url: string }> {
  if (action === 'goto') {
    if (!url) throw new Error('Navigate needs a URL');
    await browser.tabs.update(tabId, { url });
  } else if (action === 'back' || action === 'forward') await goHistory(tabId, action);
  else await browser.tabs.reload(tabId);
  await sleep(100);
  await waitForLoad(tabId, waitUntil, timeoutMs);
  return { url: (await tabInfo(tabId))?.url ?? '' };
}

const MAX_BODY_CHARS = 200_000;

/** `Host.http.fetch`: plain `fetch` from the extension origin (host permissions bypass CORS). Body capped at MAX_BODY_CHARS. */
async function httpFetch({ url, method, headers, body }: HttpRequestOptions): Promise<HttpResult> {
  const response = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
  const text = await response.text();
  return { status: response.status, ok: response.ok, body: text.slice(0, MAX_BODY_CHARS) };
}

/** `Host.notify`: a basic system notification. */
async function notify({ title, message }: NotifyOptions): Promise<void> {
  await browser.notifications.create({
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icon/128.png'),
    title,
    message,
  });
}

/** `Host.screenshots.capture`: JPEG of the tab saved in IndexedDB; returns its id, or null when it cannot be taken. */
async function capture(tabId: number, runId: string): Promise<string | null> {
  const tab = await browser.tabs.get(tabId);
  // captureVisibleTab only sees the tab that is showing in its window. A background tab needs the
  // debugger permission (granted for real input); without it there is no screenshot.
  const dataUrl =
    tab.active && tab.windowId !== undefined
      ? await browser.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 })
      : await captureWithDebugger(tabId).catch(() => null);
  if (!dataUrl) return null;
  const id = uid();
  await saveScreenshot({ id, runId, ts: Date.now(), dataUrl });
  return id;
}

/** `Host.secrets.all`: the `bf:secrets` map. */
async function allSecrets(): Promise<Record<string, string>> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.secrets);
  return (stored[STORAGE_KEYS.secrets] as Record<string, string> | undefined) ?? {};
}

/** `Host.downloads.save`: saves text as a file in the Downloads folder (unsafe filename characters replaced). */
async function saveDownload(filename: string, content: string, mime: string): Promise<void> {
  // Firefox's background page can make blob: URLs; Chrome's service worker cannot, so data: there.
  const url =
    typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL(new Blob([content], { type: mime }))
      : `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
  await browser.downloads.download({ url, filename: filename.replace(/[\\/:*?"<>|]+/g, '-'), conflictAction: 'uniquify' });
}

/** `Host.tabs.current`: the focused http(s) tab, or the most recently used one when the editor has focus. */
async function currentTab(): Promise<(TabInfo & { tabId: number }) | null> {
  const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  let tab = tabs.find((candidate) => /^https?:/.test(candidate.url ?? ''));
  if (!tab) {
    // The editor itself is focused: take the most recently used web page tab.
    const all = await browser.tabs.query({});
    tab = all
      .filter((candidate) => /^https?:/.test(candidate.url ?? ''))
      .sort((a, b) => ((b as { lastAccessed?: number }).lastAccessed ?? 0) - ((a as { lastAccessed?: number }).lastAccessed ?? 0))[0];
  }
  if (tab?.id === undefined) return null;
  return { tabId: tab.id, url: tab.url ?? '', title: tab.title ?? '', loading: tab.status === 'loading' };
}

/** `Host.http.download`: fetches a file as base64 (Upload File), with its MIME type and file name. */
async function downloadFile(url: string): Promise<{ base64: string; mime: string; name: string }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Downloading ${url} failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'file');
  return { base64: btoa(binary), mime: response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream', name };
}

/** alert/confirm/prompt live in the page's own JavaScript world, so this runs there (world: MAIN). */
async function dialogs(tabId: number, options: { mode: 'accept' | 'dismiss'; text: string } | { read: true }): Promise<{ type: string; message: string }[]> {
  const [injection] = await browser.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (mode: string | null, text: string) => {
      type State = { log: { type: string; message: string }[]; mode: string; text: string; installed?: boolean };
      const page = window as unknown as { __blockflowDialogs?: State };
      const state: State = (page.__blockflowDialogs ??= { log: [], mode: 'accept', text: '' });
      if (mode !== null) {
        state.mode = mode;
        state.text = text;
        if (!state.installed) {
          state.installed = true;
          const record = (type: string, message: unknown) => state.log.push({ type, message: String(message ?? '') });
          window.alert = (message?: unknown) => record('alert', message);
          window.confirm = (message?: string) => {
            record('confirm', message);
            return state.mode === 'accept';
          };
          window.prompt = (message?: string, fallback?: string) => {
            record('prompt', message);
            return state.mode === 'accept' ? state.text || fallback || '' : null;
          };
        }
      }
      return state.log;
    },
    args: 'read' in options ? [null, ''] : [options.mode, options.text],
  });
  return (injection?.result as { type: string; message: string }[] | undefined) ?? [];
}

/**
 * `Host.page.runScript`: runs user code with `chrome.userScripts.execute` (Chrome 135+, optional permission).
 * `data` is available as a constant; the code's return value is the result.
 */
async function runScript(tabId: number, code: string, data: Record<string, unknown>): Promise<unknown> {
  const needs =
    'Run Script needs Chrome 135 or newer, the "userScripts" permission (press Grant on the block), and "Allow User Scripts" (or developer mode) switched on for BlockFlow in chrome://extensions.';
  let api: { execute?: (options: unknown) => Promise<{ result?: unknown; error?: string }[]> } | undefined;
  try {
    // Reading the property throws while user scripts are not allowed.
    api = (browser as unknown as { userScripts?: typeof api }).userScripts;
  } catch (error) {
    throw new Error(`${needs} (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!api?.execute) throw new Error(needs);
  const wrapped = `(async () => {\nconst data = ${JSON.stringify(data)};\n${code}\n})()`;
  const [result] = await api.execute({ target: { tabId }, js: [{ code: wrapped }], world: 'USER_SCRIPT' });
  if (result?.error) throw new Error(result.error);
  return result?.result;
}

/** The real Host: connects the engine to the browser. */
export function createExtensionHost(scheduler: Scheduler): Host {
  return {
    sleep,
    http: { fetch: httpFetch, download: downloadFile },
    notify,
    tabs: {
      open: openTab,
      navigate,
      close: async (tabId) => {
        if (await tabInfo(tabId)) await browser.tabs.remove(tabId);
      },
      info: tabInfo,
      current: currentTab,
      waitForLoad,
      waitForUrl,
      waitForPopup,
      waitForResponse,
    },
    page: { readElement, act, dialogs, runScript },
    scheduler,
    state: new StorageState(),
    workflows: { get: async (id) => (await loadWorkflows()).find((workflow) => workflow.id === id) },
    secrets: { all: allSecrets },
    screenshots: { capture },
    prompt: { ask: askUser },
    datasets: {
      read: async (name) => (await readDataset(name))?.rows ?? [],
      write: writeDataset,
    },
    downloads: { save: saveDownload },
    html: { act: actOnHtml },
    now: () => new Date(),
  };
}
