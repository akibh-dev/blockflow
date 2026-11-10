import { describe, expect, it, vi } from 'vitest';
import { createTrace } from '../../src/browser/trace';
import type { TraceDeps } from '../../src/browser/trace';
import { MAX_TRACE_IMAGES, parseTraceKey, traceEvictions, traceKey } from '../../src/browser/blobStore';
import type { TraceKey } from '../../src/browser/blobStore';
import { createTelemetry } from '../../src/browser/telemetry';
import type { M3Runtime } from '../../src/browser/m3Runtime';
import type { CdpListener } from '../../src/browser/cdpSessions';
import { FakeHost, flow, harness } from '../helpers/fakeHost';

vi.mock('wxt/browser', () => ({ browser: { runtime: { getManifest: () => ({ version: '9.9.9' }) } } }));

const info = { runId: 'r1', nodeId: 'click', blockType: 'click', tabId: 7, locator: '#save' };

function deps(overrides: Partial<TraceDeps> = {}) {
  let n = 0;
  const saved: string[] = [];
  const d = {
    runId: 'r1',
    shoot: vi.fn(async () => 'data:image/jpeg;base64,AAAA'),
    save: vi.fn(async (dataUrl: string) => { saved.push(dataUrl); n += 1; return `shot-${n}`; }),
    act: vi.fn(async (_tabId: number, request: { op: string }) =>
      request.op === 'box' ? { found: true, x: 10, y: 20, width: 30, height: 40, count: 1, visible: true } : { viewportWidth: 1280, viewportHeight: 800 }),
    url: vi.fn(async () => 'https://example.test/after'),
    ...overrides,
  } satisfies TraceDeps;
  return { d, saved };
}

describe('Host.trace (trace.ts)', () => {
  it('before: a screenshot of the step’s tab; after: screenshot, box, viewport, URL', async () => {
    const { d } = deps();
    const trace = createTrace(d);
    expect(await trace.before(info)).toEqual({ before: 'shot-1' });
    expect(await trace.after({ ...info, status: 'passed', before: 'shot-1' })).toEqual({
      after: 'shot-2',
      box: { x: 10, y: 20, width: 30, height: 40 },
      viewport: { width: 1280, height: 800 },
      url: 'https://example.test/after',
    });
    expect(d.act).toHaveBeenCalledWith(7, { op: 'box', locator: '#save' }, expect.any(Number));
    // No telemetry: the debugger is never offered for the image.
    expect(d.shoot).toHaveBeenCalledWith(7, false);
  });

  it('skips quietly without a tab, and never throws when every part fails', async () => {
    const { d } = deps();
    const trace = createTrace(d);
    expect(await trace.before({ ...info, tabId: undefined })).toBeUndefined();
    expect(await trace.after({ ...info, tabId: undefined, status: 'passed' })).toBeUndefined();
    expect(d.shoot).not.toHaveBeenCalled();

    const broken = createTrace(deps({
      shoot: async () => { throw new Error('no capture'); },
      act: async () => { throw new Error('restricted page'); },
      url: async () => { throw new Error('tab closed'); },
    }).d);
    expect(await broken.before(info)).toBeUndefined();
    expect(await broken.after({ ...info, status: 'failed' })).toBeUndefined();
  });

  it('leaves out a box when the element is gone or has no size, and images over the run cap', async () => {
    const { d } = deps({ act: vi.fn(async () => ({ found: false, count: 0 })), save: vi.fn(async () => null) });
    expect(await createTrace(d).after({ ...info, status: 'passed' })).toEqual({ url: 'https://example.test/after' });
    const hidden = deps({ act: vi.fn(async () => ({ found: true, x: 0, y: 0, width: 0, height: 0, count: 1, visible: false })) }).d;
    expect(await createTrace(hidden).after({ ...info, status: 'passed' })).not.toHaveProperty('box');
  });

  it('no locator: no page-agent call', async () => {
    const { d } = deps();
    await createTrace(d).after({ ...info, locator: undefined, status: 'passed' });
    expect(d.act).not.toHaveBeenCalled();
  });

  it('network summary only through a session the run already has', async () => {
    const telemetry = { hasSession: vi.fn(() => true), beginStepNetwork: vi.fn(async () => true), finishStepNetwork: vi.fn(() => ({ requests: 2, failed: 1 })) };
    const { d } = deps({ telemetry });
    const trace = createTrace(d);
    await trace.before(info);
    expect(telemetry.beginStepNetwork).toHaveBeenCalledWith(7, 'click');
    expect(d.shoot).toHaveBeenCalledWith(7, true);
    expect(await trace.after({ ...info, status: 'passed' })).toMatchObject({ network: { requests: 2, failed: 1 } });
    expect(telemetry.finishStepNetwork).toHaveBeenCalledWith(7, 'click');
  });
});

describe('telemetry: per-step network summary', () => {
  function setup() {
    const listeners = new Map<number, Set<CdpListener>>();
    const send = vi.fn(async (_method: string, _params?: Record<string, unknown>): Promise<unknown> => ({}));
    let telemetry!: ReturnType<typeof createTelemetry>;
    const withTab = vi.fn(async (tabId: number, fn: (s: typeof send) => Promise<unknown>) => { await telemetry.attach(tabId, send); return fn(send); });
    const runtime: M3Runtime = {
      runId: 'r', isClosed: () => false, claim: () => {},
      withTab: withTab as unknown as M3Runtime['withTab'],
      cleanupTab: async (_tabId, fn) => fn(send),
      subscribe: (tabId, listener) => {
        const list = listeners.get(tabId) ?? new Set(); list.add(listener); listeners.set(tabId, list);
        return () => { list.delete(listener); };
      },
    };
    telemetry = createTelemetry(runtime);
    const event = (method: string, params: object) => { for (const listener of listeners.get(7) ?? []) listener(method, params); };
    return { telemetry, send, withTab, event };
  }

  it('does nothing (and never attaches) when the run has no session on the tab', async () => {
    const h = setup();
    expect(h.telemetry.hasSession(7)).toBe(false);
    expect(await h.telemetry.beginStepNetwork(7, 'n')).toBe(false);
    expect(h.withTab).not.toHaveBeenCalled();
    expect(h.telemetry.finishStepNetwork(7, 'n')).toBeUndefined();
  });

  it('counts requests and failures and names the slowest, metadata only', async () => {
    const h = setup();
    await h.telemetry.attach(7, h.send);
    expect(h.telemetry.hasSession(7)).toBe(true);
    expect(await h.telemetry.beginStepNetwork(7, 'n')).toBe(true);
    expect(h.send).toHaveBeenCalledWith('Network.enable', {});
    const req = (id: string, url: string, t: number) => h.event('Network.requestWillBeSent', { requestId: id, timestamp: t, request: { method: 'GET', url } });
    req('a', 'https://example.test/a?token=secret', 1);
    req('b', 'https://example.test/b', 1);
    req('c', 'https://example.test/c', 1);
    h.event('Network.responseReceived', { requestId: 'a', response: { status: 200 } });
    h.event('Network.loadingFinished', { requestId: 'a', timestamp: 1.5 });
    h.event('Network.responseReceived', { requestId: 'b', response: { status: 404 } });
    h.event('Network.loadingFinished', { requestId: 'b', timestamp: 1.1 });
    h.event('Network.loadingFailed', { requestId: 'c', timestamp: 1.2, errorText: 'net::ERR' });
    const summary = h.telemetry.finishStepNetwork(7, 'n');
    expect(summary).toMatchObject({ requests: 3, failed: 2 });
    expect(summary?.slowest?.[0]).toEqual({ url: 'https://example.test/a?token=%5Bredacted%5D', method: 'GET', status: 200, ms: 500 });
    expect(summary?.slowest).toHaveLength(3);
    // Closed: later requests are not counted anywhere.
    req('d', 'https://example.test/d', 2);
    expect(h.telemetry.finishStepNetwork(7, 'n')).toBeUndefined();
  });
});

describe('trace image storage bounds (blobStore)', () => {
  it('keys carry time, run and size, and sort after screenshot UUIDs', () => {
    const key = traceKey('run|1', 1_700_000_000_000, 1234, 'x');
    expect(parseTraceKey(key)).toEqual({ id: key, ts: 1_700_000_000_000, runId: 'run_1', bytes: 1234 });
    expect(parseTraceKey('2f1c-uuid')).toBeUndefined();
    expect(key > 'ffffffff-ffff-4fff-bfff-ffffffffffff').toBe(true);
  });

  it('evicts whole runs, oldest first, never the current run', () => {
    const keys: TraceKey[] = [];
    const add = (runId: string, ts: number, count: number, bytes = 10) => {
      for (let i = 0; i < count; i += 1) keys.push({ id: `${runId}-${i}`, ts: ts + i, runId, bytes });
    };
    add('old', 100, 3);
    add('middle', 200, 3);
    add('current', 50, 3); // started earliest, but it is the one being saved
    expect(traceEvictions(keys, 'current', { images: 9, bytes: 1_000 })).toEqual([]);
    expect(traceEvictions(keys, 'current', { images: 7, bytes: 1_000 })).toEqual(['old-0', 'old-1', 'old-2']);
    expect(traceEvictions(keys, 'current', { images: 1, bytes: 1_000 })).toHaveLength(6);
    expect(traceEvictions(keys, 'current', { images: 100, bytes: 65 })).toEqual(['old-0', 'old-1', 'old-2']);
    expect(MAX_TRACE_IMAGES).toBeGreaterThan(0);
  });
});

describe('engine + trace: an untraced run calls it only for steps with step.trace', () => {
  it('only the step with step.trace is traced', async () => {
    const host = new FakeHost();
    const before = vi.fn(async () => ({ before: 'b' }));
    const after = vi.fn(async () => ({ url: 'u' }));
    host.trace = { before, after };
    const h = harness(flow([
      { id: 'a', type: 'log', config: { message: 'a' } },
      { id: 'b', type: 'log', config: { message: 'b' }, step: { trace: true } },
    ], [['a', 'b']]), host);
    const run = await h.runner.runOnce();
    expect(before).toHaveBeenCalledTimes(1);
    expect(run.steps.find((s) => s.nodeId === 'b')?.trace).toEqual({ before: 'b', url: 'u' });
    expect(run.steps.find((s) => s.nodeId === 'a')?.trace).toBeUndefined();
  });
});
