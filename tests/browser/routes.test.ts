import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CdpListener, CdpSend } from '../../src/browser/cdpSessions';
import type { M3Runtime } from '../../src/browser/m3Runtime';
import { createRoutes, initialiseRoutes } from '../../src/browser/routes';
import type { DnrPort } from '../../src/browser/routes';

vi.mock('wxt/browser', () => ({ browser: {} }));
afterEach(() => vi.useRealTimers());

function setup() {
  const send = vi.fn(async (_method: string, _params?: Record<string, unknown>): Promise<unknown> => ({}));
  const listeners = new Map<number, CdpListener>();
  let closed = false;
  const runtime: M3Runtime = {
    runId: 'run', withTab: vi.fn(<T,>(_tab: number, fn: (send: CdpSend) => Promise<T>) => fn(send)) as M3Runtime['withTab'],
    cleanupTab: vi.fn(<T,>(_tab: number, fn: (send: CdpSend) => Promise<T>) => fn(send)) as M3Runtime['cleanupTab'],
    subscribe: (tab, listener) => { listeners.set(tab, listener); return () => { listeners.delete(tab); }; },
    isClosed: () => closed, claim: vi.fn(),
  };
  const stored: { id: number }[] = [];
  const port: DnrPort = {
    available: vi.fn(async () => true), getSessionRules: vi.fn(async () => [...stored]),
    updateSessionRules: vi.fn(async (options) => {
      for (const id of options.removeRuleIds ?? []) { const index = stored.findIndex((r) => r.id === id); if (index >= 0) stored.splice(index, 1); }
      stored.push(...(options.addRules ?? []));
    }),
    isRegexSupported: vi.fn(async () => ({ isSupported: true })),
  };
  const routes = createRoutes(runtime, port);
  const event = (id: string, url: string, method = 'GET', requestHeaders = {}) => listeners.get(7)?.('Fetch.requestPaused', { requestId: id, request: { url, method, headers: requestHeaders } });
  return { send, runtime, port, routes, stored, event, listeners, close: () => { closed = true; } };
}
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

describe('CDP request routes', () => {
  it('uses newest matching rule, honors method, encodes Unicode, and continues unmatched requests', async () => {
    const h = setup();
    await h.routes.apply(7, { action: 'add', backend: 'cdp', rules: [
      { url: '**/api/**', action: 'fulfill', body: 'old' },
      { url: '**/api/order', action: 'fulfill', method: 'POST', status: 201, body: 'বাংলা', headers: { 'content-type': 'application/json' } },
    ] });
    h.event('post', 'https://shop.test/api/order', 'POST'); h.event('get', 'https://shop.test/api/order'); h.event('other', 'https://shop.test/asset.js');
    await flush();
    expect(h.send).toHaveBeenCalledWith('Fetch.fulfillRequest', expect.objectContaining({ requestId: 'post', responseCode: 201, body: '4Kas4Ka+4KaC4Kay4Ka+' }));
    expect(h.send).toHaveBeenCalledWith('Fetch.fulfillRequest', expect.objectContaining({ requestId: 'get', body: btoa('old') }));
    expect(h.send).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'other' });
    expect(h.runtime.claim).toHaveBeenCalledWith(7, 'route');
    await h.routes.finish();
  });

  it('supports continue, abort, redirect and modifying outgoing headers/body', async () => {
    const h = setup();
    await h.routes.apply(7, { action: 'add', backend: 'cdp', rules: [
      { url: '/pass', action: 'continue' }, { url: '/blocked', action: 'abort' },
      { url: '/old', action: 'redirect', redirectUrl: 'https://shop.test/new' },
      { url: '/write', action: 'modify', headers: { 'x-token': 'new' }, body: 'changed' },
    ] });
    h.event('pass', 'https://shop.test/pass'); h.event('blocked', 'https://shop.test/blocked'); h.event('old', 'https://shop.test/old');
    h.event('write', 'https://shop.test/write', 'POST', { 'X-Token': 'old', Cookie: 'session=abc', 'Content-Length': '999' });
    await flush();
    expect(h.send).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'pass' });
    expect(h.send).toHaveBeenCalledWith('Fetch.failRequest', { requestId: 'blocked', errorReason: 'BlockedByClient' });
    expect(h.send).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'old', url: 'https://shop.test/new' });
    expect(h.send).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'write', headers: [{ name: 'x-token', value: 'new' }, { name: 'Cookie', value: 'session=abc' }], postData: btoa('changed') });
    await h.routes.finish();
  });

  it('cancels delayed writes before disabling interception, without forwarding or fulfilling after cleanup', async () => {
    vi.useFakeTimers(); const h = setup();
    await h.routes.apply(7, { action: 'add', backend: 'cdp', rules: [{ url: '/write', action: 'modify', body: 'intended', delayMs: 30_000 }] });
    h.event('delayed', 'https://shop.test/write', 'POST'); await flush(); h.close();
    await h.routes.finish();
    const methods = h.send.mock.calls.map(([method]) => method);
    expect(methods.indexOf('Fetch.failRequest')).toBeLessThan(methods.indexOf('Fetch.disable'));
    expect(h.send).toHaveBeenCalledWith('Fetch.failRequest', { requestId: 'delayed', errorReason: 'Aborted' });
    expect(h.send).not.toHaveBeenCalledWith('Fetch.continueRequest', expect.anything());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.send).not.toHaveBeenCalledWith('Fetch.continueRequest', expect.anything());
    expect(h.listeners.size).toBe(0); await h.routes.finish();
    expect(methods.filter((method) => method === 'Fetch.disable')).toHaveLength(1);
  });

  it('fails new paused requests arriving while cleanup is in progress', async () => {
    const h = setup(); await h.routes.apply(7, { action: 'add', backend: 'cdp', rules: [{ url: '/write', action: 'fulfill', body: 'mock' }] });
    const raw = h.send.getMockImplementation()!;
    h.send.mockImplementation(async (method, params) => {
      if (method === 'Fetch.disable') h.event('closing', 'https://shop.test/write', 'POST');
      return raw(method, params);
    });
    await h.routes.finish();
    expect(h.send).toHaveBeenCalledWith('Fetch.failRequest', { requestId: 'closing', errorReason: 'Aborted' });
    expect(h.send).not.toHaveBeenCalledWith('Fetch.fulfillRequest', expect.objectContaining({ requestId: 'closing' }));
  });

  it('surfaces interception errors and fails the request rather than sending an intended write to the site', async () => {
    const h = setup(); await h.routes.apply(7, { action: 'add', backend: 'cdp', rules: [{ url: '/mock', action: 'fulfill', body: 'mock' }] });
    h.send.mockRejectedValueOnce(new Error('fulfill failed'));
    h.event('bad', 'https://shop.test/mock', 'POST'); await flush();
    expect(h.send).toHaveBeenCalledWith('Fetch.failRequest', { requestId: 'bad', errorReason: 'Failed' });
    expect(h.send).not.toHaveBeenCalledWith('Fetch.continueRequest', expect.anything());
    await expect(h.routes.finish()).rejects.toThrow('fulfill failed');
    expect(h.send).toHaveBeenCalledWith('Fetch.disable');
  });

  it('cleans partial Fetch installation, but never attaches during cleanup if acquisition failed', async () => {
    const h = setup(); h.send.mockRejectedValueOnce(new Error('Fetch failed'));
    await expect(h.routes.apply(7, { action: 'add', backend: 'cdp', rules: [{ url: '/mock', action: 'fulfill' }] })).rejects.toThrow('Fetch failed');
    await h.routes.finish(); expect(h.send).toHaveBeenCalledWith('Fetch.disable');
    const absent = setup(); vi.mocked(absent.runtime.withTab).mockRejectedValueOnce(new Error('permission missing'));
    await expect(absent.routes.apply(7, { action: 'add', backend: 'cdp', rules: [{ url: '/mock', action: 'fulfill' }] })).rejects.toThrow('permission missing');
    await absent.routes.finish(); expect(absent.runtime.cleanupTab).not.toHaveBeenCalled();
  });

  it('retains CDP for auto additions and only allows an explicit backend switch after clear', async () => {
    const h = setup(); await h.routes.apply(7, { action: 'add', backend: 'auto', rules: [{ url: '/mock', action: 'fulfill' }] });
    expect(await h.routes.apply(7, { action: 'add', backend: 'auto', rules: [{ url: '/block', action: 'abort' }] })).toEqual({ rules: 2, backend: 'cdp' });
    await expect(h.routes.apply(7, { action: 'add', backend: 'dnr', rules: [{ url: '/block', action: 'abort' }] })).rejects.toThrow('Clear');
    expect(await h.routes.apply(7, { action: 'clear', backend: 'auto', rules: [] })).toEqual({ rules: 0, backend: 'cdp' });
    expect((await h.routes.apply(7, { action: 'add', backend: 'dnr', rules: [{ url: '/block', action: 'abort' }] })).backend).toBe('dnr');
    await h.routes.finish();
  });

  it('surfaces non-detach cleanup errors, while closed sessions are benign', async () => {
    const h = setup(); await h.routes.apply(7, { action: 'add', backend: 'cdp', rules: [{ url: '/mock', action: 'fulfill' }] });
    h.send.mockRejectedValueOnce(new Error('cannot disable Fetch'));
    await expect(h.routes.finish()).rejects.toThrow('cannot disable Fetch');
    const lost = setup(); await lost.routes.apply(7, { action: 'add', backend: 'cdp', rules: [{ url: '/mock', action: 'fulfill' }] });
    lost.send.mockRejectedValueOnce(new Error('The debugger was detached'));
    await lost.routes.finish();
  });
});

describe('declarative browser routes', () => {
  it('removes only stale reserved IDs and creates tab-scoped rules with deterministic priorities', async () => {
    const h = setup(); h.stored.push({ id: 12 }, { id: 1_000_000 }, { id: 1_100_000 });
    await initialiseRoutes(h.port);
    expect(h.stored.map((r) => r.id)).toEqual([12, 1_100_000]);
    await h.routes.apply(7, { action: 'add', backend: 'auto', rules: [{ url: '**/api/**', action: 'abort', method: 'POST' }] });
    await h.routes.apply(7, { action: 'add', backend: 'dnr', rules: [{ url: '/api/order', action: 'redirect', redirectUrl: 'https://shop.test/replacement' }] });
    const adds = vi.mocked(h.port.updateSessionRules).mock.calls.flatMap(([options]) => options.addRules ?? []);
    expect(adds).toHaveLength(2); expect(adds.map((r) => r.priority)).toEqual([1, 2]);
    expect(adds[0]!.condition).toMatchObject({ tabIds: [7], requestMethods: ['post'], regexFilter: '^.*/api/.*$', isUrlFilterCaseSensitive: true });
    expect(adds[0]!.condition.resourceTypes).toContain('main_frame');
    expect(adds[1]!.action).toEqual({ type: 'redirect', redirect: { url: 'https://shop.test/replacement' } });
    await h.routes.finish(); expect(h.stored.map((r) => r.id)).toEqual([12, 1_100_000]);
    expect(h.runtime.withTab).not.toHaveBeenCalled();
  });

  it('rejects unavailable permissions and unsupported capabilities/patterns explicitly', async () => {
    const h = setup(); vi.mocked(h.port.available).mockResolvedValueOnce(false);
    await expect(h.routes.apply(7, { action: 'add', backend: 'dnr', rules: [{ url: '/block', action: 'abort' }] })).rejects.toMatchObject({ code: 'permission.missing' });
    await expect(h.routes.apply(7, { action: 'add', backend: 'dnr', rules: [{ url: '/mock', action: 'fulfill' }] })).rejects.toThrow('only abort/redirect');
    await expect(h.routes.apply(7, { action: 'add', backend: 'dnr', rules: [{ url: '/block', action: 'abort', method: 'CUSTOM' }] })).rejects.toThrow('standard HTTP methods');
    vi.mocked(h.port.isRegexSupported!).mockResolvedValueOnce({ isSupported: false });
    await expect(h.routes.apply(7, { action: 'add', backend: 'dnr', rules: [{ url: '/(?<=x)y/', action: 'abort' }] })).rejects.toThrow('cannot use route URL pattern');
  });

  it('retries startup cleanup after failure and after permission is granted', async () => {
    const h = setup(); vi.mocked(h.port.available).mockResolvedValueOnce(false);
    await initialiseRoutes(h.port); expect(h.port.getSessionRules).not.toHaveBeenCalled();
    vi.mocked(h.port.getSessionRules).mockRejectedValueOnce(new Error('temporarily unavailable'));
    await expect(initialiseRoutes(h.port)).rejects.toThrow('temporarily unavailable');
    await initialiseRoutes(h.port); expect(h.port.getSessionRules).toHaveBeenCalledTimes(2);
  });

  it('fails closed after run finish and does not install rules if closing during preparation', async () => {
    const h = setup(); vi.mocked(h.port.isRegexSupported!).mockImplementationOnce(async () => { h.close(); return { isSupported: true }; });
    await expect(h.routes.apply(7, { action: 'add', backend: 'dnr', rules: [{ url: '/block', action: 'abort' }] })).rejects.toThrow('run has ended');
    await h.routes.finish(); expect(h.port.updateSessionRules).not.toHaveBeenCalled();
    await expect(h.routes.apply(7, { action: 'clear', backend: 'auto', rules: [] })).rejects.toThrow('run has ended');
  });
});
