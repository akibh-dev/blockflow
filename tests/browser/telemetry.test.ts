import { describe, expect, it, vi } from 'vitest';
import { createTelemetry, MAX_CONSOLE_ENTRIES, MAX_HAR_ENTRIES, MAX_STEP_CONSOLE_ENTRIES } from '../../src/browser/telemetry';
import type { M3Runtime } from '../../src/browser/m3Runtime';
import type { CdpListener } from '../../src/browser/cdpSessions';

vi.mock('wxt/browser', () => ({ browser: { runtime: { getManifest: () => ({ version: '9.9.9' }) } } }));

function setup() {
  const listeners = new Map<number, Set<CdpListener>>();
  const send = vi.fn(async (_method: string, _params?: Record<string, unknown>): Promise<unknown> => ({}));
  let closed = false;
  let telemetry!: ReturnType<typeof createTelemetry>;
  const runtime: M3Runtime = {
    runId: 'test-run', isClosed: () => closed, claim: () => {},
    withTab: async (tabId, fn) => { await telemetry.attach(tabId, send); return fn(send); },
    cleanupTab: async (_tabId, fn) => fn(send),
    subscribe: (tabId, listener) => {
      const list = listeners.get(tabId) ?? new Set(); list.add(listener); listeners.set(tabId, list);
      return () => { list.delete(listener); };
    },
  };
  telemetry = createTelemetry(runtime);
  const event = (tabId: number, method: string, params: object) => {
    for (const listener of listeners.get(tabId) ?? []) listener(method, params);
  };
  const log = (tabId: number, text: string, type = 'log') => event(tabId, 'Runtime.consoleAPICalled', { type, args: [{ value: text }], timestamp: Date.now() });
  const request = (id: string, url = `https://example.test/${id}`, tabId = 7, extra = {}) => event(tabId, 'Network.requestWillBeSent', { requestId: id, timestamp: 1, wallTime: 1700000000, request: { method: 'GET', url }, ...extra });
  const response = (id: string, tabId = 7) => event(tabId, 'Network.responseReceived', { requestId: id, response: { status: 200, statusText: 'OK', mimeType: 'application/json', protocol: 'h2' } });
  const finishRequest = (id: string, tabId = 7) => event(tabId, 'Network.loadingFinished', { requestId: id, timestamp: 1.25, encodedDataLength: 123 });
  return { telemetry, runtime, send, listeners, event, log, request, response, finishRequest, close: () => { closed = true; } };
}

describe('per-run console capture', () => {
  it('deduplicates attach and attributes messages to the innermost step', async () => {
    const h = setup();
    await Promise.all([h.telemetry.attach(7, h.send), h.telemetry.attach(7, h.send)]);
    expect(h.send).toHaveBeenCalledExactlyOnceWith('Runtime.enable', {});
    h.telemetry.beginStep('outer'); h.log(7, 'outer');
    h.telemetry.beginStep('inner'); h.log(7, 'inner', 'error');
    expect(h.telemetry.finishStep('inner').map((entry) => entry.text)).toEqual(['inner']);
    h.log(7, 'outer again');
    expect(h.telemetry.finishStep('outer').map((entry) => entry.text)).toEqual(['outer', 'outer again']);
    expect((await h.telemetry.console(7)).map((entry) => entry.text)).toEqual(['outer', 'inner', 'outer again']);
    expect(h.telemetry.finishStep('missing')).toEqual([]);
  });

  it('captures exceptions and serialises remote arguments without fetching arbitrary objects', async () => {
    const h = setup(); await h.telemetry.attach(7, h.send);
    h.event(7, 'Runtime.exceptionThrown', { timestamp: Date.now(), exceptionDetails: { exception: { description: 'Error: failed' }, url: 'https://example.test/app.js' } });
    h.event(7, 'Runtime.consoleAPICalled', { timestamp: Date.now(), type: 'assert', args: [{ value: 'x' }, { value: { answer: 42 } }, { unserializableValue: 'NaN' }, { description: 'Array(3)' }] });
    expect(await h.telemetry.console(7)).toMatchObject([{ level: 'error', text: 'Error: failed', url: 'https://example.test/app.js' }, { level: 'error', text: 'x {"answer":42} NaN Array(3)' }]);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('does not include pre-run messages replayed by Runtime.enable', async () => {
    const h = setup(); await h.telemetry.attach(7, h.send);
    h.event(7, 'Runtime.consoleAPICalled', { timestamp: Date.now() - 10000, type: 'error', args: [{ value: 'previous run' }] });
    h.log(7, 'current run', 'error');
    expect((await h.telemetry.console(7)).map((entry) => entry.text)).toEqual(['current run']);
  });

  it('bounds aggregate and per-step storage, keeping tabs separate', async () => {
    const h = setup(); await h.telemetry.attach(7, h.send); await h.telemetry.attach(8, h.send);
    h.telemetry.beginStep('step');
    for (let i = 0; i < MAX_CONSOLE_ENTRIES + 10; i++) h.log(7, String(i));
    expect(h.telemetry.finishStep('step')).toHaveLength(MAX_STEP_CONSOLE_ENTRIES);
    expect(await h.telemetry.console(7)).toHaveLength(MAX_CONSOLE_ENTRIES);
    expect((await h.telemetry.console(7))[0]?.text).toBe('10');
    expect(await h.telemetry.console(8)).toEqual([]);
  });

  it('removes partial subscriptions on enable failure and allows a retry', async () => {
    const h = setup(); h.send.mockRejectedValueOnce(new Error('no Runtime'));
    await expect(h.telemetry.attach(7, h.send)).rejects.toThrow('no Runtime');
    expect(h.listeners.get(7)?.size).toBe(0);
    await h.telemetry.attach(7, h.send);
    expect(h.listeners.get(7)?.size).toBe(1);
  });

  it('unsubscribes on cleanup and rejects late calls', async () => {
    const h = setup(); await h.telemetry.attach(7, h.send);
    h.telemetry.beginStep('step'); h.log(7, 'before');
    h.close(); h.log(7, 'late');
    expect(h.telemetry.finishStep('step').map((entry) => entry.text)).toEqual(['before']);
    await h.telemetry.finish(); await h.telemetry.finish();
    expect(h.listeners.get(7)?.size).toBe(0);
    await expect(h.telemetry.console(7)).rejects.toMatchObject({ code: 'step.failed' });
  });
});

describe('HAR metadata', () => {
  it('captures completed requests in HAR 1.2 without headers, cookies, bodies or URL credentials', async () => {
    const h = setup(); await h.telemetry.har(7, 'start');
    h.request('a', 'https://user:pass@example.test/path?token=secret&query=hello', 7, { request: { method: 'POST', url: 'https://user:pass@example.test/path?token=secret&query=hello', headers: { Authorization: 'private' }, postData: 'sensitive body' } });
    h.response('a'); h.finishRequest('a');
    const result = await h.telemetry.har(7, 'stop');
    expect(result.har?.log).toMatchObject({ version: '1.2', creator: { name: 'BlockFlow', version: '9.9.9' }, entries: [{ time: 250, request: { method: 'POST', headers: [], cookies: [], bodySize: -1 }, response: { status: 200, content: { size: 123, mimeType: 'application/json' } } }] });
    const text = JSON.stringify(result);
    for (const secret of ['user:pass', 'secret', 'private', 'sensitive body', 'Authorization']) expect(text).not.toContain(secret);
    expect(text).toContain('query=hello'); expect(text).toContain('redacted');
  });

  it('handles redirects, failures and incomplete requests, and rejects invalid start/stop sequences', async () => {
    const h = setup(); await expect(h.telemetry.har(7, 'stop')).rejects.toMatchObject({ code: 'config.invalid' });
    await h.telemetry.har(7, 'start'); await expect(h.telemetry.har(7, 'start')).rejects.toMatchObject({ code: 'config.invalid' });
    h.request('r');
    h.request('r', 'https://example.test/redirected', 7, { timestamp: 1.1, redirectResponse: { status: 302, statusText: 'Found', encodedDataLength: 20 } });
    h.response('r'); h.finishRequest('r');
    h.request('failed'); h.event(7, 'Network.loadingFailed', { requestId: 'failed', timestamp: 1.2, errorText: 'net::ERR_FAILED' });
    h.request('pending');
    const result = await h.telemetry.har(7, 'stop');
    expect(result.har?.log.entries).toHaveLength(4);
    expect(result.har?.log.entries[0]).toMatchObject({ response: { status: 302 } });
    expect(result.har?.log.entries[2]).toMatchObject({ response: { status: 0 }, _error: 'net::ERR_FAILED' });
    expect(result.har?.log.entries[3]).toMatchObject({ _error: 'Recording stopped before request completed' });
    await expect(h.telemetry.har(7, 'stop')).rejects.toMatchObject({ code: 'config.invalid' });
  });

  it('bounds in-flight and finished storage and reports truncation', async () => {
    const h = setup(); await h.telemetry.har(7, 'start');
    for (let i = 0; i <= MAX_HAR_ENTRIES; i++) h.request(String(i));
    const result = await h.telemetry.har(7, 'stop');
    expect(result.har?.log.entries).toHaveLength(MAX_HAR_ENTRIES); expect(result.truncated).toBe(true);
  });

  it('can restart after stop and excludes other tabs or events after stop', async () => {
    const h = setup(); await h.telemetry.har(7, 'start'); await h.telemetry.attach(8, h.send);
    h.request('other', 'https://example.test/other', 8); h.response('other', 8); h.finishRequest('other', 8);
    expect((await h.telemetry.har(7, 'stop')).har?.log.entries).toEqual([]);
    h.request('late');
    await h.telemetry.har(7, 'start'); h.request('fresh'); h.response('fresh'); h.finishRequest('fresh');
    expect((await h.telemetry.har(7, 'stop')).har?.log.entries).toHaveLength(1);
    expect(h.send.mock.calls.filter(([name]) => name.endsWith('.disable'))).toEqual([]);
  });
});
