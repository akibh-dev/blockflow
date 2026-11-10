// Real-browser check for the bridge (not part of vitest): Chromium's unpacked extension id vs
// chromiumExtensionId, and a native messaging round trip through a manifest that exists only in
// <profile>/NativeMessagingHosts. The extension side is a throwaway listener in the service worker.
//
//   BF_OUT_DIR=.output-bridge BF_E2E=1 npx wxt build
//   node tests/bridge/real-browser.mjs        (BF_BROWSER=/path/to/chromium, BF_EXTENSION_DIR=<build>/chrome-mv3)
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(root + '/package.json');
const { chromium } = require('playwright-core');
const { installHost, chromiumExtensionId } = await import(root + '/packages/bridge/install.mjs');
const { connectBridge } = await import(root + '/packages/bridge/client.mjs');

const exe = [process.env.BF_BROWSER, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => p && existsSync(p));
const extension = path.resolve(process.env.BF_EXTENSION_DIR ?? path.join(root, '.output-bridge/chrome-mv3'));
const profile = mkdtempSync(path.join(os.tmpdir(), 'bf-bridge-real-'));
const socket = path.join(profile, 'blockflow.sock');
const tokenFile = path.join(profile, 'blockflow-token');
const expected = chromiumExtensionId(extension);
installHost({ extensionIds: [expected], dirs: [path.join(profile, 'NativeMessagingHosts')] });
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: exe, headless: false, timeout: 60000,
  env: { ...process.env, BLOCKFLOW_SOCKET: socket, BLOCKFLOW_TOKEN_FILE: tokenFile },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run', '--headless=new'],
});
let ok = true;
try {
  let [w] = ctx.serviceWorkers();
  w ??= await ctx.waitForEvent('serviceworker');
  const actual = w.url().split('/')[2];
  console.log('browser', exe);
  console.log('extension id from browser:', actual, ' computed:', expected, actual === expected ? 'MATCH' : 'MISMATCH');
  ok &&= actual === expected;
  // Throwaway listener: connect, answer one request, record what came in.
  await w.evaluate(() => {
    globalThis.__got = [];
    const port = chrome.runtime.connectNative('dev.akibh.blockflow');
    globalThis.__port = port;
    port.onMessage.addListener((m) => {
      globalThis.__got.push(m);
      if (m.id !== undefined && m.method) {
        port.postMessage({ jsonrpc: '2.0', method: 'run.step', params: { requestId: m.id, runId: 'r1', step: { n: 1 } } });
        port.postMessage({ jsonrpc: '2.0', id: m.id, result: { echo: m.method, params: m.params } });
      }
    });
    port.onDisconnect.addListener(() => { globalThis.__disc = chrome.runtime.lastError?.message ?? 'disconnected'; });
  });
  const deadline = Date.now() + 10000;
  while (!existsSync(socket) && Date.now() < deadline) {
    const disc = await w.evaluate(() => globalThis.__disc);
    if (disc) { console.log('port disconnected:', disc); break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log('socket created by host:', existsSync(socket), 'token file:', existsSync(tokenFile));
  const bridge = await connectBridge({ socketPath: socket, tokenFile, client: 'real-check', timeoutMs: 5000 });
  console.log('auth ok, extensionConnected =', bridge.extensionConnected);
  const notes = [];
  const result = await bridge.call('hello', { protocol: 1, client: 'real-check' }, { onNotification: (n) => notes.push(n) });
  console.log('result', JSON.stringify(result), 'notifications', JSON.stringify(notes));
  const got = await w.evaluate(() => globalThis.__got);
  console.log('extension received', JSON.stringify(got));
  ok &&= result.echo === 'hello' && notes.length === 1 && notes[0].params.requestId === 2;
  // Disconnect from the extension: host should exit and remove the socket.
  await w.evaluate(() => globalThis.__port.disconnect());
  await bridge.closed;
  const d2 = Date.now() + 5000;
  while (existsSync(socket) && Date.now() < d2) await new Promise((r) => setTimeout(r, 100));
  console.log('socket removed after port.disconnect():', !existsSync(socket));
  ok &&= !existsSync(socket);
  console.log('token mode', statSync(tokenFile).mode.toString(8));
} finally {
  await ctx.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(ok ? 'REAL CHECK PASSED' : 'REAL CHECK FAILED');
process.exit(ok ? 0 : 1);
