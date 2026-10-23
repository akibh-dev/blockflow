import { browser } from 'wxt/browser';
import { uid } from '../core/id';
import { STORAGE_KEYS } from '../shared/keys';
import { saveScreenshot } from './blobStore';
import { tabInfo, waitForLoad, waitForUrl } from './navigation';
import { askUser } from './prompts';
import { loadWorkflows } from './stores';
import { actInTab } from './pageDriver';
import { readElement } from './pageReader';
import { requireTabId, sleep } from './tabs';
import type { Host, HttpRequestOptions, HttpResult, NavigateOptions, NotifyOptions, OpenTabOptions, Scheduler, StateStore } from '../core/types';

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
  // Give the navigation a moment to start, so "complete" is not the previous page's.
  if (waitUntil !== 'none') {
    await sleep(100);
    await waitForLoad(tabId, waitUntil, timeoutMs);
  }
  return { tabId };
}

async function navigate(tabId: number, { action, url, waitUntil, timeoutMs }: NavigateOptions): Promise<{ url: string }> {
  if (action === 'goto') {
    if (!url) throw new Error('Navigate needs a URL');
    await browser.tabs.update(tabId, { url });
  } else if (action === 'back') await browser.tabs.goBack(tabId);
  else if (action === 'forward') await browser.tabs.goForward(tabId);
  else await browser.tabs.reload(tabId);
  await sleep(100);
  await waitForLoad(tabId, waitUntil, timeoutMs);
  return { url: (await tabInfo(tabId))?.url ?? '' };
}

const MAX_BODY_CHARS = 200_000;

async function httpFetch({ url, method, headers, body }: HttpRequestOptions): Promise<HttpResult> {
  const response = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
  const text = await response.text();
  return { status: response.status, ok: response.ok, body: text.slice(0, MAX_BODY_CHARS) };
}

async function notify({ title, message }: NotifyOptions): Promise<void> {
  await browser.notifications.create({
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icon/128.png'),
    title,
    message,
  });
}

async function capture(tabId: number, runId: string): Promise<string | null> {
  const tab = await browser.tabs.get(tabId);
  // captureVisibleTab only sees the tab that is showing in its window. Runs in a background tab
  // get no screenshot (use Open Tab "in a new window" for tests).
  if (!tab.active || tab.windowId === undefined) return null;
  const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });
  const id = uid();
  await saveScreenshot({ id, runId, ts: Date.now(), dataUrl });
  return id;
}

async function allSecrets(): Promise<Record<string, string>> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.secrets);
  return (stored[STORAGE_KEYS.secrets] as Record<string, string> | undefined) ?? {};
}

/** The real Host: connects the engine to the browser. */
export function createExtensionHost(scheduler: Scheduler): Host {
  return {
    sleep,
    http: { fetch: httpFetch },
    notify,
    tabs: {
      open: openTab,
      navigate,
      close: async (tabId) => {
        if (await tabInfo(tabId)) await browser.tabs.remove(tabId);
      },
      info: tabInfo,
      waitForLoad,
      waitForUrl,
    },
    page: { readElement, act: actInTab },
    scheduler,
    state: new StorageState(),
    workflows: { get: async (id) => (await loadWorkflows()).find((workflow) => workflow.id === id) },
    secrets: { all: allSecrets },
    screenshots: { capture },
    prompt: { ask: askUser },
    now: () => new Date(),
  };
}
