// Starts what a CLI run talks to: a Chromium-based browser with the BlockFlow extension in a throwaway
// profile, its own native host manifest and a private bridge socket, with "Allow outside control" switched on.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** An error in the environment (no browser, no build, bridge not starting): exit code 2. */
export class InfraError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'InfraError';
  }
}

export const BUILD_COMMAND = 'npm run build:automation';
/** How long the extension's service worker and then the bridge socket may take to appear. */
export const START_TIMEOUT_MS = 30_000;

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Browsers installed by `npx playwright install chromium` (newest first).
 * @param {Record<string, string | undefined>} env
 */
function playwrightChromiums(env) {
  const cache = env.PLAYWRIGHT_BROWSERS_PATH ?? (process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Caches/ms-playwright') : process.platform === 'win32' ? path.join(env.LOCALAPPDATA ?? os.homedir(), 'ms-playwright') : path.join(os.homedir(), '.cache/ms-playwright'));
  try {
    const dirs = readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    return dirs.flatMap((dir) => [
      path.join(cache, dir, 'chrome-linux64/chrome'),
      path.join(cache, dir, 'chrome-linux/chrome'),
      path.join(cache, dir, 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium'),
      path.join(cache, dir, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
      path.join(cache, dir, 'chrome-win64/chrome.exe'),
      path.join(cache, dir, 'chrome-win/chrome.exe'),
    ]);
  } catch {
    return [];
  }
}

/**
 * Candidate browser executables, in order: `--browser`, `BLOCKFLOW_BROWSER` (or the e2e harness's
 * `BF_BROWSER`), Chromium, Brave, Chrome, Edge, then a Playwright-installed Chromium. Plain Chromium comes
 * first: it starts headless next to other browser instances, and branded Chrome 137+ ignores `--load-extension`.
 * @param {string | undefined} flag
 * @param {Record<string, string | undefined>} env
 */
export function browserCandidates(flag, env) {
  const programFiles = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  return /** @type {string[]} */ ([
    flag,
    env.BLOCKFLOW_BROWSER,
    env.BF_BROWSER,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/opt/brave.com/brave-origin/brave',
    '/opt/brave.com/brave/brave',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ...programFiles.flatMap((dir) => [path.join(/** @type {string} */ (dir), 'Chromium/Application/chrome.exe'), path.join(/** @type {string} */ (dir), 'Google/Chrome/Application/chrome.exe'), path.join(/** @type {string} */ (dir), 'BraveSoftware/Brave-Browser/Application/brave.exe')]),
    '/usr/bin/microsoft-edge',
    ...playwrightChromiums(env),
  ].filter(Boolean));
}

/**
 * The browser to launch. An explicit `--browser` / `BLOCKFLOW_BROWSER` that does not exist is an error
 * (it is never silently replaced by another browser).
 * @param {string | undefined} flag
 * @param {Record<string, string | undefined>} env
 * @param {(file: string) => boolean} [exists]
 */
export function findBrowser(flag, env, exists = existsSync) {
  const explicit = flag ?? env.BLOCKFLOW_BROWSER;
  if (explicit) {
    if (!exists(explicit)) throw new InfraError(`Browser not found: ${explicit}`);
    return explicit;
  }
  const found = browserCandidates(undefined, env).find((candidate) => exists(candidate));
  if (!found) throw new InfraError('No Chromium-based browser found. Install Chromium (or `npx playwright install chromium`), or pass --browser /path/to/chrome (BLOCKFLOW_BROWSER=... works too).');
  return found;
}

/**
 * The unpacked extension folder: `--extension`, `BLOCKFLOW_EXTENSION`, else `.output-automation/chrome-mv3`
 * in the working directory, the copy bundled into the published package (`extension/`, made by
 * `scripts/pack.mjs` at `npm pack`), or the BlockFlow repo this package lives in. It must hold a manifest.json.
 * @param {string | undefined} flag
 * @param {Record<string, string | undefined>} env
 * @param {string} cwd
 * @param {(file: string) => boolean} [exists]
 */
export function resolveExtension(flag, env, cwd, exists = existsSync) {
  const explicit = flag ?? env.BLOCKFLOW_EXTENSION;
  const candidates = explicit ? [path.resolve(cwd, explicit)] : [path.resolve(cwd, '.output-automation/chrome-mv3'), path.resolve(here, 'extension'), path.resolve(here, '../../.output-automation/chrome-mv3')];
  const found = candidates.find((dir) => exists(path.join(dir, 'manifest.json')));
  if (!found) {
    throw new InfraError(`BlockFlow extension build not found (looked for manifest.json in ${candidates.join(', ')}). Build it first: ${BUILD_COMMAND}${explicit ? '' : ' (or pass --extension <dir>)'}`);
  }
  return found;
}

/**
 * Private bridge paths for one profile. Unix: a socket and token inside the profile folder. Windows: a
 * named pipe with a random name (pipes do not live in folders) and the token in the profile.
 * @param {string} profile
 */
export function bridgePaths(profile) {
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\blockflow-cli-${randomBytes(6).toString('hex')}` : path.join(profile, 'bridge.sock');
  return { socket, tokenFile: path.join(profile, 'bridge-token'), hostsDir: path.join(profile, 'NativeMessagingHosts') };
}

/**
 * @typedef {{ call(method: string, params: unknown, options?: { onNotification?: (n: { method: string, params: any }) => void, timeoutMs?: number }): Promise<any>, close(): void | Promise<void> }} BridgeClient
 * @typedef {{ client: BridgeClient, info: { browser: string, extension: string, extensionId: string }, close(): Promise<void> }} BridgeSession
 * @typedef {{ headed: boolean, browser?: string, extension?: string, env: Record<string, string | undefined>, cwd: string, log?: (line: string) => void, startTimeoutMs?: number }} StartOptions
 */

/** @param {number} ms */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Loads `blockflow-bridge` (installHost, chromiumExtensionId, connectBridge) with a readable error when missing.
 */
async function loadBridge() {
  try {
    const [main, client] = await Promise.all([import('blockflow-bridge'), import('blockflow-bridge/client')]);
    return { installHost: main.installHost, isolatedHostDirs: main.isolatedHostDirs, chromiumExtensionId: main.chromiumExtensionId, connectBridge: client.connectBridge ?? main.connectBridge };
  } catch (error) {
    throw new InfraError(`Cannot load the blockflow-bridge package (${/** @type {Error} */ (error).message}). Run npm install in the BlockFlow repo.`);
  }
}

/**
 * Launches the browser and connects to the bridge. Everything it creates is undone by `close()`, which is
 * also run here when a later step fails. The caller must call `close()` on every path.
 * @param {StartOptions} options
 * @returns {Promise<BridgeSession>}
 */
export async function startBridge(options) {
  const { env, cwd, log = () => {} } = options;
  const timeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
  const executablePath = findBrowser(options.browser, env);
  const extension = resolveExtension(options.extension, env, cwd);
  const bridge = await loadBridge();
  const { chromium } = await import('playwright-core');

  const profile = mkdtempSync(path.join(os.tmpdir(), 'blockflow-cli-'));
  const paths = bridgePaths(profile);
  // Linux: some Chromium builds (Brave) read host manifests only from their default folder under $HOME, not
  // from --user-data-dir. Give the browser a throwaway HOME holding them too, never the real one.
  const isolatedHome = process.platform === 'linux' ? path.join(profile, 'home') : undefined;
  const hostDirs = isolatedHome && bridge.isolatedHostDirs ? bridge.isolatedHostDirs(profile, isolatedHome) : [paths.hostsDir];
  /** @type {import('playwright-core').BrowserContext | undefined} */
  let context;
  /** @type {BridgeClient | undefined} */
  let client;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await client?.close();
    } catch {}
    try {
      // A browser that hangs on close must not keep CI waiting.
      await Promise.race([context?.close(), delay(10_000)]);
    } catch {}
    // A browser still flushing its profile must not turn the run's outcome into a cleanup error.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      log(`note: could not remove the temporary profile ${profile}: ${/** @type {Error} */ (error).message}`);
    }
  };

  try {
    // Our own token (the host would create one too), so the client can read it as soon as the socket is up.
    writeFileSync(paths.tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    mkdirSync(paths.hostsDir, { recursive: true });
    const computedId = bridge.chromiumExtensionId(extension);
    await bridge.installHost({ extensionIds: [computedId], dirs: hostDirs });

    log(`browser: ${executablePath}`);
    log(`extension: ${extension}`);
    try {
      context = await chromium.launchPersistentContext(profile, {
        executablePath,
        headless: false,
        timeout: 60_000,
        viewport: { width: 1300, height: 850 },
        env: { ...env, ...(isolatedHome ? { HOME: isolatedHome } : {}), BLOCKFLOW_SOCKET: paths.socket, BLOCKFLOW_TOKEN_FILE: paths.tokenFile },
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run', '--no-default-browser-check', ...(options.headed ? [] : ['--headless=new'])],
      });
    } catch (error) {
      throw new InfraError(`Could not launch ${executablePath}: ${/** @type {Error} */ (error).message.split('\n')[0]}${options.headed && process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY ? ' (--headed needs a display: use xvfb-run, or drop --headed)' : ''}`);
    }
    const ctx = context;

    const isOurs = (/** @type {import('playwright-core').Worker} */ w) => w.url().startsWith('chrome-extension://') && w.url().endsWith('/background.js');
    let worker = ctx.serviceWorkers().find(isOurs) ?? ctx.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
    if (!worker) {
      worker = await ctx.waitForEvent('serviceworker', { timeout: timeoutMs }).catch(() => undefined);
      if (!worker) {
        throw new InfraError(`The BlockFlow extension did not start in ${path.basename(executablePath)} within ${timeoutMs / 1000} s. Branded Google Chrome 137+ ignores --load-extension: use Chromium (or --browser <chromium>).`);
      }
    }
    const extensionId = worker.url().split('/')[2];
    if (extensionId !== computedId) {
      // A manifest "key" (or a browser quirk) gave another id: allow it too, before the extension connects.
      await bridge.installHost({ extensionIds: [computedId, extensionId], dirs: hostDirs });
    }

    // An idle MV3 worker can be replaced; retry on a fresh one (as tests/e2e/harness.mjs does).
    /** @param {(arg: any) => unknown} fn @param {unknown} [arg] */
    const evaluate = async (fn, arg) => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await /** @type {import('playwright-core').Worker} */ (worker).evaluate(fn, arg);
        } catch (error) {
          if (attempt >= 3 || !/closed|destroyed|Target/i.test(String(error))) throw error;
          const next = ctx.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${extensionId}/`) && w !== worker);
          worker = next ?? (await ctx.waitForEvent('serviceworker', { timeout: 15_000 }).catch(() => worker));
        }
      }
    };
    await evaluate(() => chrome.storage.local.set({ 'bf:onboarding': { tryItDismissed: true }, 'bf:settings': { outsideControl: true } }));

    // The worker starts the native host (connectNative), which opens the socket.
    const deadline = Date.now() + timeoutMs;
    /** @type {unknown} */
    let lastError;
    while (Date.now() < deadline) {
      if (process.platform === 'win32' || existsSync(paths.socket)) {
        try {
          client = await bridge.connectBridge({ socketPath: paths.socket, tokenFile: paths.tokenFile, client: 'blockflow-runner', timeoutMs: 5_000 });
          break;
        } catch (error) {
          lastError = error;
        }
      }
      await delay(200);
    }
    if (!client) {
      // What the extension says about its native port (src/browser/bridge.ts writes it to storage.session), for the message.
      const status = await evaluate(() => chrome.storage.session.get('bf:bridge-status')).then((r) => /** @type {any} */ (r)['bf:bridge-status'], () => undefined);
      if (status) lastError = new Error(`extension bridge status: ${JSON.stringify(status)}${lastError ? `; ${/** @type {Error} */ (lastError).message}` : ''}`);
      throw new InfraError(
        `The BlockFlow bridge did not come up within ${timeoutMs / 1000} s (socket ${paths.socket}${lastError ? `; last error: ${/** @type {Error} */ (lastError).message}` : ', never created'}). ` +
          `Check that the build is the automation build (${BUILD_COMMAND}) and that node can run the native host.`,
      );
    }
    return { client, info: { browser: executablePath, extension, extensionId }, close };
  } catch (error) {
    await close();
    throw error;
  }
}
