import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  browserTarget,
  chromiumExtensionId,
  defaultLauncherDir,
  hostManifest,
  installHost,
  isolatedHostDirs,
  launcherScript,
  registryAddArgs,
  uninstallHost,
} from '../../packages/bridge/install.mjs';
import { main } from '../../packages/bridge/cli.mjs';
import { tempDir } from './helpers';

const ID = 'eedohelcoppcdalailghibghannimeki';
const temps: string[] = [];
const temp = () => {
  const dir = tempDir();
  temps.push(dir);
  return dir;
};
afterEach(() => temps.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('chromiumExtensionId', () => {
  it('maps the first 32 hex digits of SHA-256(path) to a-p', () => {
    const hex = createHash('sha256').update('/x/ext').digest('hex').slice(0, 32);
    const expected = [...hex].map((d) => 'abcdefghijklmnop'[parseInt(d, 16)]).join('');
    expect(chromiumExtensionId('/x/ext')).toBe(expected);
    expect(chromiumExtensionId('/x/ext')).toMatch(/^[a-p]{32}$/);
  });

  it('matches the id Chromium 156 gave .output-bridge/chrome-mv3 in this checkout (checked in a real browser)', () => {
    // Recorded by loading the build with --load-extension and reading the service worker URL.
    expect(chromiumExtensionId('/home/akib/Desktop/blockflow/.output-bridge/chrome-mv3', { platform: 'linux' })).toBe(ID);
  });

  it('resolves symlinks like Chromium does', () => {
    const dir = temp();
    mkdirSync(path.join(dir, 'real'));
    symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
    expect(chromiumExtensionId(path.join(dir, 'link'))).toBe(chromiumExtensionId(path.join(dir, 'real')));
  });

  it('hashes UTF-16LE with an upper-case drive letter on Windows', () => {
    const hex = createHash('sha256').update(Buffer.from('C:\\ext', 'utf16le')).digest('hex').slice(0, 32);
    const expected = [...hex].map((d) => 'abcdefghijklmnop'[parseInt(d, 16)]).join('');
    expect(chromiumExtensionId('c:\\ext', { platform: 'win32' })).toBe(expected);
  });
});

describe('installHost / uninstallHost with dirs', () => {
  it('writes an executable launcher and a Chromium manifest, and removes them again', () => {
    const dir = path.join(temp(), 'NativeMessagingHosts');
    const result = installHost({ extensionIds: [ID], dirs: [dir] });
    const manifestFile = path.join(dir, 'dev.akibh.blockflow.json');
    expect(result.manifests).toEqual([manifestFile]);
    expect(result.launcher).toBe(path.join(dir, 'blockflow-bridge-host'));
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    expect(manifest).toEqual({
      name: 'dev.akibh.blockflow',
      description: expect.any(String),
      path: result.launcher,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${ID}/`],
    });
    expect(statSync(result.launcher).mode & 0o111).toBe(0o111);
    const launcher = readFileSync(result.launcher, 'utf8');
    expect(launcher).toContain(process.execPath);
    expect(launcher).toContain(path.resolve('packages/bridge/host.mjs'));
    // The launcher really starts the host (stdin closed at once → it exits 0 after listening).
    const out = execFileSync(result.launcher, [], { env: { ...process.env, BLOCKFLOW_SOCKET: path.join(dir, 's'), BLOCKFLOW_TOKEN_FILE: path.join(dir, 't') }, input: '', stdio: ['pipe', 'pipe', 'pipe'] });
    expect(out.length).toBe(0);

    expect(uninstallHost({ dirs: [dir] }).removed.sort()).toEqual([result.launcher, manifestFile].sort());
    expect(existsSync(manifestFile) || existsSync(result.launcher)).toBe(false);
  });

  it('writes a Firefox manifest with allowed_extensions', () => {
    const dir = temp();
    const { manifests, launcher } = installHost({ dirs: [{ dir, kind: 'firefox' }] });
    expect(JSON.parse(readFileSync(manifests[0]!, 'utf8'))).toEqual({
      name: 'dev.akibh.blockflow',
      description: expect.any(String),
      path: launcher,
      type: 'stdio',
      allowed_extensions: ['blockflow@akibh-dev'],
    });
  });

  it('refuses bad or missing extension ids for Chromium browsers', () => {
    expect(() => installHost({ extensionIds: ['nope'], dirs: [temp()] })).toThrow(/not a Chromium extension id/);
    expect(() => installHost({ extensionIds: [], dirs: [temp()] })).toThrow(/need the extension id/);
    expect(() => installHost({ extensionIds: [], home: temp() })).toThrow(/Nothing to install/);
  });

  it('isolatedHostDirs: the profile folder plus every Chromium default folder under a throwaway home', () => {
    const dirs = isolatedHostDirs('/p', '/h', { platform: 'linux' });
    expect(dirs[0]).toBe(path.join('/p', 'NativeMessagingHosts'));
    expect(dirs).toContain('/h/.config/BraveSoftware/Brave-Origin/NativeMessagingHosts');
    expect(dirs).toContain('/h/.config/chromium/NativeMessagingHosts');
    expect(dirs.every((dir) => dir.startsWith('/p') || dir.startsWith('/h'))).toBe(true);
  });

  it('installs into every browser folder under a home (Linux) and uninstalls them', () => {
    const home = temp();
    const result = installHost({ extensionIds: [ID], firefox: true, home, platform: 'linux' });
    const rel = result.manifests.map((file) => path.relative(home, file)).sort();
    expect(rel).toEqual(
      [
        '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/dev.akibh.blockflow.json',
        '.config/BraveSoftware/Brave-Origin/NativeMessagingHosts/dev.akibh.blockflow.json',
        '.config/chromium/NativeMessagingHosts/dev.akibh.blockflow.json',
        '.config/google-chrome/NativeMessagingHosts/dev.akibh.blockflow.json',
        '.config/microsoft-edge/NativeMessagingHosts/dev.akibh.blockflow.json',
        '.mozilla/native-messaging-hosts/dev.akibh.blockflow.json',
      ].sort(),
    );
    expect(result.launcher).toBe(path.join(home, '.config/blockflow/bridge/blockflow-bridge-host'));
    const firefox = JSON.parse(readFileSync(path.join(home, '.mozilla/native-messaging-hosts/dev.akibh.blockflow.json'), 'utf8'));
    expect(firefox.allowed_extensions).toEqual(['blockflow@akibh-dev']);
    const removed = uninstallHost({ home, platform: 'linux' }).removed;
    expect(removed).toHaveLength(7);
  });
});

describe('platform paths (construction only)', () => {
  it('knows the macOS folders', () => {
    expect(browserTarget('chrome', { platform: 'darwin', home: '/Users/a' }).dir).toBe('/Users/a/Library/Application Support/Google/Chrome/NativeMessagingHosts');
    expect(browserTarget('edge', { platform: 'darwin', home: '/Users/a' }).dir).toBe('/Users/a/Library/Application Support/Microsoft Edge/NativeMessagingHosts');
    expect(browserTarget('firefox', { platform: 'darwin', home: '/Users/a' }).dir).toBe('/Users/a/Library/Application Support/Mozilla/NativeMessagingHosts');
  });

  it('uses HKCU registry keys, a .cmd launcher and reg add on Windows', () => {
    expect(browserTarget('chrome', { platform: 'win32' }).registryKey).toBe('HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\dev.akibh.blockflow');
    expect(browserTarget('brave', { platform: 'win32' }).registryKey).toBe('HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\dev.akibh.blockflow');
    expect(browserTarget('edge', { platform: 'win32' }).registryKey).toBe('HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\dev.akibh.blockflow');
    expect(browserTarget('firefox', { platform: 'win32' }).registryKey).toBe('HKCU\\Software\\Mozilla\\NativeMessagingHosts\\dev.akibh.blockflow');
    expect(defaultLauncherDir({ platform: 'win32', localAppData: 'C:\\Users\\a\\AppData\\Local' })).toBe('C:\\Users\\a\\AppData\\Local\\BlockFlow');
    expect(launcherScript({ platform: 'win32', nodePath: 'C:\\node.exe', hostScript: 'C:\\b\\host.mjs' })).toBe('@echo off\r\n"C:\\node.exe" "C:\\b\\host.mjs" %*\r\n');
    expect(registryAddArgs('HKCU\\K', 'C:\\m.json')).toEqual(['add', 'HKCU\\K', '/ve', '/t', 'REG_SZ', '/d', 'C:\\m.json', '/f']);
    expect(hostManifest('chromium', 'C:\\l.cmd', [ID]).allowed_origins).toEqual([`chrome-extension://${ID}/`]);
  });

  it('quotes paths with quotes in the sh launcher', () => {
    expect(launcherScript({ platform: 'linux', nodePath: "/o'k/node", hostScript: '/h.mjs' })).toContain(`exec '/o'\\''k/node' '/h.mjs' "$@"`);
  });
});

describe('cli', () => {
  const run = async (args: string[]) => {
    let out = '';
    let err = '';
    const code = await main(args, { out: (t: string) => (out += `${t}\n`), err: (t: string) => (err += `${t}\n`), env: { BLOCKFLOW_SOCKET: path.join(temp(), 's'), BLOCKFLOW_TOKEN_FILE: '/nonexistent/t' } });
    return { code, out, err };
  };

  it('install --dir and uninstall --dir', async () => {
    const dir = temp();
    const installed = await run(['install', '--extension-id', ID, '--dir', dir]);
    expect(installed.code).toBe(0);
    expect(installed.out).toContain(`Manifest: ${path.join(dir, 'dev.akibh.blockflow.json')}`);
    const removed = await run(['uninstall', '--dir', dir]);
    expect(removed.code).toBe(0);
    expect(removed.out).toContain('Removed:');
  });

  it('usage errors exit 2', async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(['frobnicate'])).code).toBe(2);
    expect((await run(['install', '--browser', 'netscape', '--extension-id', ID])).code).toBe(2);
    expect((await run(['install', '--browser', 'chrome'])).err).toMatch(/extension id/);
  });

  it('status reports an unreachable bridge', async () => {
    const status = await run(['status']);
    expect(status.code).toBe(1);
    expect(status.out).toMatch(/Bridge: BlockFlow is not reachable/);
  });
});
