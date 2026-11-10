import { describe, expect, it, vi } from 'vitest';
import { backoffMs, CONNECTED_AFTER_MS, createBridgeConnection, MAX_BACKOFF_MS, MAX_RECONNECTS } from '../../src/browser/bridge';
import type { BridgeStatus, NativePort } from '../../src/browser/bridge';
import type { RpcResponse } from '../../src/core/bridgeProtocol';

vi.mock('wxt/browser', () => ({ browser: { runtime: {}, storage: { local: {}, session: {} } } }));

class FakePort implements NativePort {
  readonly posted: unknown[] = [];
  disconnected = false;
  private messageListeners: ((message: unknown) => void)[] = [];
  private disconnectListeners: ((port: unknown) => void)[] = [];
  error?: { message: string };
  postMessage(message: unknown) {
    this.posted.push(message);
  }
  disconnect() {
    this.disconnected = true;
  }
  onMessage = { addListener: (listener: (message: unknown) => void) => void this.messageListeners.push(listener) };
  onDisconnect = { addListener: (listener: (port: unknown) => void) => void this.disconnectListeners.push(listener) };
  receive(message: unknown) {
    for (const listener of this.messageListeners) listener(message);
  }
  /** The host went away (or was never there). */
  close(message?: string) {
    if (message) this.error = { message };
    for (const listener of this.disconnectListeners) listener(this);
  }
}

function setup(options: { failConnect?: boolean } = {}) {
  const ports: FakePort[] = [];
  const statuses: BridgeStatus[] = [];
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  const respond = vi.fn(async (request: { id: string | number; method: string }, notify: (method: 'run.started', params: never) => void): Promise<RpcResponse> => {
    notify('run.started', { requestId: request.id, runId: 'r', workflowName: 'w' } as never);
    return { jsonrpc: '2.0', id: request.id, result: { workflows: [] } } as RpcResponse;
  });
  const connection = createBridgeConnection({
    connect: () => {
      if (options.failConnect) throw new Error('The nativeMessaging permission is not granted.');
      const port = new FakePort();
      ports.push(port);
      return port;
    },
    disconnectReason: (port) => (port as FakePort).error?.message,
    respond,
    setStatus: (status) => statuses.push(status),
    after: (ms, fn) => {
      const timer = { ms, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    now: () => 0,
  });
  const fire = (ms: number) => {
    const timer = timers.find((candidate) => candidate.ms === ms && !candidate.cancelled);
    if (!timer) throw new Error(`no pending ${ms} ms timer`);
    timer.cancelled = true;
    timer.fn();
  };
  return { connection, ports, statuses, timers, respond, fire };
}

describe('bridge connection', () => {
  it('connects when enabled, counts as connected after a quiet second or a message', () => {
    const h = setup();
    h.connection.enable();
    h.connection.enable(); // idempotent
    expect(h.ports).toHaveLength(1);
    expect(h.connection.state).toBe('connecting');
    h.fire(CONNECTED_AFTER_MS);
    expect(h.connection.state).toBe('connected');
    expect(h.statuses.map((status) => status.state)).toEqual(['connecting', 'connected']);
  });

  it('answers requests on the port, notifications first, then the response', async () => {
    const h = setup();
    h.connection.enable();
    h.ports[0]!.receive({ jsonrpc: '2.0', id: 5, method: 'list', params: {} });
    expect(h.connection.state).toBe('connected');
    await vi.waitFor(() => expect(h.ports[0]!.posted).toHaveLength(2));
    expect(h.ports[0]!.posted[0]).toEqual({ jsonrpc: '2.0', method: 'run.started', params: { requestId: 5, runId: 'r', workflowName: 'w' } });
    expect(h.ports[0]!.posted[1]).toEqual({ jsonrpc: '2.0', id: 5, result: { workflows: [] } });
    // Not a request: ignored.
    h.ports[0]!.receive({ jsonrpc: '2.0', method: 'something' });
    h.ports[0]!.receive('garbage');
    expect(h.respond).toHaveBeenCalledTimes(1);
  });

  it('reconnects with backoff while on, and records why the port closed', () => {
    const h = setup();
    h.connection.enable();
    h.ports[0]!.close('Specified native messaging host not found.');
    expect(h.connection.state).toBe('waiting');
    expect(h.statuses.at(-1)).toMatchObject({ state: 'waiting', error: 'Specified native messaging host not found.', attempts: 1 });
    h.fire(backoffMs(1));
    expect(h.ports).toHaveLength(2);
    h.ports[1]!.close();
    expect(h.statuses.at(-1)).toMatchObject({ attempts: 2, error: 'The native host closed the connection.' });
    h.fire(backoffMs(2));
    expect(h.ports).toHaveLength(3);
    // A connection that lasted resets the backoff.
    h.fire(CONNECTED_AFTER_MS);
    expect(h.statuses.at(-1)).toEqual({ state: 'connected', since: new Date(0).toISOString() });
  });

  it('backoff doubles up to the cap', () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffMs(20)).toBe(MAX_BACKOFF_MS);
  });

  it('switching off sends bridge.disabled, disconnects and stops reconnecting', () => {
    const h = setup();
    h.connection.enable();
    const port = h.ports[0]!;
    h.connection.disable();
    expect(port.posted).toEqual([{ jsonrpc: '2.0', method: 'bridge.disabled', params: {} }]);
    expect(port.disconnected).toBe(true);
    expect(h.connection.state).toBe('off');
    port.close(); // the browser's disconnect event afterwards changes nothing
    expect(h.connection.state).toBe('off');
    expect(h.timers.filter((timer) => !timer.cancelled && timer.ms !== CONNECTED_AFTER_MS)).toHaveLength(0);
  });

  it('switching off while waiting to reconnect cancels the retry', () => {
    const h = setup({ failConnect: true });
    h.connection.enable();
    expect(h.statuses.at(-1)).toMatchObject({ state: 'waiting', error: 'The nativeMessaging permission is not granted.' });
    h.connection.disable();
    expect(h.timers.every((timer) => timer.cancelled)).toBe(true);
    expect(h.connection.state).toBe('off');
  });

  it('gives up after MAX_RECONNECTS quick closes (host missing, or another host owns the socket)', () => {
    const h = setup();
    h.connection.enable();
    for (let attempt = 1; attempt < MAX_RECONNECTS; attempt += 1) {
      h.ports.at(-1)!.close('Native host has exited.');
      h.fire(backoffMs(attempt));
    }
    h.ports.at(-1)!.close('Native host has exited.');
    expect(h.ports).toHaveLength(MAX_RECONNECTS);
    expect(h.connection.state).toBe('failed');
    expect(h.statuses.at(-1)?.error).toMatch(/could not start \(Native host has exited\.\).*another browser/);
    expect(h.timers.filter((timer) => !timer.cancelled && timer.ms !== CONNECTED_AFTER_MS)).toHaveLength(0);
    // Off and on again retries.
    h.connection.disable();
    h.connection.enable();
    expect(h.ports).toHaveLength(MAX_RECONNECTS + 1);
  });
});
