import { describe, expect, it } from 'vitest';
import { HybridScheduler } from '../../src/browser/hybridScheduler';
import type {
  AlarmInfo,
  AlarmPort,
  Clock,
  StoredTimer,
  TimerStore,
} from '../../src/browser/hybridScheduler';
import { WorkflowRunner } from '../../src/core/engine';
import { createDefaultRegistry } from '../../src/core/blocks';
import { makeTimerKey, workflowTimerPrefix } from '../../src/core/timerKey';
import type { Host } from '../../src/core/types';
import { FakeHost, flow } from '../helpers/fakeHost';

// --- fakes ---------------------------------------------------------------------------

/** Manual clock: nothing happens until advance() is called. */
class FakeClock implements Clock {
  private time: number;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void; every?: number }>();

  constructor(start = 1_000_000) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    this.seq += 1;
    this.timers.set(this.seq, { at: this.time + ms, fn });
    return this.seq;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  setInterval(fn: () => void, ms: number): unknown {
    this.seq += 1;
    this.timers.set(this.seq, { at: this.time + ms, fn, every: ms });
    return this.seq;
  }

  clearInterval(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  pending(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [id, timer] = due;
      this.time = timer.at;
      if (timer.every !== undefined) timer.at += timer.every;
      else this.timers.delete(id);
      timer.fn();
    }
    this.time = end;
  }
}

class FakeAlarms implements AlarmPort {
  readonly map = new Map<string, AlarmInfo>();

  async create(name: string, info: AlarmInfo): Promise<void> {
    this.map.set(name, info);
  }

  async clear(name: string): Promise<void> {
    this.map.delete(name);
  }

  async names(): Promise<string[]> {
    return [...this.map.keys()];
  }
}

class MemoryTimerStore implements TimerStore {
  readonly map = new Map<string, StoredTimer>();

  async get(key: string): Promise<StoredTimer | undefined> {
    const record = this.map.get(key);
    return record ? { ...record } : undefined;
  }

  async set(key: string, record: StoredTimer): Promise<void> {
    this.map.set(key, { ...record });
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }
}

/** Lets pending promise callbacks run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(existing?: { alarms: FakeAlarms; store: MemoryTimerStore }, startTime?: number) {
  const clock = new FakeClock(startTime);
  const alarms = existing?.alarms ?? new FakeAlarms();
  const store = existing?.store ?? new MemoryTimerStore();
  const fired: string[] = [];
  const pings = { count: 0 };
  const scheduler = new HybridScheduler({
    alarms,
    store,
    clock,
    fire: (key) => {
      fired.push(key);
    },
    ping: () => {
      pings.count += 1;
    },
  });
  return { clock, alarms, store, fired, pings, scheduler };
}

const KEY = 'bf::wf::node::tick';

// --- long timers: alarms only ----------------------------------------------------------

describe('timers of 30s or more', () => {
  it('use an alarm and nothing else', async () => {
    const t = setup();
    await t.scheduler.set(KEY, { delayMs: 60_000, periodMs: 60_000 });
    expect(t.alarms.map.get(KEY)).toEqual({ when: t.clock.now() + 60_000, periodInMinutes: 1 });
    expect(t.scheduler.armedCount()).toBe(0);
    expect(t.clock.pending()).toBe(0); // no in-memory timer, no keep-alive
    expect(await t.scheduler.handleAlarm(KEY)).toBe(false); // a real fire, not a heartbeat
    expect(t.pings.count).toBe(0);
  });

  it('exactly 30s still counts as long', async () => {
    const t = setup();
    await t.scheduler.set(KEY, { delayMs: 30_000, periodMs: 30_000 });
    expect(t.scheduler.armedCount()).toBe(0);
  });
});

// --- short timers: in-memory + keep-alive ----------------------------------------------------

describe('timers under 30s', () => {
  it('fire on time, repeatedly, from memory', async () => {
    const t = setup();
    await t.scheduler.set(KEY, { delayMs: 5_000, periodMs: 5_000 });
    t.clock.advance(4_999);
    expect(t.fired).toEqual([]);
    t.clock.advance(1);
    expect(t.fired).toEqual([KEY]);
    t.clock.advance(10_000);
    expect(t.fired).toEqual([KEY, KEY, KEY]);
  });

  it('keep an alarm as a 30s heartbeat instead of the short period', async () => {
    const t = setup();
    await t.scheduler.set(KEY, { delayMs: 5_000, periodMs: 5_000 });
    expect(t.alarms.map.get(KEY)).toEqual({ when: t.clock.now() + 30_000, periodInMinutes: 0.5 });
  });

  it('run the keep-alive ping while armed, and stop it when nothing is armed', async () => {
    const t = setup();
    await t.scheduler.set(KEY, { delayMs: 5_000, periodMs: 5_000 });
    expect(t.pings.count).toBe(1); // immediately
    t.clock.advance(60_000);
    expect(t.pings.count).toBe(1 + 3); // every 20s

    await t.scheduler.clear(KEY);
    const afterClear = t.pings.count;
    expect(t.clock.pending()).toBe(0);
    t.clock.advance(120_000);
    expect(t.pings.count).toBe(afterClear);
  });

  it('hold() keeps the worker awake (for a live run) until every hold is released', async () => {
    const t = setup();
    t.scheduler.hold('run:1');
    t.scheduler.hold('run:2');
    t.clock.advance(60_000);
    expect(t.pings.count).toBe(1 + 3);
    t.scheduler.release('run:1');
    expect(t.scheduler.isPinging()).toBe(true);
    // A short timer armed and cleared meanwhile must not stop the ping a run still needs.
    await t.scheduler.set(KEY, { delayMs: 5_000 });
    await t.scheduler.clear(KEY);
    expect(t.scheduler.isPinging()).toBe(true);
    t.scheduler.release('run:2');
    t.scheduler.release('unknown');
    expect(t.scheduler.isPinging()).toBe(false);
    const after = t.pings.count;
    t.clock.advance(120_000);
    expect(t.pings.count).toBe(after);
  });

  it('a one-shot fires once, then releases everything', async () => {
    const t = setup();
    await t.scheduler.set(KEY, { delayMs: 5_000 }, { hello: 'world' });
    t.clock.advance(5_000);
    expect(t.fired).toEqual([KEY]);
    expect(t.scheduler.armedCount()).toBe(0);
    expect(t.clock.pending()).toBe(0);

    const record = await t.scheduler.take(KEY);
    expect(record).toEqual({ periodic: false, data: { hello: 'world' } });
    expect(t.store.map.size).toBe(0);
    expect(t.alarms.map.size).toBe(0); // heartbeat removed too
    t.clock.advance(60_000);
    expect(t.fired).toEqual([KEY]);
  });

  it('setting the same key again replaces the old timer instead of doubling it', async () => {
    const t = setup();
    await t.scheduler.set(KEY, { delayMs: 5_000, periodMs: 5_000 });
    await t.scheduler.set(KEY, { delayMs: 5_000, periodMs: 5_000 });
    t.clock.advance(5_000);
    expect(t.fired).toEqual([KEY]);
    expect(t.scheduler.armedCount()).toBe(1);
  });

  it('a short delay with a long period still counts as short', async () => {
    const t = setup();
    await t.scheduler.set(KEY, { delayMs: 3_000, periodMs: 60_000 });
    expect(t.scheduler.isArmed(KEY)).toBe(true);
    t.clock.advance(3_000);
    expect(t.fired).toEqual([KEY]);
    t.clock.advance(60_000);
    expect(t.fired).toEqual([KEY, KEY]);
  });

  it('keep going if a handler throws', async () => {
    const clock = new FakeClock();
    let calls = 0;
    const scheduler = new HybridScheduler({
      alarms: new FakeAlarms(),
      store: new MemoryTimerStore(),
      clock,
      fire: () => {
        calls += 1;
        throw new Error('boom');
      },
      ping: () => {},
    });
    await scheduler.set(KEY, { delayMs: 1_000, periodMs: 1_000 });
    clock.advance(3_000);
    expect(calls).toBe(3);
  });
});

// --- clearing --------------------------------------------------------------------------

describe('clearing', () => {
  it('clearPrefix stops that workflow\'s timers only', async () => {
    const t = setup();
    const mine = makeTimerKey('wfA', 'n1', 'tick');
    const other = makeTimerKey('wfB', 'n1', 'tick');
    const longOne = makeTimerKey('wfA', 'n2', 'tick');
    await t.scheduler.set(mine, { delayMs: 5_000, periodMs: 5_000 });
    await t.scheduler.set(other, { delayMs: 5_000, periodMs: 5_000 });
    await t.scheduler.set(longOne, { delayMs: 60_000, periodMs: 60_000 });

    await t.scheduler.clearPrefix(workflowTimerPrefix('wfA'));
    t.clock.advance(5_000);
    expect(t.fired).toEqual([other]);
    expect([...t.alarms.map.keys()]).toEqual([other]);
    expect([...t.store.map.keys()]).toEqual([other]);
    expect(t.scheduler.armedCount()).toBe(1);
  });

  it('take() on a cleared timer returns nothing and removes a stray alarm', async () => {
    const t = setup();
    t.alarms.map.set(KEY, { when: 1 });
    expect(await t.scheduler.take(KEY)).toBeUndefined();
    expect(t.alarms.map.size).toBe(0);
  });

  it('take() leaves periodic timers in place', async () => {
    const t = setup();
    await t.scheduler.set(KEY, { delayMs: 5_000, periodMs: 5_000 });
    expect(await t.scheduler.take(KEY)).toEqual({ periodic: true });
    expect(t.scheduler.isArmed(KEY)).toBe(true);
    expect(t.store.map.size).toBe(1);
  });
});

// --- worker restarts ----------------------------------------------------------------------

describe('when the background worker restarts', () => {
  it('restoreAll re-arms short timers, which then fire a full period later', async () => {
    const first = setup();
    await first.scheduler.set(KEY, { delayMs: 5_000, periodMs: 5_000 });
    first.clock.advance(12_000);
    expect(first.fired).toHaveLength(2);

    // The worker dies: its memory (clock, armed timers) is gone. Alarms and storage survive.
    const second = setup({ alarms: first.alarms, store: first.store }, first.clock.now());
    expect(second.scheduler.armedCount()).toBe(0);
    await second.scheduler.restoreAll();
    expect(second.scheduler.isArmed(KEY)).toBe(true);
    expect(second.pings.count).toBe(1);

    second.clock.advance(4_999);
    expect(second.fired).toEqual([]);
    second.clock.advance(1);
    expect(second.fired).toEqual([KEY]);
  });

  it('the heartbeat alarm re-arms a lost timer, and only once', async () => {
    const first = setup();
    await first.scheduler.set(KEY, { delayMs: 5_000, periodMs: 5_000 });
    const second = setup({ alarms: first.alarms, store: first.store }, first.clock.now());

    expect(await second.scheduler.handleAlarm(KEY)).toBe(true);
    expect(second.scheduler.isArmed(KEY)).toBe(true);
    expect(await second.scheduler.handleAlarm(KEY)).toBe(true); // next heartbeat: nothing new
    second.clock.advance(5_000);
    expect(second.fired).toEqual([KEY]);
  });

  it('an overdue short one-shot fires right away after a restart', async () => {
    const first = setup();
    await first.scheduler.set(KEY, { delayMs: 5_000 });
    first.clock.advance(1_000);
    const second = setup({ alarms: first.alarms, store: first.store }, first.clock.now() + 20_000);
    await second.scheduler.restoreAll();
    second.clock.advance(0);
    expect(second.fired).toEqual([KEY]);
  });

  it('restoreAll recreates alarms the browser forgot', async () => {
    const first = setup();
    await first.scheduler.set('bf::wf::a::tick', { delayMs: 60_000, periodMs: 60_000 });
    await first.scheduler.set('bf::wf::b::tick', { delayMs: 5_000, periodMs: 5_000 });
    first.alarms.map.clear(); // e.g. browser restarted without persisting alarms

    // 70s later the 60s timer is overdue.
    const second = setup({ alarms: first.alarms, store: first.store }, first.clock.now() + 70_000);
    await second.scheduler.restoreAll();
    expect([...second.alarms.map.keys()].sort()).toEqual(['bf::wf::a::tick', 'bf::wf::b::tick']);
    // An overdue periodic timer waits a full period instead of firing a burst.
    expect(second.alarms.map.get('bf::wf::a::tick')).toEqual({
      when: second.clock.now() + 60_000,
      periodInMinutes: 1,
    });
    // The short timer gets its heartbeat alarm and is armed in memory again.
    expect(second.alarms.map.get('bf::wf::b::tick')).toEqual({
      when: second.clock.now() + 30_000,
      periodInMinutes: 0.5,
    });
    expect(second.scheduler.isArmed('bf::wf::b::tick')).toBe(true);
  });

  it('restoreAll keeps the original due time of a long timer that is not overdue yet', async () => {
    const first = setup();
    await first.scheduler.set(KEY, { delayMs: 60_000, periodMs: 60_000 });
    const dueAt = first.clock.now() + 60_000;
    first.alarms.map.clear();

    const second = setup({ alarms: first.alarms, store: first.store }, first.clock.now() + 10_000);
    await second.scheduler.restoreAll();
    expect(second.alarms.map.get(KEY)).toEqual({ when: dueAt, periodInMinutes: 1 });
  });

  it('restoreAll with nothing stored does nothing', async () => {
    const t = setup();
    await t.scheduler.restoreAll();
    expect(t.clock.pending()).toBe(0);
    expect(t.pings.count).toBe(0);
  });
});

// --- together with the engine -----------------------------------------------------------------

describe('with the workflow engine', () => {
  /** A runner whose timers are driven by a HybridScheduler on a fake clock, like the real background worker. */
  function liveRunner(workflow: ReturnType<typeof flow>) {
    const clock = new FakeClock();
    const base = new FakeHost();
    const holder: { runner?: WorkflowRunner } = {};
    const scheduler = new HybridScheduler({
      alarms: new FakeAlarms(),
      store: new MemoryTimerStore(),
      clock,
      fire: (key) => holder.runner?.handleTimer(key),
      ping: () => {},
    });
    // Same fake browser as FakeHost, but with the real HybridScheduler.
    const host: Host = {
      sleep: base.sleep,
      http: base.http,
      notify: base.notify,
      tabs: base.tabs,
      page: base.page,
      scheduler,
      state: base.state,
      workflows: base.workflows,
      secrets: base.secrets,
      screenshots: base.screenshots,
      prompt: base.prompt,
      datasets: base.datasets,
      downloads: base.downloads,
      html: base.html,
      now: () => base.now(),
    };
    const runner = new WorkflowRunner({ workflow, registry: createDefaultRegistry(), host });
    holder.runner = runner;
    return { clock, base, scheduler, runner };
  }

  it('Timer (5s) → Open URL opens a tab every 5 seconds, then stops when the workflow stops', async () => {
    const { clock, base, scheduler, runner } = liveRunner(
      flow(
        [
          { id: 't', type: 'timer', config: { seconds: 5, repeat: true } },
          { id: 'o', type: 'open-url', config: { url: 'https://example.com/?n={{tick}}' } },
        ],
        [['t', 'o']],
      ),
    );

    await runner.start();
    for (let i = 0; i < 3; i += 1) {
      clock.advance(5_000);
      await settle();
    }
    expect(base.opened.map((tab) => tab.url)).toEqual([
      'https://example.com/?n=1',
      'https://example.com/?n=2',
      'https://example.com/?n=3',
    ]);

    await runner.stop();
    expect(scheduler.armedCount()).toBe(0);
    clock.advance(60_000);
    await settle();
    expect(base.opened).toHaveLength(3);
  });

  it('Watch Element every 10s notices a change and opens the page', async () => {
    const { clock, base, runner } = liveRunner(
      flow(
        [
          {
            id: 'w',
            type: 'watch-element',
            config: { url: 'https://shop.example.com/item', selector: '.price', intervalSeconds: 10 },
          },
          { id: 'o', type: 'open-url', config: { url: '{{url}}#changed' } },
        ],
        [['w', 'o']],
      ),
    );
    base.pageTexts('$10', '$10', '$8');

    await runner.start(); // baseline $10
    clock.advance(10_000);
    await settle(); // still $10
    expect(base.opened).toHaveLength(0);
    clock.advance(10_000);
    await settle(); // now $8
    expect(base.opened.map((tab) => tab.url)).toEqual(['https://shop.example.com/item#changed']);
  });

  it('Watch Element → Timer (8s delay) → Open URL waits inside the run after a change', async () => {
    const { clock, base, runner } = liveRunner(
      flow(
        [
          {
            id: 'w',
            type: 'watch-element',
            config: { url: 'https://shop.example.com/item', selector: '.price', intervalSeconds: 10 },
          },
          { id: 'd', type: 'timer', config: { seconds: 8 } },
          { id: 'o', type: 'open-url', config: { url: '{{url}}#after' } },
        ],
        [
          ['w', 'd'],
          ['d', 'o'],
        ],
      ),
    );
    base.pageTexts('a', 'b');

    await runner.start(); // baseline "a"
    clock.advance(10_000); // the poll finds "b"; the delay waits inside the run (virtual sleeps)
    for (let i = 0; i < 30; i += 1) await settle();
    expect(base.opened.map((tab) => tab.url)).toEqual(['https://shop.example.com/item#after']);
    expect(base.sleeps.filter((ms) => ms === 1000)).toHaveLength(8);
  });
});
