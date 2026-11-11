import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Firefox CI (2026-11-11): Read Element with a URL opened its tab, and the first injection happened while the
 * tab was still about:blank. Firefox answered "Missing host permission for the tab", which was reported as
 * "BlockFlow has no access to null". A tab that has not reached its page is now waited for.
 */
const state = vi.hoisted(() => ({ url: 'about:blank', failures: 0, granted: true }));

vi.mock('wxt/browser', () => ({
  browser: {
    tabs: { get: vi.fn(async () => ({ id: 7, url: state.url })) },
    scripting: {
      executeScript: vi.fn(async () => {
        if (state.url === 'about:blank') {
          state.failures += 1;
          // The page arrives after two refused calls.
          if (state.failures >= 2) state.url = 'http://127.0.0.1:8080/watch.html';
          throw new Error('Missing host permission for the tab');
        }
        return [{ result: { status: 'done', result: { text: 'Hello' } } }];
      }),
    },
    webNavigation: { getAllFrames: vi.fn(async () => []) },
    permissions: { contains: vi.fn(async () => state.granted) },
  },
}));

import { actInTab, notArrivedYet, restrictedError } from '../../src/browser/pageDriver';

beforeEach(() => {
  state.url = 'about:blank';
  state.failures = 0;
  state.granted = true;
});

describe('a tab still on about:blank', () => {
  it('notArrivedYet: about:blank and a missing URL, not real pages', () => {
    expect(notArrivedYet('about:blank')).toBe(true);
    expect(notArrivedYet(undefined)).toBe(true);
    expect(notArrivedYet('')).toBe(true);
    expect(notArrivedYet('https://example.com/')).toBe(false);
    expect(notArrivedYet('about:addons')).toBe(false);
  });

  it('is waited for, even when the URL changed before it was read: the request succeeds once the page loaded', async () => {
    await expect(actInTab(7, { op: 'read', locator: 'h1', kind: 'text' }, 5_000)).resolves.toEqual({ text: 'Hello' });
    expect(state.failures).toBe(2);
  });

  it('a real page without access still fails at once with permission.missing naming the site', async () => {
    state.url = 'http://127.0.0.1:8080/watch.html';
    state.granted = false;
    const { browser } = await import('wxt/browser');
    vi.mocked(browser.scripting.executeScript).mockRejectedValueOnce(new Error('Missing host permission for the tab'));
    await expect(actInTab(7, { op: 'read', locator: 'h1', kind: 'text' }, 5_000)).rejects.toMatchObject({
      code: 'permission.missing',
      message: expect.stringContaining('http://127.0.0.1:8080'),
    });
  });

  it('never names "null" as the site', () => {
    expect(restrictedError('Missing host permission for the tab', 'about:blank').message).toContain('no access to this site');
    expect(restrictedError('Missing host permission for the tab', 'data:text/html,x').message).not.toContain('null');
  });
});
