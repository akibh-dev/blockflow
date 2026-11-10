import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { M3Runtime } from '../../src/browser/m3Runtime';
import { FakeHost } from '../helpers/fakeHost';

const mock = vi.hoisted(() => ({
  start: vi.fn(), finish: vi.fn(), send: vi.fn(), withDebugger: vi.fn(),
  routes: vi.fn(), environment: vi.fn(), telemetry: vi.fn(),
}));
vi.mock('../../src/browser/cdp', () => ({
  startDebuggerRun: mock.start, finishDebuggerRun: mock.finish, withDebugger: mock.withDebugger, onDebuggerEvent: vi.fn(),
}));
vi.mock('../../src/browser/routes', () => ({ createRoutes: mock.routes }));
vi.mock('../../src/browser/environment', () => ({ createEnvironment: mock.environment }));
vi.mock('../../src/browser/telemetry', () => ({ createTelemetry: mock.telemetry }));

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  mock.withDebugger.mockImplementation(async (_tab, fn) => fn(mock.send));
  mock.finish.mockResolvedValue({ usedDebugger: true });
  mock.routes.mockImplementation((runtime: M3Runtime) => ({
    apply: vi.fn(async (tabId: number) => { runtime.claim(tabId, 'route'); return { rules: 1, backend: 'cdp' }; }),
    finish: vi.fn(async () => {}),
  }));
  mock.environment.mockImplementation((runtime: M3Runtime) => ({
    emulate: vi.fn(async (tabId: number) => { runtime.claim(tabId, 'emulation'); }),
    clearSiteData: vi.fn(async () => {}), finish: vi.fn(async () => {}),
  }));
  mock.telemetry.mockImplementation(() => ({
    attach: vi.fn(async () => {}), har: vi.fn(), console: vi.fn(), beginStep: vi.fn(), finishStep: vi.fn(() => []), finish: vi.fn(async () => {}),
  }));
});

describe('M3 Host integration', () => {
  it('starts automatic console setup for all run CDP operations and delegates diagnostics', async () => {
    const { createRunHost } = await import('../../src/browser/m3Host');
    const host = createRunHost(new FakeHost(), 'run');
    const capture = mock.telemetry.mock.results[0]!.value;
    const setup = mock.start.mock.calls[0]![1];
    await setup(7, mock.send);
    expect(capture.attach).toHaveBeenCalledWith(7, mock.send);
    host.diagnostics?.beginStep('node'); host.diagnostics?.finishStep('node');
    expect(capture.beginStep).toHaveBeenCalledWith('node');
    expect(capture.finishStep).toHaveBeenCalledWith('node');
    await host.finishRun?.('run');
  });

  it('closes every feature before debugger release, even when one cleanup rejects', async () => {
    const { createRunHost } = await import('../../src/browser/m3Host');
    const host = createRunHost(new FakeHost(), 'run');
    const routes = mock.routes.mock.results[0]!.value;
    routes.finish.mockRejectedValue(new Error('route cleanup failed'));
    await expect(host.finishRun?.('run')).rejects.toThrow('route cleanup failed');
    expect(mock.environment.mock.results[0]!.value.finish).toHaveBeenCalledOnce();
    expect(mock.telemetry.mock.results[0]!.value.finish).toHaveBeenCalledOnce();
    expect(mock.finish).toHaveBeenCalledExactlyOnceWith('run');
  });

  it('rejects late mutations, allows cleanup send, and makes cleanup idempotent', async () => {
    const { createRunHost } = await import('../../src/browser/m3Host');
    const host = createRunHost(new FakeHost(), 'run');
    const runtime = mock.routes.mock.calls[0]![0] as M3Runtime;
    mock.routes.mock.results[0]!.value.finish.mockImplementation(async () => {
      expect(runtime.isClosed()).toBe(true);
      await runtime.cleanupTab(7, (send) => send('Fetch.disable'));
    });
    const a = host.finishRun?.('run'); const b = host.finishRun?.('run');
    await Promise.all([a, b]);
    expect(mock.finish).toHaveBeenCalledOnce();
    expect(mock.send).toHaveBeenCalledWith('Fetch.disable');
    expect(() => runtime.withTab(7, async () => {})).toThrow('run has ended');
    expect(() => host.network.route(7, { action: 'clear', rules: [], backend: 'cdp' })).toThrow('run has ended');
  });

  it('prevents concurrent runs overriding a shared tab and releases claims after failure', async () => {
    const { createRunHost } = await import('../../src/browser/m3Host');
    const a = createRunHost(new FakeHost(), 'a'); const b = createRunHost(new FakeHost(), 'b');
    await a.network.route(7, { action: 'add', rules: [], backend: 'cdp' });
    await expect(b.environment.emulate(7, { action: 'set', device: '' })).rejects.toThrow('Another run owns');
    mock.routes.mock.results[0]!.value.finish.mockRejectedValue(new Error('cleanup failed'));
    await expect(a.finishRun?.('a')).rejects.toThrow('cleanup failed');
    await b.environment.emulate(7, { action: 'set', device: '' });
    await b.finishRun?.('b');
  });
});
