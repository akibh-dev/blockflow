import type { Payload, Scheduler, TimerOptions, TimerRecord } from '../core/types';

/**
 * Scheduler that can do both long and short timers.
 *
 * - Timer of 30s or more: a browser alarm does everything. The alarm wakes the background
 *   worker when it is due.
 * - Timer under 30s (browsers will not do that with alarms): an in-memory timer fires it
 *   precisely, and while any such timer is armed a keep-alive ping runs so the worker is not
 *   put to sleep. The alarm is still created, as a 30s heartbeat: if the worker dies anyway
 *   (browser restart, crash), the next heartbeat wakes it and re-arms the in-memory timer.
 *
 * Everything the scheduler needs from the browser comes in through small ports, so the logic
 * is tested with a fake clock and fake alarms. The real ports are in ./scheduler.ts.
 */

export const ALARM_MIN_MS = 30_000;
export const PING_EVERY_MS = 20_000;

export interface StoredTimer {
  data?: Payload;
  periodic: boolean;
  delayMs: number;
  periodMs?: number;
  /** Epoch ms when the first fire is due. */
  dueAt: number;
  /** Driven by in-memory timers (interval below the alarm minimum). */
  short: boolean;
}

export interface AlarmInfo {
  when: number;
  periodInMinutes?: number;
}

export interface AlarmPort {
  create(name: string, info: AlarmInfo): Promise<void>;
  clear(name: string): Promise<void>;
  names(): Promise<string[]>;
}

export interface TimerStore {
  get(key: string): Promise<StoredTimer | undefined>;
  set(key: string, record: StoredTimer): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface HybridSchedulerOptions {
  alarms: AlarmPort;
  store: TimerStore;
  clock: Clock;
  /** Called when a short timer is due. Should end up calling runner.handleTimer(key). */
  fire(key: string): void | Promise<void>;
  /** Cheap call to any extension API. Calling one resets the worker's idle timer. */
  ping(): void | Promise<unknown>;
  minAlarmMs?: number;
  pingEveryMs?: number;
}

interface Armed {
  handle: unknown;
  record: StoredTimer;
}

export class HybridScheduler implements Scheduler {
  private readonly alarms: AlarmPort;
  private readonly store: TimerStore;
  private readonly clock: Clock;
  private readonly fireTimer: (key: string) => void | Promise<void>;
  private readonly pingApi: () => void | Promise<unknown>;
  private readonly minAlarmMs: number;
  private readonly pingEveryMs: number;
  private readonly armed = new Map<string, Armed>();
  private pingHandle: unknown = null;

  constructor(options: HybridSchedulerOptions) {
    this.alarms = options.alarms;
    this.store = options.store;
    this.clock = options.clock;
    this.fireTimer = options.fire;
    this.pingApi = options.ping;
    this.minAlarmMs = options.minAlarmMs ?? ALARM_MIN_MS;
    this.pingEveryMs = options.pingEveryMs ?? PING_EVERY_MS;
  }

  // --- Scheduler interface ---------------------------------------------------

  async set(key: string, options: TimerOptions, data?: Payload): Promise<void> {
    const periodic = options.periodMs !== undefined;
    const short =
      options.delayMs < this.minAlarmMs ||
      (options.periodMs !== undefined && options.periodMs < this.minAlarmMs);
    const record: StoredTimer = {
      periodic,
      delayMs: options.delayMs,
      dueAt: this.clock.now() + options.delayMs,
      short,
      ...(options.periodMs !== undefined ? { periodMs: options.periodMs } : {}),
      ...(data ? { data } : {}),
    };

    this.disarm(key);
    await this.store.set(key, record);
    await this.alarms.create(key, this.alarmFor(record));
    if (short) this.arm(key, record, false);
  }

  async clear(key: string): Promise<void> {
    this.disarm(key);
    await this.alarms.clear(key);
    await this.store.remove(key);
  }

  async clearPrefix(prefix: string): Promise<void> {
    for (const key of [...this.armed.keys()]) {
      if (key.startsWith(prefix)) this.disarm(key);
    }
    const names = (await this.alarms.names()).filter((name) => name.startsWith(prefix));
    await Promise.all(names.map((name) => this.alarms.clear(name)));
    const keys = (await this.store.keys()).filter((key) => key.startsWith(prefix));
    await Promise.all(keys.map((key) => this.store.remove(key)));
  }

  async take(key: string): Promise<TimerRecord | undefined> {
    const record = await this.store.get(key);
    if (!record) {
      // Left over from a cleared timer: make sure no alarm keeps firing for it.
      await this.alarms.clear(key);
      return undefined;
    }
    if (!record.periodic) {
      this.disarm(key);
      await this.store.remove(key);
      if (record.short) await this.alarms.clear(key); // the heartbeat; long one-shots end on their own
    }
    return { periodic: record.periodic, ...(record.data ? { data: record.data } : {}) };
  }

  // --- Called by the background worker -------------------------------------------

  /**
   * Call from the alarm listener. Returns true if the alarm was only the heartbeat of a short
   * timer (nothing else to do), false if it is a real timer firing.
   */
  async handleAlarm(name: string): Promise<boolean> {
    const record = await this.store.get(name);
    if (!record || !record.short) return false;
    if (!this.armed.has(name)) this.arm(name, record, true);
    return true;
  }

  /**
   * Call every time the background worker starts. Re-arms short timers that were lost when the
   * worker stopped, and recreates alarms the browser forgot (e.g. after a restart).
   */
  async restoreAll(): Promise<void> {
    const existing = new Set(await this.alarms.names());
    for (const key of await this.store.keys()) {
      const record = await this.store.get(key);
      if (!record) continue;
      if (!existing.has(key)) await this.alarms.create(key, this.alarmFor(record, true));
      if (record.short && !this.armed.has(key)) this.arm(key, record, true);
    }
  }

  isArmed(key: string): boolean {
    return this.armed.has(key);
  }

  armedCount(): number {
    return this.armed.size;
  }

  // --- internals -------------------------------------------------------------

  private alarmFor(record: StoredTimer, restoring = false): AlarmInfo {
    const now = this.clock.now();
    if (record.short) {
      // Heartbeat only: wakes a dead worker so it can re-arm the in-memory timer.
      return { when: now + this.minAlarmMs, periodInMinutes: this.minAlarmMs / 60_000 };
    }
    let when = record.dueAt;
    if (restoring && when <= now) {
      // Overdue after a restart: a periodic timer waits a full period, a one-shot catches up now.
      when = record.periodic ? now + (record.periodMs ?? record.delayMs) : now + 1_000;
    }
    return {
      when,
      ...(record.periodic ? { periodInMinutes: (record.periodMs ?? record.delayMs) / 60_000 } : {}),
    };
  }

  private arm(key: string, record: StoredTimer, restored: boolean): void {
    this.disarm(key);
    const delay =
      restored && record.periodic
        ? (record.periodMs ?? record.delayMs)
        : Math.max(0, record.dueAt - this.clock.now());
    const entry: Armed = { handle: null, record };
    entry.handle = this.clock.setTimeout(() => this.tick(key), delay);
    this.armed.set(key, entry);
    this.syncPing();
  }

  private disarm(key: string): void {
    const entry = this.armed.get(key);
    if (!entry) return;
    this.clock.clearTimeout(entry.handle);
    this.armed.delete(key);
    this.syncPing();
  }

  private tick(key: string): void {
    const entry = this.armed.get(key);
    if (!entry) return;
    const { record } = entry;
    if (record.periodic) {
      // Schedule the next tick first, so a slow handler does not make the interval drift.
      entry.handle = this.clock.setTimeout(() => this.tick(key), record.periodMs ?? record.delayMs);
    } else {
      this.armed.delete(key);
      this.syncPing();
    }
    try {
      void Promise.resolve(this.fireTimer(key)).catch(() => {});
    } catch {
      // A failing handler must never stop the scheduler.
    }
  }

  /** Keep-alive runs exactly while at least one short timer is armed. */
  private syncPing(): void {
    const needed = this.armed.size > 0;
    if (needed && this.pingHandle === null) {
      this.pingHandle = this.clock.setInterval(() => this.ping(), this.pingEveryMs);
      this.ping();
    } else if (!needed && this.pingHandle !== null) {
      this.clock.clearInterval(this.pingHandle);
      this.pingHandle = null;
    }
  }

  private ping(): void {
    try {
      void Promise.resolve(this.pingApi()).catch(() => {});
    } catch {
      // Ignore: the next ping will try again.
    }
  }
}
