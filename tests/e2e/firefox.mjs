// Firefox end-to-end smoke test. Playwright cannot load extensions into Firefox, so this drives
// Firefox directly over WebDriver BiDi: it installs the e2e build (.output-e2e/firefox-mv3) as a
// temporary add-on and runs workflows through the real background script (the same
// `bf:run-workflow` message the Chromium specs use, sent through the e2e-only bridge content
// script from a fixture page), then checks the run records.
//
// Usage: npm run e2e:firefox        (BF_FIREFOX=/path/to/firefox, BF_HEADED=1 to watch it)
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASSWORD, startServer } from './server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extension = path.resolve(here, '../../.output-e2e/firefox-mv3');
const GECKO_ID = 'blockflow@akibh-dev';
const firefox = [process.env.BF_FIREFOX, '/usr/bin/firefox', '/Applications/Firefox.app/Contents/MacOS/firefox'].filter(Boolean).find((candidate) => existsSync(candidate));
if (!firefox) throw new Error('No Firefox found. Set BF_FIREFOX=/path/to/firefox');
if (!existsSync(path.join(extension, 'manifest.json'))) throw new Error('Build first: BF_E2E=1 npx wxt build -b firefox (npm run e2e:firefox does it)');

/** A free TCP port for Firefox's remote agent. */
function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Minimal WebDriver BiDi client: `send(method, params)` resolves with the command's result. */
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id === undefined || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.type === 'error') reject(new Error(`${message.error}: ${message.message}`));
    else resolve(message.result);
  });
  return {
    send(method, params = {}) {
      nextId += 1;
      const id = nextId;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close: () => socket.close(),
  };
}

// --- launch ----------------------------------------------------------------------------

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
const profile = mkdtempSync(path.join(os.tmpdir(), 'blockflow-ff-'));
const uuid = randomUUID();
// A fixed moz-extension:// UUID, so the editor URL is known; no first-run pages; no update checks.
writeFileSync(
  path.join(profile, 'user.js'),
  [
    `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [GECKO_ID]: uuid }))});`,
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("app.update.enabled", false);',
    'user_pref("extensions.update.enabled", false);',
    'user_pref("browser.download.folderList", 2);',
    `user_pref("browser.download.dir", ${JSON.stringify(path.join(profile, 'downloads'))});`,
    'user_pref("browser.download.useDownloadDir", true);',
  ].join('\n'),
);
// M4 bridge: Firefox reads native-messaging host manifests only from ~/.mozilla/native-messaging-hosts, so
// it runs with a throwaway HOME holding the manifest (never the real one), and a private socket and token.
const { installHost } = await import('../../packages/bridge/install.mjs');
const fakeHome = path.join(profile, 'home');
const bridgePaths = { socket: path.join(profile, 'blockflow.sock'), tokenFile: path.join(profile, 'blockflow-token') };
installHost({ dirs: [{ dir: path.join(fakeHome, '.mozilla', 'native-messaging-hosts'), kind: 'firefox' }], firefox: true, extensionIds: [] });
const port = await freePort();
const child = spawn(firefox, ['--no-remote', '--profile', profile, `--remote-debugging-port=${port}`, ...(process.env.BF_HEADED ? [] : ['--headless'])], {
  stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, HOME: fakeHome, BLOCKFLOW_SOCKET: bridgePaths.socket, BLOCKFLOW_TOKEN_FILE: bridgePaths.tokenFile },
});
let stderr = '';
child.stderr.on('data', (chunk) => (stderr += chunk));
const wsUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Firefox did not start its remote agent:\n${stderr.slice(-2000)}`)), 30_000);
  const poll = setInterval(() => {
    const match = /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(stderr);
    if (match) {
      clearInterval(poll);
      clearTimeout(timer);
      resolve(`${match[1]}/session`);
    }
  }, 100);
});
const bidi = await connect(wsUrl);
const { capabilities } = await bidi.send('session.new', { capabilities: {} }).catch(() => ({ capabilities: {} }));
const version = capabilities?.browserVersion ? `Firefox ${capabilities.browserVersion}` : '';
await bidi.send('webExtension.install', { extensionData: { type: 'path', path: extension } });

// Firefox's BiDi cannot open moz-extension:// pages, so a fixture page talks to the extension through
// the e2e-only bridge content script (src/entrypoints/e2e-bridge.content.ts).
const { context: driver } = await bidi.send('browsingContext.create', { type: 'tab' });

/** Sends one bridge request from the driver page and returns its result. */
async function bridge(op, arg) {
  const result = await bidi.send('script.callFunction', {
    functionDeclaration: `(op, arg) => new Promise((resolve) => {
      const id = Math.random();
      const onReply = (event) => {
        if (event.source !== window || !event.data || event.data.bfE2eReply !== id) return;
        window.removeEventListener('message', onReply);
        resolve(JSON.stringify(event.data));
      };
      window.addEventListener('message', onReply);
      window.postMessage({ bfE2e: id, op, arg: JSON.parse(arg) }, '*');
      setTimeout(() => resolve(JSON.stringify({ ok: false, error: 'no answer from the bridge' })), 5000);
    })`,
    arguments: [{ type: 'string', value: op }, { type: 'string', value: JSON.stringify(arg ?? null) }],
    target: { context: driver },
    awaitPromise: true,
  });
  if (result.type === 'exception') throw new Error(result.exceptionDetails?.text ?? 'script failed');
  const reply = JSON.parse(result.result.value);
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

// The bridge is registered by the background script when it starts; reload until it answers.
for (let attempt = 0; ; attempt += 1) {
  await bidi.send('browsingContext.navigate', { context: driver, url: `${base}/welcome.html`, wait: 'complete' });
  if ((await bridge('ping').catch(() => null)) === 'pong') break;
  if (attempt > 20) throw new Error('The e2e bridge never answered (is this an e2e build?)');
  await new Promise((resolve) => setTimeout(resolve, 500));
}

// --- helpers (same shape as harness.mjs) -------------------------------------------------

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};
let counter = 0;
function workflow(name, nodes, edges) {
  counter += 1;
  const lines = edges ?? nodes.slice(1).map((node, index) => [nodes[index].id, node.id]);
  return {
    schemaVersion: 2,
    id: `ff-${counter}`,
    name,
    enabled: false,
    nodes: nodes.map((node, index) => ({ position: { x: index * 240, y: 0 }, config: {}, ...node })),
    edges: lines.map(([source, target, port]) => ({ id: `${source}-${port ?? ''}-${target}`, source, target, ...(port ? { sourcePort: port } : {}) })),
  };
}
async function run(wf) {
  // Runs of this workflow from before: the same workflow may run twice in a row (see harness.mjs).
  const readRuns = async () => (await bridge('get', 'bf:runs'))['bf:runs'] ?? [];
  const seen = new Set((await readRuns()).filter((candidate) => candidate.workflowId === wf.id).map((candidate) => candidate.id));
  await bridge('send', { type: 'bf:run-workflow', workflow: wf });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const runs = await readRuns();
    const done = runs.findLast((candidate) => candidate.workflowId === wf.id && !seen.has(candidate.id) && candidate.status !== 'running');
    if (done) return done;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Run of ${wf.name} did not finish`);
}
const step = (record, id) => record.steps.find((candidate) => candidate.nodeId === id);
const summary = (record) => record.steps.map((s) => `${s.nodeId}:${s.status}${s.error ? ` (${s.error})` : ''}`).join(' → ');

// --- scenarios ----------------------------------------------------------------------------

console.log(`BlockFlow Firefox e2e · ${version || path.basename(firefox)} · ${base}`);
try {

  {
    const record = await run(workflow('login', [
      { id: 'open', type: 'open-url', config: { url: `${base}/login.html`, active: false } },
      {
        id: 'form',
        type: 'fill-form',
        config: {
          fields: [
            { locator: 'label=Email', value: 'akib@test.dev' },
            { locator: 'label=Password', value: PASSWORD },
            { locator: 'label=Country', value: 'Bangladesh' },
            { locator: 'label="Remember me"', value: 'true' },
          ],
          submit: 'role=button[name="Sign in"]',
        },
      },
      { id: 'wait', type: 'wait-for', config: { mode: 'url', url: '/welcome' } },
      { id: 'assert', type: 'assert', config: { subject: 'text', locator: '#greeting', operator: 'equals', expected: 'Welcome, akib!' } },
      { id: 'meta', type: 'read-element', config: { locator: 'text=Country', url: '' } },
      { id: 'close', type: 'close-tab' },
    ]));
    check('login form: fill form, submit, wait for URL, assert', record.status === 'passed', summary(record));
    check('select and checkbox submitted', String(step(record, 'meta')?.output?.value).includes('Country: bd · Remember: on'), String(step(record, 'meta')?.output?.value));
  }

  {
    const record = await run(workflow('html', [
      { id: 'get', type: 'http-request', config: { url: `${base}/table.html` } },
      { id: 'table', type: 'extract-table', config: { source: 'html', html: '{{body}}', baseUrl: '{{url}}', locator: 'table' } },
    ]));
    const rows = step(record, 'table')?.output?.rows;
    check('HTTP Request + Extract Table from HTML (background parser, no offscreen document)', record.status === 'passed' && Array.isArray(rows) && rows.length > 0, summary(record));
  }

  {
    const record = await run(workflow('read url', [
      { id: 'read', type: 'read-element', config: { url: `${base}/table.html`, locator: '#prices th' } },
      { id: 'again', type: 'read-element', config: { url: `${base}/table.html`, locator: '#prices th' } },
    ]));
    check('Read Element with a URL (watch tab in storage.session), twice', record.status === 'passed' && step(record, 'again')?.output?.value === 'Product', summary(record));
  }

  {
    const upload = await run(workflow('upload', [
      { id: 'open', type: 'open-url', config: { url: `${base}/upload.html`, active: false } },
      { id: 'up', type: 'upload-file', config: { locator: 'label=Upload CV', content: 'name,city\nAkib,Dhaka', filename: 'cv.csv', mime: 'text/csv' } },
      { id: 'read', type: 'read-element', config: { locator: '#out', url: '' } },
      { id: 'close', type: 'close-tab' },
    ]));
    check('Upload File', step(upload, 'read')?.output?.value === 'cv.csv|text/csv|name,city Akib,Dhaka', summary(upload));

    const dialogs = await run(workflow('dialogs', [
      { id: 'open', type: 'open-url', config: { url: `${base}/dialogs.html`, active: false } },
      { id: 'no', type: 'dialogs', config: { action: 'dismiss' } },
      { id: 'del', type: 'click', config: { locator: '#del' } },
      { id: 'kept', type: 'assert', config: { subject: 'text', locator: '#result', operator: 'equals', expected: 'kept' } },
      { id: 'yes', type: 'dialogs', config: { action: 'accept', text: 'Akib' } },
      { id: 'ask', type: 'click', config: { locator: '#ask' } },
      { id: 'hi', type: 'assert', config: { subject: 'text', locator: '#result', operator: 'equals', expected: 'Hi Akib' } },
      { id: 'read', type: 'dialogs', config: { action: 'read' } },
      { id: 'close', type: 'close-tab' },
    ]));
    const popup = await run(workflow('popup', [
      { id: 'open', type: 'open-url', config: { url: `${base}/popup.html`, active: false } },
      { id: 'click', type: 'click', config: { locator: 'role=button[name="Open help"]' } },
      { id: 'catch', type: 'wait-for-popup', config: { name: 'help' } },
      { id: 'read', type: 'read-element', config: { locator: 'h1', url: '', tab: 'help' } },
      { id: 'close1', type: 'close-tab', config: { tab: 'help' } },
      { id: 'close2', type: 'close-tab' },
    ]));
    check('Wait for Popup (window.open)', popup.status === 'passed' && step(popup, 'read')?.output?.value === 'Prices', summary(popup));
    check('Dialogs (confirm dismissed, prompt answered)', dialogs.status === 'passed' && step(dialogs, 'read')?.output?.lastDialog === 'Your name?', summary(dialogs));
  }

  {
    const record = await run(workflow('data', [
      { id: 'table', type: 'data-table', config: { text: 'name,n\na,1\nb,2\nc,3', into: 'rows' } },
      { id: 'loop', type: 'for-each', config: { list: 'rows', as: 'row' } },
      { id: 'save', type: 'save-dataset', config: { dataset: 'ff-e2e', value: 'row', mode: 'append' } },
    ], [['table', 'loop'], ['loop', 'save', 'each']]));
    check('Data Table → For Each → Save to Dataset (IndexedDB)', record.status === 'passed' && record.steps.filter((s) => s.nodeId === 'save').length === 3, summary(record));
  }

  {
    const record = await run(workflow('delay', [
      { id: 's', type: 'start', config: { inputs: [{ name: 'x', value: '1' }] } },
      { id: 'd', type: 'timer', config: { seconds: 2 } },
      { id: 'log', type: 'log', config: { message: 'after {{x}}' } },
    ]));
    check('Timer delay waits inside the run', record.status === 'passed' && step(record, 'log')?.status === 'passed', summary(record));
  }

  {
    const record = await run(workflow('fail', [
      { id: 'open', type: 'open-url', config: { url: `${base}/login.html`, where: 'window' } },
      { id: 'bad', type: 'click', config: { locator: '#does-not-exist' }, step: { timeoutSeconds: 2 } },
    ]));
    check('a failing step fails the run with a readable error', record.status === 'failed' && /does-not-exist|not found|No element/i.test(step(record, 'bad')?.error ?? ''), summary(record));
    check('…and gets a screenshot (tabs.captureVisibleTab)', Boolean(step(record, 'bad')?.screenshot), JSON.stringify(step(record, 'bad')));
  }

  {
    const script = await run(workflow('script', [
      { id: 'open', type: 'open-url', config: { url: `${base}/login.html`, active: false } },
      { id: 'js', type: 'run-script', config: { code: 'return 1 + 1' } },
    ]));
    check('Run Script explains it is not available', script.status === 'failed' && /Chrome|userScripts|not available|Firefox/i.test(step(script, 'js')?.error ?? ''), step(script, 'js')?.error ?? summary(script));

    const real = await run(workflow('real', [
      { id: 'open', type: 'open-url', config: { url: `${base}/login.html`, active: false } },
      { id: 'c', type: 'click', config: { locator: 'role=button[name="Sign in"]' }, step: { realInput: true, timeoutSeconds: 5 } },
    ]));
    check('real input explains it needs Chromium', real.status === 'failed' && /Chrom|debugger/i.test(step(real, 'c')?.error ?? ''), step(real, 'c')?.error ?? summary(real));
  }

  {
    // M2 page work, synthetic input (real input is Chromium-only): locator filters, role states, the new
    // Assert subjects, click options, Element Action, Drag, drop zones. Same fixtures as the Chromium specs.
    const locators = await run(workflow('m2 locators', [
      { id: 'open', type: 'open-url', config: { url: `${base}/m2.html`, active: false } },
      { id: 'del', type: 'click', config: { locator: 'role=listitem >> has-text=Banana >> role=button[name="Delete"]' } },
      { id: 'deleted', type: 'assert', config: { subject: 'text', locator: '#status', operator: 'equals', expected: 'deleted Banana' } },
      { id: 'rows', type: 'assert', config: { subject: 'count', locator: 'li >> visible >> has=button', operator: 'equals', expected: '2' } },
      { id: 'bold', type: 'click', config: { locator: 'role=button[name="Bold"][pressed=false]' } },
      { id: 'pressed', type: 'assert', config: { subject: 'text', locator: 'role=button[pressed]', operator: 'equals', expected: 'Bold' } },
      { id: 'save', type: 'click', config: { locator: '#missing || button >> has-text=Save >> visible' } },
      { id: 'saved', type: 'assert', config: { subject: 'text', locator: '#status', operator: 'equals', expected: 'saved' } },
      { id: 'class', type: 'assert', config: { subject: 'class', locator: '#save', operator: 'contains', expected: 'primary' } },
      { id: 'css', type: 'assert', config: { subject: 'css', locator: '#save', name: 'color', operator: 'equals', expected: 'rgb(0, 128, 0)' } },
      { id: 'name', type: 'assert', config: { subject: 'accessible-name', locator: '#email', operator: 'equals', expected: 'Email address' } },
      { id: 'editable', type: 'assert', config: { subject: 'editable', locator: '#email' } },
      { id: 'close', type: 'close-tab' },
    ]));
    check('locator filters, ||, role states, class / css / accessible-name / editable asserts', locators.status === 'passed', summary(locators));

    const clicks = await run(workflow('m2 clicks', [
      { id: 'open', type: 'open-url', config: { url: `${base}/clicks.html`, active: false } },
      { id: 'mid', type: 'click', config: { locator: '#target', button: 'middle', modifiers: 'Shift', position: '5,6' } },
      { id: 'triple', type: 'click', config: { locator: '#target', clickCount: 3, modifiers: 'Control+Alt', position: '20,10' } },
      { id: 'read', type: 'read-element', config: { locator: '#log', url: '' } },
      { id: 'focus', type: 'element-action', config: { locator: 'label=Name', action: 'focus' } },
      { id: 'r1', type: 'read-element', config: { locator: '#focus-state', url: '' } },
      { id: 'event', type: 'element-action', config: { locator: '#custom-target', action: 'dispatch-event', eventType: 'my-event', detail: '{"n": 2}' } },
      { id: 'r2', type: 'read-element', config: { locator: '#custom', url: '' } },
      { id: 'close', type: 'close-tab' },
    ]));
    const log = String(step(clicks, 'read')?.output?.value ?? '').split(';').map((line) => line.trim()).filter(Boolean);
    const wanted = ['auxclick 1 1 Shift 5,6 false', 'click 0 1 Alt+Control 20,10 false', 'click 0 2 Alt+Control 20,10 false', 'dblclick 0 2 Alt+Control 20,10 false', 'click 0 3 Alt+Control 20,10 false'];
    check('click options: middle button, modifiers, position, click count', JSON.stringify(log) === JSON.stringify(wanted), `${JSON.stringify(log)} ${summary(clicks)}`);
    check('Element Action: focus, CustomEvent with detail', step(clicks, 'r1')?.output?.value === 'focused' && step(clicks, 'r2')?.output?.value === 'custom-target {"n":2}', `${step(clicks, 'r1')?.output?.value} | ${step(clicks, 'r2')?.output?.value} ${summary(clicks)}`);

    const drag = await run(workflow('m2 drag', [
      { id: 'open', type: 'open-url', config: { url: `${base}/dnd.html`, active: false } },
      { id: 'sort', type: 'drag', config: { from: '#list >> text=Apple', to: '#list >> text=Cherry' } },
      { id: 'order', type: 'read-element', config: { locator: '#order', url: '' } },
      { id: 'slide', type: 'drag', config: { from: 'role=slider', to: '#track', toPosition: '150,10' } },
      { id: 'value', type: 'read-element', config: { locator: '#value', url: '' } },
      { id: 'close', type: 'close-tab' },
    ]));
    const dropped = await run(workflow('m2 drop zone', [
      { id: 'open', type: 'open-url', config: { url: `${base}/upload.html`, active: false } },
      { id: 'drop', type: 'upload-file', config: { locator: 'text=Drop files here', target: 'dropzone', content: 'hello', filename: 'hi.txt' } },
      // The page reads the file asynchronously (file.text()): wait for it to show.
      { id: 'shown', type: 'wait-for', config: { mode: 'text', locator: '#dropped', text: 'hi.txt' }, step: { timeoutSeconds: 5 } },
      { id: 'read', type: 'read-element', config: { locator: '#dropped', url: '' } },
      { id: 'close', type: 'close-tab' },
    ]));
    check('Upload File onto a drop zone', step(dropped, 'read')?.output?.value === 'hi.txt|text/plain|hello', `${JSON.stringify(step(dropped, 'read')?.output)} ${summary(dropped)}`);
    check('Drag: HTML5 sortable list and pointer slider', step(drag, 'order')?.output?.value === 'Banana,Cherry,Apple' && step(drag, 'value')?.output?.value === '75', `${step(drag, 'order')?.output?.value} ${step(drag, 'value')?.output?.value} ${summary(drag)}`);
  }

  {
    // M2: downloads, screenshots (tabs.captureTab), cookies and storage, requests.
    const downloads = await run(workflow('downloads', [
      { id: 'open', type: 'open-url', config: { url: `${base}/m2-browser.html`, active: false } },
      { id: 'csv', type: 'click', config: { locator: 'text=Export CSV' } },
      { id: 'wait', type: 'wait-for-download', config: { url: 'export.csv', read: 'csv' } },
      { id: 'blob', type: 'click', config: { locator: '#blob' } },
      { id: 'json', type: 'wait-for-download', config: { url: '*.json', read: 'json' } },
      { id: 'close', type: 'close-tab' },
    ]));
    const csv = step(downloads, 'wait')?.output;
    check('Wait for Download: CSV (file name, size, rows)', csv?.download?.filename === 'export.csv' && csv?.download?.size === 21 && csv?.rows?.[1]?.name === 'cup', JSON.stringify(csv ?? summary(downloads)).slice(0, 600));
    check('Wait for Download: a blob: file read as JSON', step(downloads, 'json')?.output?.download?.filename === 'orders.json' && step(downloads, 'json')?.output?.data?.[1]?.name === 'cup', JSON.stringify(step(downloads, 'json')?.output ?? summary(downloads)).slice(0, 600));

    const shots = await run(workflow('screenshots', [
      { id: 'open', type: 'open-url', config: { url: `${base}/m2-browser.html`, active: false } },
      { id: 'visible', type: 'screenshot', config: {} },
      { id: 'full', type: 'screenshot', config: { area: 'full' } },
      { id: 'element', type: 'screenshot', config: { area: 'element', locator: '#card', format: 'jpeg' } },
      { id: 'close', type: 'close-tab' },
    ]));
    const size = (id) => step(shots, id)?.output?.screenshot;
    const ratio = size('element') ? size('element').width / 300 : 0;
    check('Screenshot: visible area of a background tab (captureTab)', size('visible')?.width > 0 && Boolean(step(shots, 'visible')?.screenshot), JSON.stringify(size('visible') ?? summary(shots)));
    check('Screenshot: full page (captureTab rect)', size('full')?.height > 2600 && size('full').height > size('visible')?.height, JSON.stringify(size('full') ?? summary(shots)));
    check('Screenshot: element (captureTab rect)', ratio > 0 && Math.abs(size('element').height / ratio - 120) <= 2, JSON.stringify(size('element') ?? summary(shots)));

    const cookies = await run(workflow('cookies', [
      { id: 'open', type: 'open-url', config: { url: `${base}/login-cookie`, active: false } },
      { id: 'sid', type: 'cookies-storage', config: { action: 'get', name: 'sid' } },
      { id: 'set', type: 'cookies-storage', config: { action: 'set', name: 'theme', value: 'dark' } },
      { id: 'go', type: 'navigate', config: { action: 'goto', url: `${base}/whoami` } },
      { id: 'sent', type: 'read-element', config: { locator: 'body', url: '' } },
      { id: 'clear', type: 'cookies-storage', config: { action: 'clear' } },
      { id: 'all', type: 'cookies-storage', config: { action: 'get' } },
      { id: 'lset', type: 'cookies-storage', config: { area: 'local', action: 'set', name: 'token', value: 'abc' } },
      { id: 'lget', type: 'cookies-storage', config: { area: 'local', action: 'get', name: 'token' } },
      { id: 'close', type: 'close-tab' },
    ]));
    check('Cookies: HttpOnly read, set is sent, clear', step(cookies, 'sid')?.output?.value === 's3cret' && /theme=dark/.test(String(step(cookies, 'sent')?.output?.value)) && JSON.stringify(step(cookies, 'all')?.output?.value) === '{}', summary(cookies));
    check('Storage: localStorage set and get', step(cookies, 'lget')?.output?.value === 'abc', summary(cookies));

    const network = await run(workflow('requests', [
      { id: 'open', type: 'open-url', config: { url: `${base}/m2-browser.html`, active: false } },
      { id: 'send', type: 'click', config: { locator: '#send' } },
      { id: 'req', type: 'wait-for', config: { mode: 'request', url: '/api/save', method: 'POST' } },
      { id: 'body', type: 'wait-for', config: { mode: 'response', url: '/api/save', captureBody: true }, step: { timeoutSeconds: 5 } },
      { id: 'close', type: 'close-tab' },
    ]));
    check('Wait For request: POST with its body (webRequest)', JSON.parse(step(network, 'req')?.output?.request?.postData ?? '{}').item === 'mug', summary(network));
    check('Wait For response body explains it needs Chromium', step(network, 'body')?.code === 'permission.missing' && /Chrome/.test(step(network, 'body')?.error ?? ''), summary(network));
  }

  {
    // M3: browser rules (declarativeNetRequest) work on Firefox; CDP features fail clearly.
    const rules = JSON.stringify([
      { url: '**/api/m3-mock', action: 'abort' },
      { url: '**/api/m3-redirect', action: 'redirect', redirectUrl: `${base}/export.csv` },
    ]);
    const routed = await run(workflow('m3 dnr route', [
      { id: 'open', type: 'open-url', config: { url: `${base}/m3-route.html`, active: false } },
      { id: 'route', type: 'route', config: { backend: 'dnr', rules } },
      { id: 'block', type: 'click', config: { locator: '#mock' } },
      { id: 'blocked', type: 'assert', config: { subject: 'text', locator: '#mock-result', operator: 'equals', expected: 'blocked' } },
      { id: 'redirect', type: 'click', config: { locator: '#redirect' } },
      { id: 'redirected', type: 'assert', config: { subject: 'text', locator: '#redirect-result', operator: 'contains', expected: 'name,qty' } },
      { id: 'close', type: 'close-tab' },
    ]));
    check('Route: browser rules block and redirect', routed.status === 'passed', summary(routed));

    const chromiumOnly = [
      ['Route mocking (CDP)', { id: 'x', type: 'route', config: { backend: 'cdp', rules: JSON.stringify([{ url: '**/api/**', action: 'fulfill', body: 'x' }]) } }],
      ['Emulate', { id: 'x', type: 'emulate', config: { device: 'iphone' } }],
      ['HAR Record', { id: 'x', type: 'har-record', config: { action: 'start' } }],
      ['Assert console-errors', { id: 'x', type: 'assert', config: { subject: 'console-errors', operator: 'equals', expected: '0' } }],
      ['Clear Site Data', { id: 'x', type: 'clear-site-data', config: { origins: base } }],
    ];
    for (const [label, node] of chromiumOnly) {
      const record = await run(workflow(`m3 ${label}`, [
        { id: 'open', type: 'open-url', config: { url: `${base}/m3-route.html`, active: false } },
        { ...node, step: { timeoutSeconds: 5 } },
        { id: 'close', type: 'close-tab' },
      ]));
      const failed = step(record, 'x');
      check(`${label} explains it needs Chromium`, record.status === 'failed' && failed?.code === 'permission.missing' && /Chrom/.test(failed?.error ?? ''), `${failed?.code} ${failed?.error ?? summary(record)}`);
    }
  }

  {
    // M4: outside control over native messaging, then the MCP server on top, against Firefox.
    const { connectBridge } = await import('../../packages/bridge/client.mjs');
    await bridge('set', { 'bf:settings': { outsideControl: true } });
    let client;
    let lastError = '';
    for (const deadline = Date.now() + 20_000; Date.now() < deadline && !client; ) {
      if (existsSync(bridgePaths.socket) && existsSync(bridgePaths.tokenFile)) {
        client = await connectBridge({ socketPath: bridgePaths.socket, tokenFile: bridgePaths.tokenFile, client: 'ff-e2e', timeoutMs: 60_000 }).catch((error) => { lastError = String(error); return undefined; });
      }
      if (!client) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    check('outside control: Firefox starts the native host and the socket opens', Boolean(client), `${lastError} status=${JSON.stringify(await bridge('session', 'bf:bridge-status').catch(() => null))}`);
    if (client) {
      const hello = await client.call('hello', { protocol: 1, client: 'ff-e2e' });
      check('bridge hello from Firefox', /firefox/i.test(hello.browser) && hello.extensionId, JSON.stringify(hello));
      const script = { format: 'blockflow-script', version: 1, name: 'FF bridge', steps: [
        { open: { url: `${base}/welcome.html`, active: false } },
        { id: 'see', assert: { locator: '#greeting', expected: 'Welcome' } },
        { 'close-tab': {} },
      ] };
      const valid = await client.call('validate', { source: script });
      check('bridge validate', valid.ok === true, JSON.stringify(valid.issues));
      const notes = [];
      const ran = await client.call('run', { source: script, secrets: { ffOnly: 'ff-secret-0451' } }, { timeoutMs: 0, onNotification: (note) => notes.push(note.method) });
      check('bridge run passes and streams steps', ran.run?.status === 'passed' && notes.includes('run.started') && notes.includes('run.step'), `${ran.run?.status} ${notes.join(',')}`);
      const junit = await client.call('report', { format: 'junit', runIds: [ran.run.id] });
      check('bridge report junit', /<testsuite/.test(junit.content), String(junit.content).slice(0, 200));
      const snap = await client.call('snapshot', { url: `${base}/welcome.html` });
      check('bridge snapshot', /Welcome/.test(snap.outline ?? ''), String(snap.outline).slice(0, 200));
      const bad = { ...script, name: 'FF bad', steps: [script.steps[0], { id: 'see', assert: { locator: '#greeting', expected: 'Nope' }, step: { timeoutSeconds: 2 } }, script.steps[2]] };
      const suite = await client.call('suite.run', { suite: { name: 'FF suite', sources: [script, bad] }, formats: ['junit'] }, { timeoutMs: 0 });
      check('bridge suite.run with combined JUnit', suite.result?.status === 'failed' && (suite.reports?.junit?.match(/<testcase/g) ?? []).length === 2, JSON.stringify(suite.result?.status));
      await client.close();

      // The MCP server over stdio, through the same host and extension.
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      const mcp = new Client({ name: 'ff-e2e', version: '1.0.0' });
      await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve(here, '../../packages/mcp/server.mjs')], env: { ...process.env, BLOCKFLOW_SOCKET: bridgePaths.socket, BLOCKFLOW_TOKEN_FILE: bridgePaths.tokenFile }, stderr: 'pipe' }));
      const text = (result) => (result.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
      const failed = await mcp.callTool({ name: 'run_workflow', arguments: { source: bad } }, undefined, { timeout: 120_000 });
      check('MCP run_workflow on Firefox reports the failing step and code', /assert\.failed/.test(text(failed)) && /see/.test(text(failed)), text(failed).slice(0, 300));
      check('MCP run_workflow on Firefox attaches the screenshot', (failed.content ?? []).some((part) => part.type === 'image'), JSON.stringify((failed.content ?? []).map((part) => part.type)));
      await mcp.close().catch(() => {});

      await bridge('set', { 'bf:settings': { outsideControl: false } });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      check('switching outside control off stops the host (socket removed)', !existsSync(bridgePaths.socket));
    }
  }

  {
    const record = await run(workflow('notify', [{ id: 'n', type: 'notify', config: { title: 'BlockFlow e2e', message: 'hello' } }]));
    check('Notify', record.status === 'passed', summary(record));
  }
} catch (error) {
  check('Firefox e2e crashed', false, error instanceof Error ? error.stack : String(error));
} finally {
  await bidi.send('session.end').catch(() => {});
  bidi.close();
  child.kill();
  server.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures === 0 ? '\nAll Firefox e2e checks passed.' : `\n${failures} Firefox e2e check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
