import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILD_COMMAND, InfraError, bridgePaths, browserCandidates, findBrowser, resolveExtension } from '../../packages/cli/index.mjs';

describe('findBrowser', () => {
  it('uses --browser, then BLOCKFLOW_BROWSER, and never replaces a missing explicit browser', () => {
    const exists = (file: string) => file === '/opt/mine' || file === '/usr/bin/chromium';
    expect(findBrowser('/opt/mine', {}, exists)).toBe('/opt/mine');
    expect(findBrowser(undefined, { BLOCKFLOW_BROWSER: '/opt/mine' }, exists)).toBe('/opt/mine');
    expect(() => findBrowser('/opt/other', {}, exists)).toThrow(/Browser not found/);
  });

  it('prefers plain Chromium over branded Chrome', () => {
    const exists = (file: string) => file === '/usr/bin/google-chrome' || file === '/usr/bin/chromium';
    expect(findBrowser(undefined, {}, exists)).toBe('/usr/bin/chromium');
    const list = browserCandidates(undefined, {});
    expect(list.indexOf('/usr/bin/chromium')).toBeLessThan(list.indexOf('/usr/bin/google-chrome'));
  });

  it('explains how to get a browser when none is found', () => {
    expect(() => findBrowser(undefined, {}, () => false)).toThrow(InfraError);
    expect(() => findBrowser(undefined, {}, () => false)).toThrow(/--browser/);
  });
});

describe('resolveExtension', () => {
  it('defaults to .output-automation/chrome-mv3 in the working directory', () => {
    const exists = (file: string) => file === path.resolve('/work/.output-automation/chrome-mv3/manifest.json');
    expect(resolveExtension(undefined, {}, '/work', exists)).toBe(path.resolve('/work/.output-automation/chrome-mv3'));
  });

  it('takes --extension or BLOCKFLOW_EXTENSION relative to the working directory', () => {
    const exists = (file: string) => file.endsWith(path.join('ext', 'manifest.json'));
    expect(resolveExtension('ext', {}, '/work', exists)).toBe(path.resolve('/work/ext'));
    expect(resolveExtension(undefined, { BLOCKFLOW_EXTENSION: 'ext' }, '/work', exists)).toBe(path.resolve('/work/ext'));
  });

  it('uses the extension bundled into the published package when there is no local build', () => {
    const bundled = path.resolve(path.dirname(fileURLToPath(new URL('../../packages/cli/browser.mjs', import.meta.url))), 'extension');
    const exists = (file: string) => file === path.join(bundled, 'manifest.json');
    expect(resolveExtension(undefined, {}, '/work', exists)).toBe(bundled);
  });

  it('names the build command when the build is missing', () => {
    expect(() => resolveExtension(undefined, {}, '/work', () => false)).toThrow(`Build it first: ${BUILD_COMMAND}`);
  });
});

describe('bridgePaths', () => {
  it('keeps the socket and token inside the profile (unix)', () => {
    if (process.platform === 'win32') return;
    expect(bridgePaths('/tmp/p')).toEqual({ socket: '/tmp/p/bridge.sock', tokenFile: '/tmp/p/bridge-token', hostsDir: '/tmp/p/NativeMessagingHosts' });
  });
});
