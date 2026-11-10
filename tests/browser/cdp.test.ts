import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  const api = { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(), onEvent: event(), onDetach: event() };
  const state: { api: typeof api | undefined; granted: boolean } = { api: undefined, granted: false };
  const browser = {
    get debugger() { return state.api; },
    permissions: { contains: vi.fn(async () => state.granted), onAdded: event(), onRemoved: event() },
    tabs: { onRemoved: event() },
  };
  return { api, browser, state };
});
vi.mock('wxt/browser', () => ({ browser: mock.browser }));

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  mock.state.api = undefined; mock.state.granted = false;
  mock.browser.permissions.contains.mockImplementation(async () => mock.state.granted);
  mock.api.attach.mockResolvedValue(undefined); mock.api.detach.mockResolvedValue(undefined);
  mock.api.sendCommand.mockResolvedValue({});
});

describe('debugger browser adapter', () => {
  it('registers permission/tab listeners synchronously and installs optional API listeners on grant', async () => {
    const cdp = await import('../../src/browser/cdp');
    cdp.initialiseDebuggerSessions();
    expect(mock.browser.permissions.onAdded.addListener).toHaveBeenCalledOnce();
    expect(mock.browser.permissions.onRemoved.addListener).toHaveBeenCalledOnce();
    expect(mock.browser.tabs.onRemoved.addListener).toHaveBeenCalledOnce();
    expect(mock.api.onEvent.addListener).not.toHaveBeenCalled();
    mock.state.api = mock.api; mock.state.granted = true;
    mock.browser.permissions.onAdded.addListener.mock.calls[0]?.[0]({ permissions: ['debugger'] });
    cdp.initialiseDebuggerSessions();
    expect(mock.api.onEvent.addListener).toHaveBeenCalledOnce();
    expect(mock.api.onDetach.addListener).toHaveBeenCalledOnce();
    cdp.startDebuggerRun('run');
    const listener = vi.fn();
    await cdp.withDebugger(7, async () => {
      const unsubscribe = cdp.onDebuggerEvent(7, listener);
      mock.api.onEvent.addListener.mock.calls[0]?.[0]({ tabId: 7 }, 'Network.loadingFinished', { requestId: 'r' });
      unsubscribe();
    }, 'run');
    expect(listener).toHaveBeenCalledWith('Network.loadingFinished', { requestId: 'r' });
    expect(await cdp.finishDebuggerRun('run')).toEqual({ usedDebugger: true });
  });

  it('fails with permission.missing when the optional API is unavailable', async () => {
    const cdp = await import('../../src/browser/cdp');
    cdp.initialiseDebuggerSessions();
    await expect(cdp.withDebugger(7, async () => {})).rejects.toMatchObject({ code: 'permission.missing' });
    expect(mock.api.attach).not.toHaveBeenCalled();
  });

  it('invalidates a transport-detached session even when no onDetach event arrives', async () => {
    mock.state.api = mock.api; mock.state.granted = true;
    const cdp = await import('../../src/browser/cdp'); cdp.initialiseDebuggerSessions();
    cdp.startDebuggerRun('run'); await cdp.withDebugger(7, async () => {}, 'run');
    mock.api.sendCommand.mockRejectedValueOnce(new Error('Debugger is not attached to the tab with id: 7.'));
    await expect(cdp.withDebugger(7, (send) => send('Page.getLayoutMetrics'), 'run')).rejects.toThrow('detached');
    expect(await cdp.finishDebuggerRun('run')).toEqual({ usedDebugger: true });
    expect(mock.api.detach).not.toHaveBeenCalled();
  });

  it('invalidates sessions on tab removal and permission revocation', async () => {
    mock.state.api = mock.api; mock.state.granted = true;
    const cdp = await import('../../src/browser/cdp'); cdp.initialiseDebuggerSessions();
    cdp.startDebuggerRun('run');
    await cdp.withDebugger(7, async () => {}, 'run'); await cdp.withDebugger(8, async () => {}, 'run');
    mock.browser.tabs.onRemoved.addListener.mock.calls[0]?.[0](7);
    mock.browser.permissions.onRemoved.addListener.mock.calls[0]?.[0]({ permissions: ['debugger'] });
    await expect(cdp.withDebugger(7, (send) => send('Page.getLayoutMetrics'), 'run')).rejects.toThrow('detached');
    await expect(cdp.withDebugger(8, (send) => send('Page.getLayoutMetrics'), 'run')).rejects.toThrow('detached');
    await cdp.finishDebuggerRun('run'); expect(mock.api.detach).not.toHaveBeenCalled();
  });

  it('treats an already-closed tab as cleaned up, but surfaces other detach failures', async () => {
    mock.state.api = mock.api; mock.state.granted = true;
    const cdp = await import('../../src/browser/cdp'); cdp.initialiseDebuggerSessions();
    mock.api.detach.mockRejectedValueOnce(new Error('No tab with given id 7'));
    await cdp.withDebugger(7, async () => {});
    mock.api.detach.mockRejectedValueOnce(new Error('Unexpected transport failure'));
    await expect(cdp.withDebugger(8, async () => {})).rejects.toThrow('Unexpected transport failure');
  });
});
