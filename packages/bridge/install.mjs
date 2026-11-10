// Installs the native messaging host: a launcher script that runs host.mjs with this Node, and a host
// manifest (`dev.akibh.blockflow.json`) where each browser looks for it.
//
//   Linux/macOS: manifest files in each browser's NativeMessagingHosts folder.
//   Windows:     manifest files next to the launcher, plus an HKCU registry key per browser pointing at them.
//
// Chromium-family manifests list `allowed_origins` (chrome-extension://<id>/); Firefox's lists
// `allowed_extensions` (the gecko id from wxt.config.ts). `dirs` replaces the browser folders (CLI, e2e:
// <profile>/NativeMessagingHosts, which Chromium also reads).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_HOST_NAME } from './protocol.mjs';

export const FIREFOX_EXTENSION_ID = 'blockflow@akibh-dev';
export const MANIFEST_FILE = `${NATIVE_HOST_NAME}.json`;
export const CHROMIUM_BROWSERS = Object.freeze(['chrome', 'chromium', 'brave', 'brave-origin', 'edge']);
export const BROWSERS = Object.freeze([...CHROMIUM_BROWSERS, 'firefox']);
const DESCRIPTION = 'BlockFlow bridge: lets local programs (MCP server, CLI) drive the BlockFlow extension';
const HOST_SCRIPT = fileURLToPath(new URL('./host.mjs', import.meta.url));

/**
 * @typedef {'chrome' | 'chromium' | 'brave' | 'brave-origin' | 'edge' | 'firefox'} Browser
 * @typedef {string | { dir: string, kind?: 'chromium' | 'firefox' }} DirTarget
 * @typedef {{ platform?: NodeJS.Platform, home?: string, localAppData?: string }} Where
 * @typedef {{
 *   extensionIds?: string[],
 *   firefox?: boolean,
 *   browsers?: Browser[],
 *   dirs?: DirTarget[],
 *   hostScript?: string,
 *   launcherDir?: string,
 *   nodePath?: string,
 *   exec?: (file: string, args: string[]) => void,
 * } & Where} InstallOptions
 */

/**
 * The id Chromium gives an unpacked extension loaded from `absPath`: SHA-256 of the absolute path (bytes of
 * the platform's path string: UTF-8 on Linux/macOS, UTF-16LE with an upper-case drive letter on Windows),
 * first 32 hex digits, each mapped 0-f -> a-p. Symlinks are resolved first, as Chromium does.
 * @param {string} absPath
 * @param {{ platform?: NodeJS.Platform }} [options]
 */
export function chromiumExtensionId(absPath, options = {}) {
  const platform = options.platform ?? process.platform;
  let resolved = platform === 'win32' ? path.win32.resolve(absPath) : path.posix.resolve(absPath);
  if (platform === process.platform) {
    try {
      resolved = realpathSync(resolved);
    } catch {}
  }
  let bytes;
  if (platform === 'win32') {
    if (/^[a-z]:/.test(resolved)) resolved = resolved[0].toUpperCase() + resolved.slice(1);
    bytes = Buffer.from(resolved, 'utf16le');
  } else {
    bytes = Buffer.from(resolved, 'utf8');
  }
  const hex = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join('');
}

/** @param {Where} where */
function homeOf(where) {
  return where.home ?? os.homedir();
}

/**
 * Per-browser manifest folders (Linux, macOS) or registry keys (Windows).
 * @param {Browser} browser
 * @param {Where} [where]
 * @returns {{ dir?: string, registryKey?: string }}
 */
export function browserTarget(browser, where = {}) {
  const platform = where.platform ?? process.platform;
  const home = homeOf(where);
  if (platform === 'win32') {
    const keys = {
      chrome: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
      chromium: 'HKCU\\Software\\Chromium\\NativeMessagingHosts',
      brave: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
      'brave-origin': 'HKCU\\Software\\BraveSoftware\\Brave-Origin\\NativeMessagingHosts',
      edge: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
      firefox: 'HKCU\\Software\\Mozilla\\NativeMessagingHosts',
    };
    return { registryKey: `${keys[browser]}\\${NATIVE_HOST_NAME}` };
  }
  const join = path.posix.join;
  if (platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support');
    const dirs = {
      chrome: join(support, 'Google', 'Chrome', 'NativeMessagingHosts'),
      chromium: join(support, 'Chromium', 'NativeMessagingHosts'),
      brave: join(support, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
      'brave-origin': join(support, 'BraveSoftware', 'Brave-Origin', 'NativeMessagingHosts'),
      edge: join(support, 'Microsoft Edge', 'NativeMessagingHosts'),
      firefox: join(support, 'Mozilla', 'NativeMessagingHosts'),
    };
    return { dir: dirs[browser] };
  }
  const config = join(home, '.config');
  const dirs = {
    chrome: join(config, 'google-chrome', 'NativeMessagingHosts'),
    chromium: join(config, 'chromium', 'NativeMessagingHosts'),
    brave: join(config, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
    'brave-origin': join(config, 'BraveSoftware', 'Brave-Origin', 'NativeMessagingHosts'),
    edge: join(config, 'microsoft-edge', 'NativeMessagingHosts'),
    firefox: join(home, '.mozilla', 'native-messaging-hosts'),
  };
  return { dir: dirs[browser] };
}

/**
 * Manifest folders for a throwaway browser (CLI, e2e) on Linux/macOS: `<profile>/NativeMessagingHosts`,
 * which Chromium reads, plus every Chromium-family default folder under `home`, because some builds
 * (Brave, verified with Brave Origin on Linux) ignore `--user-data-dir` here and only read the default folder.
 * Start the browser with `HOME=home` so nothing is written to the real home folder.
 * @param {string} profile @param {string} home @param {Where} [where]
 * @returns {string[]}
 */
export function isolatedHostDirs(profile, home, where = {}) {
  const defaults = CHROMIUM_BROWSERS.map((browser) => browserTarget(browser, { ...where, home }).dir).filter((dir) => typeof dir === 'string');
  return [path.join(profile, 'NativeMessagingHosts'), ...defaults];
}

/**
 * Where the launcher (and, on Windows, the manifests) go by default.
 * @param {Where} [where]
 */
export function defaultLauncherDir(where = {}) {
  const platform = where.platform ?? process.platform;
  const home = homeOf(where);
  if (platform === 'win32') return path.win32.join(where.localAppData ?? process.env.LOCALAPPDATA ?? path.win32.join(home, 'AppData', 'Local'), 'BlockFlow');
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'BlockFlow');
  return path.posix.join(home, '.config', 'blockflow', 'bridge');
}

/** @param {NodeJS.Platform} platform @param {string} dir */
export function launcherPath(platform, dir) {
  return platform === 'win32' ? path.win32.join(dir, 'blockflow-bridge-host.cmd') : path.posix.join(dir, 'blockflow-bridge-host');
}

/**
 * The launcher text: runs host.mjs with this Node (the browser starts hosts with a minimal PATH, so the
 * absolute `process.execPath` is written in).
 * @param {{ platform?: NodeJS.Platform, nodePath?: string, hostScript?: string }} [options]
 */
export function launcherScript(options = {}) {
  const platform = options.platform ?? process.platform;
  const node = options.nodePath ?? process.execPath;
  const script = options.hostScript ?? HOST_SCRIPT;
  if (platform === 'win32') return `@echo off\r\n"${node}" "${script}" %*\r\n`;
  const quote = (/** @type {string} */ text) => `'${text.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh\n# BlockFlow native messaging host (written by blockflow-bridge install)\nexec ${quote(node)} ${quote(script)} "$@"\n`;
}

/**
 * Manifest content for one browser family.
 * @param {'chromium' | 'firefox'} kind @param {string} launcher @param {string[]} [extensionIds]
 */
export function hostManifest(kind, launcher, extensionIds = []) {
  const base = { name: NATIVE_HOST_NAME, description: DESCRIPTION, path: launcher, type: 'stdio' };
  if (kind === 'firefox') return { ...base, allowed_extensions: [FIREFOX_EXTENSION_ID] };
  return { ...base, allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`) };
}

/**
 * `reg` arguments that register a manifest for one browser (Windows).
 * @param {string} registryKey @param {string} manifestPath
 */
export function registryAddArgs(registryKey, manifestPath) {
  return ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'];
}
/** @param {string} registryKey */
export function registryDeleteArgs(registryKey) {
  return ['delete', registryKey, '/f'];
}

/** @param {InstallOptions} options @returns {Browser[]} */
function selectedBrowsers(options) {
  if (options.browsers?.length) return options.browsers;
  const chromium = options.extensionIds?.length ? [...CHROMIUM_BROWSERS] : [];
  return /** @type {Browser[]} */ ([...chromium, ...(options.firefox ? ['firefox'] : [])]);
}

/** @param {string} id */
function checkId(id) {
  if (!/^[a-p]{32}$/.test(id)) throw new Error(`"${id}" is not a Chromium extension id (32 letters a-p; see BlockFlow Settings)`);
}

/**
 * Writes the launcher and the manifests. Returns what it wrote.
 * @param {InstallOptions} options
 * @returns {{ launcher: string, manifests: string[], registry: { key: string, manifest: string }[] }}
 */
export function installHost(options) {
  const platform = options.platform ?? process.platform;
  const extensionIds = options.extensionIds ?? [];
  extensionIds.forEach(checkId);
  /** @type {{ dir: string, kind: 'chromium' | 'firefox', registryKey?: string, file: string }[]} */
  const targets = [];
  if (options.dirs?.length) {
    for (const target of options.dirs) {
      const { dir, kind = 'chromium' } = typeof target === 'string' ? { dir: target } : target;
      targets.push({ dir, kind, file: MANIFEST_FILE });
    }
  } else {
    const launcherDir = options.launcherDir ?? defaultLauncherDir(options);
    for (const browser of selectedBrowsers(options)) {
      const kind = browser === 'firefox' ? 'firefox' : 'chromium';
      const { dir, registryKey } = browserTarget(browser, options);
      if (registryKey) targets.push({ dir: launcherDir, kind, registryKey, file: kind === 'firefox' ? `${NATIVE_HOST_NAME}.firefox.json` : MANIFEST_FILE });
      else if (dir) targets.push({ dir, kind, file: MANIFEST_FILE });
    }
  }
  if (!targets.length) throw new Error('Nothing to install: give --extension-id <id> (Chrome, Chromium, Brave, Edge) and/or --browser firefox');
  if (targets.some((target) => target.kind === 'chromium') && !extensionIds.length) {
    throw new Error('Chromium-family browsers need the extension id: --extension-id <id> (shown in BlockFlow Settings)');
  }

  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const launcherDir = options.launcherDir ?? (options.dirs?.length ? targets[0].dir : defaultLauncherDir(options));
  const launcher = launcherPath(platform, launcherDir);
  mkdirSync(launcherDir, { recursive: true });
  writeFileSync(launcher, launcherScript({ platform, nodePath: options.nodePath, hostScript: options.hostScript }), { mode: 0o755 });
  if (platform !== 'win32') chmodSync(launcher, 0o755);

  const manifests = [];
  const registry = [];
  const exec = options.exec ?? ((file, args) => void execFileSync(file, args, { stdio: 'ignore' }));
  for (const target of targets) {
    mkdirSync(target.dir, { recursive: true });
    const file = join(target.dir, target.file);
    writeFileSync(file, `${JSON.stringify(hostManifest(target.kind, launcher, extensionIds), null, 2)}\n`);
    manifests.push(file);
    if (target.registryKey) {
      exec('reg', registryAddArgs(target.registryKey, file));
      registry.push({ key: target.registryKey, manifest: file });
    }
  }
  return { launcher, manifests: [...new Set(manifests)], registry };
}

/**
 * Removes what `installHost` wrote (missing files are fine).
 * @param {Omit<InstallOptions, 'extensionIds' | 'firefox' | 'hostScript' | 'nodePath'> & { browsers?: Browser[] }} [options]
 * @returns {{ removed: string[], registry: string[] }}
 */
export function uninstallHost(options = {}) {
  const platform = options.platform ?? process.platform;
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const removed = [];
  const registry = [];
  const exec = options.exec ?? ((file, args) => void execFileSync(file, args, { stdio: 'ignore' }));
  const remove = (/** @type {string} */ file) => {
    if (!existsSync(file)) return;
    rmSync(file, { force: true });
    removed.push(file);
  };
  let launcherDir = options.launcherDir;
  if (options.dirs?.length) {
    for (const target of options.dirs) remove(join(typeof target === 'string' ? target : target.dir, MANIFEST_FILE));
    launcherDir ??= typeof options.dirs[0] === 'string' ? options.dirs[0] : options.dirs[0].dir;
  } else {
    launcherDir ??= defaultLauncherDir(options);
    for (const browser of options.browsers?.length ? options.browsers : BROWSERS) {
      const { dir, registryKey } = browserTarget(browser, options);
      if (dir) remove(join(dir, MANIFEST_FILE));
      if (registryKey) {
        try {
          exec('reg', registryDeleteArgs(registryKey));
          registry.push(registryKey);
        } catch {}
      }
    }
    if (platform === 'win32') {
      remove(join(launcherDir, MANIFEST_FILE));
      remove(join(launcherDir, `${NATIVE_HOST_NAME}.firefox.json`));
    }
  }
  remove(launcherPath(platform, launcherDir));
  return { removed, registry };
}

/**
 * Manifests that exist now, per browser (for `status`).
 * @param {Where} [where]
 */
export function findManifests(where = {}) {
  const platform = where.platform ?? process.platform;
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  /** @type {{ browser: Browser, file: string }[]} */
  const found = [];
  for (const browser of BROWSERS) {
    const { dir } = browserTarget(browser, where);
    if (dir && existsSync(join(dir, MANIFEST_FILE))) found.push({ browser, file: join(dir, MANIFEST_FILE) });
  }
  if (platform === 'win32') {
    const dir = defaultLauncherDir(where);
    for (const [browser, file] of /** @type {[Browser, string][]} */ ([['chrome', MANIFEST_FILE], ['firefox', `${NATIVE_HOST_NAME}.firefox.json`]])) {
      if (existsSync(join(dir, file))) found.push({ browser, file: join(dir, file) });
    }
  }
  return found;
}
