import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DebugPause } from '../../src/core/types';
import { FakeHost, flow, harness } from '../helpers/fakeHost';

// storage.session and runtime for the module-level channel (the one host.ts wires in).
const fake = vi.hoisted(() => ({ session: {} as Record<string, unknown>, pings: 0, acts: [] as unknown[] }));
vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      session: {
        get: vi.fn(async (key: string) => (key in fake.session ? { [key]: fake.session[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => Object.assign(fake.session, items)),
      },
      local: { get: vi.fn(async () => ({ 'bf:workflows': [{ id: 'wf', name: 'Checkout' }] })), set: vi.fn(async () => {}) },
    },
    runtime: { getPlatformInfo: vi.fn(async () => { fake.pings += 1; return {}; }) },
  },
}));
vi.mock('../../src/browser/pageDriver', () => ({ act: vi.fn(async (_tabId: number, request: unknown) => { fake.acts.push(request); return {}; }) }));
vi.mock('../../src/browser/tabs', () => ({ sleep: () => new Promise((resolve) => setTimeout(resolve, 1)) }));

const { createDebugChannel, debugChannel, answerDebug, clearStaleDebugPauses, DEBUG_PAUSE_KEY, MAX_PAUSE_MS, POLL_MS } = await import('../../src/browser/debugChannel');
type PausedRun = import('../../src/browser/debugChannel').PausedRun;

/** One turn of the event loop (no 1 ms clamp like setTimeout). */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const info = (over: Partial<DebugPause> = {}): DebugPause => ({
  runId: 'r1',
  workflowId: 'wf',
  nodeId: 'b',
  blockType: 'click',
  reason: 'breakpoint',
  input: { n: 1 },
  ...over,
});

/** A channel on in-memory deps with a fake clock: every `sleep` advances time by `ms`. */
function memoryChannel() {
  let list: PausedRun[] = [];
  let now = 1_000_000;
  const log = { pings: 0, highlights: [] as [number, string, boolean][], warnings: [] as string[], slept: 0 };
  let onSleep: () => void = () => {};
  const channel = createDebugChannel({
    read: async () => list,
    write: async (next) => {
      list = next;
    },
    highlight: async (tabId, locator, clear) => {
      log.highlights.push([tabId, locator, clear]);
    },
    keepAlive: async () => {
      log.pings += 1;
    },
    sleep: async (ms) => {
      now += ms;
      log.slept += ms;
      onSleep();
      await tick();
    },
    now: () => now,
    workflowName: async (id) => (id === 'wf' ? 'Checkout' : undefined),
    warn: (message) => log.warnings.push(message),
  });
  return {
    channel,
    log,
    stored: () => list,
    setStored: (next: PausedRun[]) => {
      list = next;
    },
    /** Resolves once the run is listed (the editor could see it). */
    whenListed: async (runId: string) => {
      for (let i = 0; i < 1000 && !list.some((p) => p.runId === runId); i += 1) await tick();
      expect(list.some((p) => p.runId === runId)).toBe(true);
    },
    onSleep: (fn: () => void) => {
      onSleep = fn;
    },
  };
}

describe('debug channel', () => {
  it('lists the pause, resolves with the answer and removes it', async () => {
    const t = memoryChannel();
    const waiting = t.channel.pause(info({ tabId: 7, locator: '#buy' }));
    await t.whenListed('r1');
    // An editor that opens now reads the pause from storage: everything the banner shows is there.
    expect(t.stored()).toEqual([expect.objectContaining({ runId: 'r1', nodeId: 'b', reason: 'breakpoint', workflowName: 'Checkout', input: { n: 1 }, tabId: 7, locator: '#buy' })]);
    expect(typeof t.stored()[0]!.pausedAt).toBe('string');
    expect(t.channel.isPaused('r1')).toBe(true);
    expect(t.channel.answer('r1', 'step')).toBe(true);
    expect(t.channel.answer('r1', 'continue')).toBe(false); // already answered
    expect(await waiting).toBe('step');
    expect(t.stored()).toEqual([]);
    expect(t.channel.isPaused('r1')).toBe(false);
    // Outlined while paused, cleared after.
    expect(t.log.highlights).toEqual([
      [7, '#buy', false],
      [7, '#buy', true],
    ]);
  });

  it('ignores answers for runs that are not paused', () => {
    const t = memoryChannel();
    expect(t.channel.answer('nobody', 'continue')).toBe(false);
  });

  it('keeps the worker awake for as long as it waits (well past the 30 s idle limit)', async () => {
    const t = memoryChannel();
    let answered = false;
    t.onSleep(() => {
      if (!answered && t.log.slept >= 120_000) {
        answered = true;
        t.channel.answer('r1', 'continue');
      }
    });
    expect(await t.channel.pause(info())).toBe('continue');
    expect(t.log.slept).toBeGreaterThanOrEqual(120_000);
    // One extension call per poll: never 30 s without one.
    expect(t.log.pings).toBeGreaterThanOrEqual(120_000 / POLL_MS);
  });

  it('a pause nobody answers stops the run after MAX_PAUSE_MS', async () => {
    const t = memoryChannel();
    expect(await t.channel.pause(info())).toBe('stop');
    expect(t.log.slept).toBeGreaterThanOrEqual(MAX_PAUSE_MS);
    expect(t.log.warnings[0]).toMatch(/nobody answered/);
    expect(t.stored()).toEqual([]);
  });

  it('several runs pause independently', async () => {
    const t = memoryChannel();
    const one = t.channel.pause(info({ runId: 'r1' }));
    const two = t.channel.pause(info({ runId: 'r2', nodeId: 'c', reason: 'error', error: 'boom' }));
    await t.whenListed('r1');
    await t.whenListed('r2');
    expect(t.stored().map((p) => p.runId).sort()).toEqual(['r1', 'r2']);
    t.channel.answer('r2', 'stop');
    expect(await two).toBe('stop');
    expect(t.stored().map((p) => p.runId)).toEqual(['r1']);
    t.channel.answer('r1', 'continue');
    expect(await one).toBe('continue');
    expect(t.stored()).toEqual([]);
  });

  it('does not highlight without a tab, or with a templated locator', async () => {
    const t = memoryChannel();
    const a = t.channel.pause(info({ runId: 'a', locator: '#x' }));
    const b = t.channel.pause(info({ runId: 'b', tabId: 1, locator: '{{selector}}' }));
    await t.whenListed('a');
    await t.whenListed('b');
    t.channel.answer('a', 'continue');
    t.channel.answer('b', 'continue');
    await Promise.all([a, b]);
    expect(t.log.highlights).toEqual([]);
  });

  it('clearStale drops pauses left by a worker that stopped, keeps live ones', async () => {
    const t = memoryChannel();
    const live = t.channel.pause(info({ runId: 'live' }));
    await t.whenListed('live');
    t.setStored([...t.stored(), { ...info({ runId: 'dead' }), workflowName: '', pausedAt: '' }]);
    await t.channel.clearStale();
    expect(t.stored().map((p) => p.runId)).toEqual(['live']);
    t.channel.answer('live', 'continue');
    await live;
  });
});

describe('the extension channel (storage.session bf:debug-pause)', () => {
  beforeEach(() => {
    fake.session = {};
    fake.acts = [];
  });

  it('stores the pause in storage.session and answers from bf:debug-answer / Stop', async () => {
    const waiting = debugChannel.pause(info({ runId: 'x', tabId: 3, locator: 'role=button[name="Buy"]' }));
    for (let i = 0; i < 200 && !(fake.session[DEBUG_PAUSE_KEY] as unknown[] | undefined)?.length; i += 1) await new Promise((r) => setTimeout(r, 1));
    expect(fake.session[DEBUG_PAUSE_KEY]).toEqual([expect.objectContaining({ runId: 'x', workflowName: 'Checkout' })]);
    expect(answerDebug('x', 'stop')).toBe(true);
    expect(await waiting).toBe('stop');
    expect(fake.session[DEBUG_PAUSE_KEY]).toEqual([]);
    expect(fake.acts).toEqual([
      { op: 'highlight', locator: 'role=button[name="Buy"]', label: 'BlockFlow: paused here' },
      { op: 'highlight', locator: 'role=button[name="Buy"]', clear: true },
    ]);
    expect(fake.pings).toBeGreaterThan(0);
  });

  it('clearStaleDebugPauses empties the list a previous worker left', async () => {
    fake.session[DEBUG_PAUSE_KEY] = [{ ...info({ runId: 'old' }), workflowName: 'W', pausedAt: '' }];
    await clearStaleDebugPauses();
    expect(fake.session[DEBUG_PAUSE_KEY]).toEqual([]);
  });
});

describe('a debug run through the engine and the channel', () => {
  const wf = () =>
    flow(
      [
        { id: 'a', type: 'log', config: { message: 'a' } },
        { id: 'b', type: 'log', config: { message: 'b' }, step: { pause: true } },
        { id: 'c', type: 'log', config: { message: 'c' } },
        { id: 'd', type: 'log', config: { message: 'd' } },
      ],
      [['a', 'b'], ['b', 'c'], ['c', 'd']],
    );

  it('Step pauses at the next block, Continue runs to the end; the list is empty afterwards', async () => {
    const t = memoryChannel();
    const host = new FakeHost();
    host.debug = t.channel;
    const running = harness(wf(), host).runner.runOnce({ debug: {} });
    await waitForAny(t);
    expect(t.stored()[0]).toMatchObject({ nodeId: 'b', reason: 'breakpoint' });
    t.channel.answer(t.stored()[0]!.runId, 'step');
    await waitFor(() => t.stored()[0]?.nodeId === 'c');
    expect(t.stored()[0]).toMatchObject({ nodeId: 'c', reason: 'step' });
    t.channel.answer(t.stored()[0]!.runId, 'continue');
    const record = await running;
    expect(record.status).toBe('passed');
    expect(record.steps.map((s) => s.nodeId)).toEqual(['a', 'b', 'c', 'd']);
    expect(t.stored()).toEqual([]);
  });

  it('Stop while paused cancels the run and cleans up', async () => {
    const t = memoryChannel();
    const host = new FakeHost();
    host.debug = t.channel;
    const running = harness(wf(), host).runner.runOnce({ debug: {} });
    const runId = await waitForAny(t);
    t.channel.answer(runId, 'stop');
    const record = await running;
    expect(record.status).toBe('cancelled');
    expect(record.steps.map((s) => [s.nodeId, s.status])).toEqual([['a', 'passed'], ['b', 'skipped']]);
    expect(t.stored()).toEqual([]);
  });

  async function waitFor(ok: () => boolean): Promise<void> {
    for (let i = 0; i < 2000 && !ok(); i += 1) await tick();
    expect(ok()).toBe(true);
  }
  async function waitForAny(t: ReturnType<typeof memoryChannel>): Promise<string> {
    await waitFor(() => t.stored().length > 0);
    return t.stored()[0]!.runId;
  }
});
