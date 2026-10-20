import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '../shared/keys';
import { HybridScheduler } from './hybridScheduler';
import type { StoredTimer } from './hybridScheduler';

/**
 * The real scheduler: browser.alarms for durability, in-memory timers plus a keep-alive ping
 * for intervals below the 30 second alarm minimum. See hybridScheduler.ts for how it works.
 *
 * `fire` is called when a short timer is due; the background worker points it at the same
 * code path an alarm uses.
 */
export function createBrowserScheduler(fire: (key: string) => void | Promise<void>): HybridScheduler {
  const prefix = STORAGE_KEYS.timerPrefix;

  return new HybridScheduler({
    alarms: {
      create: async (name, info) => {
        await browser.alarms.create(name, info);
      },
      clear: async (name) => {
        await browser.alarms.clear(name);
      },
      names: async () => (await browser.alarms.getAll()).map((alarm) => alarm.name),
    },
    store: {
      async get(key) {
        const storageKey = prefix + key;
        const stored = await browser.storage.local.get(storageKey);
        return stored[storageKey] as StoredTimer | undefined;
      },
      set: (key, record) => browser.storage.local.set({ [prefix + key]: record }),
      remove: (key) => browser.storage.local.remove(prefix + key),
      async keys() {
        const everything = await browser.storage.local.get(null);
        return Object.keys(everything)
          .filter((name) => name.startsWith(prefix))
          .map((name) => name.slice(prefix.length));
      },
    },
    clock: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    },
    fire,
    // Any extension API call resets the worker's idle timer; this is the cheapest one.
    ping: () => browser.runtime.getPlatformInfo(),
  });
}
