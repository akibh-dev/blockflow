import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvironment } from '../../src/browser/environment';
import type { M3Runtime } from '../../src/browser/m3Runtime';
import type { CdpSend } from '../../src/browser/cdpSessions';

const mock = vi.hoisted(() => ({
  contains: vi.fn(async () => true),
  remove: vi.fn(async () => {}),
  runtime: {} as { getBrowserInfo?: () => Promise<unknown> },
}));
vi.mock('wxt/browser', () => ({ browser: { permissions: { contains: mock.contains }, browsingData: { remove: mock.remove }, runtime: mock.runtime } }));

function setup() {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const send = vi.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    calls.push({ method, params });
    return method === 'Page.getLayoutMetrics' ? { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } } : {};
  });
  const state = { closed: false };
  const runtime: M3Runtime = { runId: 'r', withTab: async (_tab, fn) => fn(send), cleanupTab: async (_tab, fn) => fn(send), subscribe: () => () => {}, isClosed: () => state.closed, claim: vi.fn() };
  return { env: createEnvironment(runtime), runtime, send, calls, state };
}

beforeEach(() => { vi.clearAllMocks(); mock.contains.mockResolvedValue(true); delete mock.runtime.getBrowserInfo; });

describe('environment controller', () => {
  it('applies a mobile preset and custom metrics, locale, timezone, location, media and offline state', async () => {
    const { env, calls, runtime } = setup();
    await env.emulate(8, { action: 'set', device: 'iphone', width: 500, height: 800, locale: 'fr-FR', timezone: 'Europe/Paris', latitude: 0, longitude: 0, colorScheme: 'dark', reducedMotion: 'reduce', offline: true });
    expect(runtime.claim).toHaveBeenCalledWith(8, 'emulation');
    expect(calls).toContainEqual({ method: 'Emulation.setDeviceMetricsOverride', params: { width: 500, height: 800, deviceScaleFactor: 3, mobile: true, screenWidth: 500, screenHeight: 800 } });
    expect(calls).toContainEqual({ method: 'Emulation.setLocaleOverride', params: { locale: 'fr_FR' } });
    expect(calls).toContainEqual({ method: 'Emulation.setGeolocationOverride', params: { latitude: 0, longitude: 0, accuracy: 1 } });
    expect(calls).toContainEqual({ method: 'Network.emulateNetworkConditions', params: { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } });
    expect(calls.some(({ method }) => method === 'Browser.grantPermissions')).toBe(false);
    await env.finish();
    expect(calls).toContainEqual({ method: 'Emulation.clearDeviceMetricsOverride', params: {} });
    expect(calls).toContainEqual({ method: 'Emulation.setUserAgentOverride', params: { userAgent: '' } });
    expect(calls).toContainEqual({ method: 'Emulation.setLocaleOverride', params: { locale: '' } });
    expect(calls).toContainEqual({ method: 'Emulation.setTimezoneOverride', params: { timezoneId: '' } });
    expect(calls).toContainEqual({ method: 'Emulation.clearGeolocationOverride', params: {} });
    expect(calls).toContainEqual({ method: 'Emulation.setEmulatedMedia', params: { media: '', features: [] } });
    expect(calls).toContainEqual({ method: 'Network.emulateNetworkConditions', params: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } });
    const count = calls.length; await env.finish(); expect(calls).toHaveLength(count);
  });

  it('clears prior overrides before replacement and resets an explicit clear only once', async () => {
    const { env, calls } = setup();
    await env.emulate(3, { action: 'set', device: '', timezone: 'Asia/Dhaka' });
    await env.emulate(3, { action: 'set', device: '', colorScheme: 'dark' });
    expect(calls.map(({ method }) => method)).toEqual(['Emulation.setTimezoneOverride', 'Emulation.setTimezoneOverride', 'Emulation.setEmulatedMedia']);
    await env.emulate(3, { action: 'clear', device: '' });
    const count = calls.length; await env.finish(); expect(calls).toHaveLength(count);
  });

  it('reads the current viewport when only scale is overridden', async () => {
    const { env, calls } = setup();
    await env.emulate(3, { action: 'set', device: '', deviceScaleFactor: 2 });
    expect(calls[1]).toMatchObject({ method: 'Emulation.setDeviceMetricsOverride', params: { width: 1280, height: 800, mobile: false, deviceScaleFactor: 2 } });
    await env.finish();
  });

  it('rolls back partial application when a protocol command fails', async () => {
    const { env, send, calls } = setup();
    const original = send.getMockImplementation()!;
    send.mockImplementation(async (method, params) => { if (method === 'Emulation.setTimezoneOverride' && params?.timezoneId === 'Asia/Dhaka') throw new Error('protocol failed'); return original(method, params); });
    await expect(env.emulate(3, { action: 'set', device: 'pixel', timezone: 'Asia/Dhaka' })).rejects.toThrow('protocol failed');
    expect(calls).toContainEqual({ method: 'Emulation.clearDeviceMetricsOverride', params: {} });
    expect(calls).toContainEqual({ method: 'Emulation.setTimezoneOverride', params: { timezoneId: '' } });
    const count = calls.length; await env.finish(); expect(calls).toHaveLength(count);
  });

  it('ignores a detached session on cleanup, but reports other reset failures', async () => {
    const a = setup(); await a.env.emulate(1, { action: 'set', device: '', timezone: 'Asia/Dhaka' });
    a.runtime.cleanupTab = async () => { throw new Error('The debugger was detached or the tab closed.'); };
    await expect(a.env.finish()).resolves.toBeUndefined();
    const b = setup(); await b.env.emulate(1, { action: 'set', device: '', timezone: 'Asia/Dhaka' });
    b.send.mockRejectedValue(new Error('protocol reset failed'));
    await expect(b.env.finish()).rejects.toThrow('protocol reset failed');
  });

  it('does not mutate after closure, invalid settings or a failed ownership claim', async () => {
    const { env, runtime, send, state } = setup();
    await expect(env.emulate(1, { action: 'set', device: '', width: 300 })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    runtime.claim = () => { throw new Error('owned by another run'); };
    await expect(env.emulate(1, { action: 'set', device: 'ipad' })).rejects.toThrow('owned by another');
    expect(send).not.toHaveBeenCalled();
    state.closed = true;
    await expect(env.emulate(1, { action: 'set', device: '' })).rejects.toThrow('run has ended');
  });
});

describe('origin-filtered site-data deletion', () => {
  it('passes an exact filter and only site-data types, never a global removal', async () => {
    const { env } = setup();
    await env.clearSiteData({ origins: ['https://shop.example.com', 'https://shop.example.com/'] });
    expect(mock.remove).toHaveBeenCalledExactlyOnceWith({ origins: ['https://shop.example.com'], since: 0 }, { cookies: true, localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true });
  });

  it('refuses Firefox rather than falling back to an unsupported/global filter', async () => {
    mock.runtime.getBrowserInfo = async () => ({ name: 'Firefox' });
    await expect(setup().env.clearSiteData({ origins: ['https://shop.example.com'] })).rejects.toMatchObject({ code: 'permission.missing' });
    expect(mock.remove).not.toHaveBeenCalled();
  });

  it('checks the browsingData permission and refuses empty, invalid or closed requests', async () => {
    const { env, state } = setup();
    for (const origins of [[], ['*'], ['https://shop.example.com/path']]) await expect(env.clearSiteData({ origins })).rejects.toMatchObject({ code: 'config.invalid' });
    mock.contains.mockResolvedValue(false);
    await expect(env.clearSiteData({ origins: ['https://shop.example.com'] })).rejects.toMatchObject({ code: 'permission.missing' });
    state.closed = true;
    await expect(env.clearSiteData({ origins: ['https://shop.example.com'] })).rejects.toThrow('run has ended');
    expect(mock.remove).not.toHaveBeenCalled();
  });
});
