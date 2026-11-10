import { describe, expect, it, vi } from 'vitest';
import { DebuggerSessions } from '../../src/browser/cdpSessions';
import type { CdpSend } from '../../src/browser/cdpSessions';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  const port = {
    available: vi.fn(async () => true),
    attach: vi.fn(async (_tab: number) => {}),
    detach: vi.fn(async (_tab: number) => {}),
    send: vi.fn(async (_tab: number, _method: string, _params?: Record<string, unknown>): Promise<unknown> => ({})),
  };
  const sessions = new DebuggerSessions(port);
  // Exercise a detach event racing with a new acquisition. API detach need not emit one.
  port.detach.mockImplementation(async (tab) => sessions.detached(tab));
  return { sessions, port };
}

describe('debugger session ownership', () => {
  it('initialises run diagnostics once before any callback and retries failed setup', async () => {
    const { sessions, port } = setup();
    const setupRun = vi.fn(async (_tab: number, send: CdpSend) => { await send('Runtime.enable'); });
    setupRun.mockRejectedValueOnce(new Error('setup failed'));
    sessions.startRun('run', setupRun);
    const callback = vi.fn(async () => {});
    await expect(sessions.withSession(1, callback, 'run')).rejects.toThrow('setup failed');
    expect(callback).not.toHaveBeenCalled();
    await Promise.all([sessions.withSession(1, callback, 'run'), sessions.withSession(1, callback, 'run')]);
    expect(setupRun).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(port.attach).toHaveBeenCalledTimes(1);
    await sessions.finishRun('run');
  });
  it('does not attach for a run that never needs CDP', async () => {
    const { sessions, port } = setup();
    sessions.startRun('plain');
    expect(await sessions.finishRun('plain')).toEqual({});
    expect(port.available).not.toHaveBeenCalled();
    expect(port.attach).not.toHaveBeenCalled();
  });

  it('retains one attachment across steps, and releases it before finish resolves', async () => {
    const { sessions, port } = setup();
    sessions.startRun('run');
    await sessions.withSession(1, (send) => send('Input.insertText', { text: 'first' }), 'run');
    await sessions.withSession(1, (send) => send('Page.getLayoutMetrics'), 'run');
    expect(port.attach).toHaveBeenCalledTimes(1);
    expect(port.detach).not.toHaveBeenCalled();
    expect(await sessions.finishRun('run')).toEqual({ usedDebugger: true });
    expect(port.detach).toHaveBeenCalledExactlyOnceWith(1);
    expect(await sessions.finishRun('run')).toEqual({});
  });

  it('keeps independent tabs and concurrent runs referenced separately', async () => {
    const { sessions, port } = setup();
    sessions.startRun('parent'); sessions.startRun('child');
    await Promise.all([
      sessions.withSession(1, async () => {}, 'parent'),
      sessions.withSession(1, async () => {}, 'child'),
      sessions.withSession(2, async () => {}, 'parent'),
    ]);
    expect(port.attach.mock.calls).toEqual([[1], [2]]);
    await sessions.finishRun('parent');
    expect(port.detach.mock.calls).toEqual([[2]]);
    await sessions.withSession(1, (send) => send('Page.getLayoutMetrics'), 'child');
    await sessions.finishRun('child');
    expect(port.detach.mock.calls).toEqual([[2], [1]]);
  });

  it('does not detach overlapping unscoped actions until the last one finishes', async () => {
    const { sessions, port } = setup();
    const first = deferred(); const second = deferred(); const entered = deferred();
    const a = sessions.withSession(1, () => first.promise);
    const b = sessions.withSession(1, () => { entered.resolve(); return second.promise; });
    await entered.promise;
    first.resolve(); await a;
    expect(port.attach).toHaveBeenCalledTimes(1);
    expect(port.detach).not.toHaveBeenCalled();
    second.resolve(); await b;
    expect(port.detach).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('cleans up an unscoped action that throws', async () => {
    const { sessions, port } = setup();
    await expect(sessions.withSession(1, async () => { throw new Error('bad command'); })).rejects.toThrow('bad command');
    expect(port.detach).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('rejects unsupported browsers/missing permission without attaching', async () => {
    const { sessions, port } = setup();
    port.available.mockResolvedValue(false);
    await expect(sessions.withSession(1, async () => {})).rejects.toMatchObject({ code: 'permission.missing' });
    expect(port.attach).not.toHaveBeenCalled(); expect(port.detach).not.toHaveBeenCalled();
  });

  it('never borrows or detaches an attachment owned by DevTools or another extension', async () => {
    const { sessions, port } = setup();
    port.attach.mockRejectedValueOnce(new Error('Another debugger is already attached'));
    await expect(sessions.withSession(1, async () => {})).rejects.toThrow('already attached');
    expect(port.detach).not.toHaveBeenCalled(); expect(port.send).not.toHaveBeenCalled();
    await sessions.withSession(1, async () => {});
    expect(port.attach).toHaveBeenCalledTimes(2);
    expect(port.detach).toHaveBeenCalledTimes(1);
  });

  it('allows a failed permission check to be retried in the same run', async () => {
    const { sessions, port } = setup();
    sessions.startRun('run'); port.available.mockResolvedValueOnce(false);
    await expect(sessions.withSession(1, async () => {}, 'run')).rejects.toMatchObject({ code: 'permission.missing' });
    await sessions.withSession(1, async () => {}, 'run');
    expect(await sessions.finishRun('run')).toEqual({ usedDebugger: true });
    expect(port.attach).toHaveBeenCalledTimes(1);
  });

  it('forbids new commands/acquisitions after run finish, even with a saved sender', async () => {
    const { sessions, port } = setup();
    sessions.startRun('run'); let lateSend!: CdpSend;
    await sessions.withSession(1, async (send) => { lateSend = send; }, 'run');
    await sessions.finishRun('run');
    await expect(lateSend('Input.insertText')).rejects.toThrow('run has ended');
    await expect(sessions.withSession(2, async () => {}, 'run')).rejects.toThrow('run has ended');
    expect(port.attach).toHaveBeenCalledTimes(1); expect(port.send).not.toHaveBeenCalled();
  });

  it('closes a run while acquisition is pending, releasing the late attachment without running its callback', async () => {
    const { sessions, port } = setup();
    const attached = deferred(); const attaching = deferred();
    port.attach.mockImplementation(async () => { attaching.resolve(); await attached.promise; });
    sessions.startRun('run'); const callback = vi.fn(async () => {});
    const action = sessions.withSession(1, callback, 'run');
    const rejected = expect(action).rejects.toThrow('run has ended');
    await attaching.promise;
    const finish = sessions.finishRun('run');
    await expect(sessions.withSession(2, callback, 'run')).rejects.toThrow('run has ended');
    attached.resolve(); await rejected;
    expect(await finish).toEqual({ usedDebugger: true });
    expect(callback).not.toHaveBeenCalled(); expect(port.detach).toHaveBeenCalledTimes(1);
  });

  it('serialises a new attachment after a previous detach, without invalidating the new owner', async () => {
    const { sessions, port } = setup();
    const detaching = deferred(); const finishDetach = deferred();
    port.detach.mockImplementationOnce(async (tab) => {
      detaching.resolve(); await finishDetach.promise; sessions.detached(tab);
    });
    const a = sessions.withSession(1, async () => {});
    await detaching.promise;
    const b = sessions.withSession(1, (send) => send('Page.getLayoutMetrics'));
    expect(port.attach).toHaveBeenCalledTimes(1);
    finishDetach.resolve(); await Promise.all([a, b]);
    expect(port.attach).toHaveBeenCalledTimes(2); expect(port.send).toHaveBeenCalledTimes(1);
  });

  it('invalidates a user-detached/closed tab without detaching a later session', async () => {
    const { sessions, port } = setup();
    sessions.startRun('old'); await sessions.withSession(1, async () => {}, 'old');
    sessions.detached(1);
    await expect(sessions.withSession(1, (send) => send('Page.getLayoutMetrics'), 'old')).rejects.toThrow('detached');
    sessions.startRun('new'); await sessions.withSession(1, async () => {}, 'new');
    await sessions.finishRun('old'); expect(port.detach).not.toHaveBeenCalled();
    await sessions.finishRun('new'); expect(port.detach).toHaveBeenCalledTimes(1);
  });

  it('enables a default domain lazily once per shared attachment', async () => {
    const { sessions, port } = setup();
    sessions.startRun('run');
    const command = (send: CdpSend) => send('Network.enable', {});
    await Promise.all([sessions.withSession(1, command, 'run'), sessions.withSession(1, command, 'run')]);
    await sessions.withSession(1, command, 'run');
    expect(port.send).toHaveBeenCalledExactlyOnceWith(1, 'Network.enable', {});
    await sessions.finishRun('run');
    await sessions.withSession(1, command);
    expect(port.send).toHaveBeenCalledTimes(2);
  });

  it('retries failed domain enable and does not cache custom options', async () => {
    const { sessions, port } = setup();
    sessions.startRun('run'); port.send.mockRejectedValueOnce(new Error('try again'));
    await expect(sessions.withSession(1, (send) => send('Network.enable'), 'run')).rejects.toThrow('try again');
    await sessions.withSession(1, (send) => send('Network.enable'), 'run');
    await sessions.withSession(1, (send) => send('Network.enable', { maxTotalBufferSize: 100 }), 'run');
    await sessions.withSession(1, (send) => send('Network.disable'), 'run');
    await sessions.withSession(1, (send) => send('Network.enable'), 'run');
    expect(port.send).toHaveBeenCalledTimes(5); await sessions.finishRun('run');
  });

  it('multiplexes events by tab and clears subscriptions when released/detached', async () => {
    const { sessions } = setup(); const a = vi.fn(); const b = vi.fn();
    sessions.startRun('run');
    await sessions.withSession(1, async () => {}, 'run');
    await sessions.withSession(2, async () => {}, 'run');
    const unsubscribe = sessions.subscribe(1, a); sessions.subscribe(2, b);
    sessions.event(1, 'Network.loadingFinished', { requestId: 'r' });
    expect(a).toHaveBeenCalledOnce(); expect(b).not.toHaveBeenCalled();
    unsubscribe(); sessions.event(1, 'Network.loadingFinished'); expect(a).toHaveBeenCalledOnce();
    sessions.detached(2); sessions.event(2, 'Network.loadingFinished'); expect(b).not.toHaveBeenCalled();
    await sessions.finishRun('run');
    expect(() => sessions.subscribe(1, a)).toThrow('detached');
  });

  it('reports detach failures instead of publishing a successful cleanup', async () => {
    const { sessions, port } = setup();
    sessions.startRun('run'); await sessions.withSession(1, async () => {}, 'run');
    port.detach.mockRejectedValueOnce(new Error('detach failed'));
    await expect(sessions.finishRun('run')).rejects.toThrow('detach failed');
    await expect(sessions.withSession(1, async () => {}, 'run')).rejects.toThrow('run has ended');
  });
});
