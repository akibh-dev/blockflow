import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '../shared/keys';
import type { Payload, Scheduler, TimerOptions, TimerRecord } from '../core/types';

interface StoredTimer {
  data?: Payload;
  periodic: boolean;
}

/**
 * Scheduler on top of browser.alarms, so timers survive the background worker being put to
 * sleep. The alarm name is the timer key; any payload the timer carries is kept in storage.
 *
 * Note: Chrome enforces a minimum alarm period of about 30 seconds.
 */
export class AlarmScheduler implements Scheduler {
  async set(key: string, options: TimerOptions, data?: Payload): Promise<void> {
    const record: StoredTimer = { periodic: options.periodMs !== undefined, ...(data ? { data } : {}) };
    // Store first: the alarm can only fire after the record is there.
    await browser.storage.local.set({ [STORAGE_KEYS.timerPrefix + key]: record });
    await browser.alarms.create(key, {
      when: Date.now() + options.delayMs,
      ...(options.periodMs !== undefined ? { periodInMinutes: options.periodMs / 60_000 } : {}),
    });
  }

  async clear(key: string): Promise<void> {
    await browser.alarms.clear(key);
    await browser.storage.local.remove(STORAGE_KEYS.timerPrefix + key);
  }

  async clearPrefix(prefix: string): Promise<void> {
    const alarms = await browser.alarms.getAll();
    await Promise.all(alarms.filter((alarm) => alarm.name.startsWith(prefix)).map((alarm) => browser.alarms.clear(alarm.name)));

    const everything = await browser.storage.local.get(null);
    const stale = Object.keys(everything).filter((name) =>
      name.startsWith(STORAGE_KEYS.timerPrefix + prefix),
    );
    if (stale.length > 0) await browser.storage.local.remove(stale);
  }

  async take(key: string): Promise<TimerRecord | undefined> {
    const storageKey = STORAGE_KEYS.timerPrefix + key;
    const stored = await browser.storage.local.get(storageKey);
    const record = stored[storageKey] as StoredTimer | undefined;
    if (!record) {
      // An alarm with no record is left over from a cleared timer. Make sure it stops.
      await browser.alarms.clear(key);
      return undefined;
    }
    if (!record.periodic) await browser.storage.local.remove(storageKey);
    return { periodic: record.periodic, ...(record.data ? { data: record.data } : {}) };
  }
}
