import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '../shared/keys';
import { readElement } from './pageReader';
import { requireTabId, sleep } from './tabs';
import type { Host, HttpRequestOptions, HttpResult, NotifyOptions, OpenTabOptions, Scheduler, StateStore } from '../core/types';

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

async function openTab({ url, newTab, active }: OpenTabOptions): Promise<{ tabId: number }> {
  if (!newTab) {
    const [current] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (current?.id !== undefined) {
      await browser.tabs.update(current.id, { url });
      return { tabId: current.id };
    }
  }
  const tab = await browser.tabs.create({ url, active });
  return { tabId: requireTabId(tab) };
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

/** The real Host: connects the engine to the browser. */
export function createExtensionHost(scheduler: Scheduler): Host {
  return {
    sleep,
    http: { fetch: httpFetch },
    notify,
    tabs: { open: openTab },
    page: { readElement },
    scheduler,
    state: new StorageState(),
    now: () => new Date(),
  };
}
