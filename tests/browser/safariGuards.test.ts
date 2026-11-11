import { beforeEach, describe, expect, it, vi } from 'vitest';

// Safari lacks several extension APIs (offscreen, debugger, userScripts, browsingData, declarativeNetRequest).
// Each feature must fail with a readable `permission.missing`, never a TypeError. The mocked `browser` has none of them.
const api = vi.hoisted(() => ({ browser: {} as Record<string, unknown> }));
vi.mock('wxt/browser', () => ({
  get browser() {
    return api.browser;
  },
}));

import { hasDebugger, withDebugger } from '../../src/browser/cdp';
import { createEnvironment } from '../../src/browser/environment';
import { actOnHtml } from '../../src/browser/htmlParse';
import { runScript } from '../../src/browser/host';
import type { M3Runtime } from '../../src/browser/m3Runtime';
import { createRoutes, initialiseRoutes } from '../../src/browser/routes';

const safari = () => ({
  runtime: { sendMessage: vi.fn() },
  permissions: { contains: vi.fn(async () => false), onAdded: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() } },
  tabs: { onRemoved: { addListener: vi.fn() } },
});

const runtime: M3Runtime = { runId: 'r', withTab: async (_t, fn) => fn(async () => ({})), cleanupTab: async (_t, fn) => fn(async () => ({})), subscribe: () => () => {}, isClosed: () => false, claim: vi.fn() };

beforeEach(() => {
  api.browser = safari();
});

const code = (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: { code?: string; message?: string }) => `${error.code}: ${error.message}`);

describe('Safari without optional APIs', () => {
  it('debugger: hasDebugger is false and a CDP callback fails with permission.missing naming Chromium', async () => {
    expect(await hasDebugger()).toBe(false);
    expect(await code(withDebugger(1, async () => 1))).toMatch(/^permission\.missing: .*debugger/);
  });

  it('offscreen: parsing HTML in a worker without a DOM says why', async () => {
    expect(typeof DOMParser).toBe('undefined');
    expect(await code(actOnHtml('<p>x</p>', '', { op: 'snapshot' } as never))).toMatch(/^permission\.missing: This browser cannot parse HTML/);
  });

  it('userScripts: Run Script fails with permission.missing', async () => {
    expect(await code(runScript(1, 'return 1', {}))).toMatch(/^permission\.missing: Run Script needs Chrome 135/);
  });

  it('browsingData: Clear Site Data refuses and deletes nothing', async () => {
    const env = createEnvironment(runtime);
    expect(await code(env.clearSiteData({ origins: ['https://example.com'] }))).toMatch(/^permission\.missing: Clear Site Data needs Chromium/);
  });

  it('declarativeNetRequest: startup cleanup is a no-op and a browser-rule Route refuses', async () => {
    await expect(initialiseRoutes()).resolves.toBeUndefined();
    const routes = createRoutes(runtime);
    const result = await code(routes.apply(7, { action: 'add', backend: 'dnr', rules: [{ url: '**/ads/**', action: 'abort' }] }));
    expect(result).toMatch(/^permission\.missing: .*declarativeNetRequest/);
    await routes.finish();
  });
});
