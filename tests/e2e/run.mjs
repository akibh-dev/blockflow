// End-to-end tests: loads the built extension (.output/chrome-mv3) into a Chromium-based browser
// with a throwaway profile, serves tests/fixtures/site, runs workflows through the real background
// worker and checks their runs. Usage: npm run e2e   (BF_BROWSER=/path/to/chrome to pick a browser)
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extension = path.resolve(here, '../../.output/chrome-mv3');
const candidates = [
  process.env.BF_BROWSER,
  '/opt/brave.com/brave-origin/brave',
  '/opt/brave.com/brave/brave',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = candidates.find((candidate) => existsSync(candidate));
if (!executablePath) throw new Error('No Chromium-based browser found. Set BF_BROWSER=/path/to/chrome');
if (!existsSync(path.join(extension, 'manifest.json'))) throw new Error('Build first: npm run build');

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
const profile = mkdtempSync(path.join(os.tmpdir(), 'blockflow-e2e-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath,
  headless: false,
  viewport: { width: 1300, height: 850 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run', ...(process.env.BF_HEADLESS ? ['--headless=new'] : [])],
});
let [worker] = context.serviceWorkers();
worker ??= await context.waitForEvent('serviceworker');
const extensionId = worker.url().split('/')[2];
const pageErrors = [];
async function openEditor() {
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/editor.html`);
  return page;
}
let editor = await openEditor();

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

// --- helpers ------------------------------------------------------------------

let counter = 0;
/** A workflow from a list of blocks; edges: [from, to] or [from, to, port]. Defaults to a straight line. */
function workflow(name, nodes, edges) {
  counter += 1;
  const lines = edges ?? nodes.slice(1).map((node, index) => [nodes[index].id, node.id]);
  return {
    schemaVersion: 1,
    id: `e2e-${counter}`,
    name,
    enabled: false,
    nodes: nodes.map((node, index) => ({ position: { x: index * 240, y: 0 }, config: {}, ...node })),
    edges: lines.map(([source, target, port]) => ({ id: `${source}-${port ?? ''}-${target}`, source, target, ...(port ? { sourcePort: port } : {}) })),
  };
}

async function run(wf) {
  await editor.evaluate((w) => chrome.runtime.sendMessage({ type: 'bf:run-workflow', workflow: w }), wf);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const runs = (await worker.evaluate(() => chrome.storage.local.get('bf:runs')))['bf:runs'] ?? [];
    const done = runs.findLast((candidate) => candidate.workflowId === wf.id && candidate.status !== 'running');
    if (done) return done;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Run of ${wf.name} did not finish`);
}

const step = (record, id) => record.steps.find((candidate) => candidate.nodeId === id);
const summary = (record) => record.steps.map((s) => `${s.nodeId}:${s.status}${s.error ? ` (${s.error})` : ''}`).join(' → ');

// --- scenarios ------------------------------------------------------------------

console.log(`BlockFlow e2e · ${path.basename(executablePath)} · ${base}`);

{
  console.log('Classic login form (new page after submit)');
  const wf = workflow('login', [
    { id: 'open', type: 'open-url', config: { url: `${base}/login.html`, active: false } },
    {
      id: 'form',
      type: 'fill-form',
      config: {
        fields: [
          { locator: 'label=Email', value: 'akib@test.dev' },
          { locator: 'label=Password', value: 'secret' },
          { locator: 'label=Country', value: 'Bangladesh' },
          { locator: 'label="Remember me"', value: 'true' },
        ],
        submit: 'role=button[name="Sign in"]',
      },
    },
    { id: 'wait', type: 'wait-for', config: { mode: 'url', url: '/welcome' } },
    { id: 'read', type: 'read-element', config: { selector: '#greeting', url: '' } },
    { id: 'if', type: 'if', config: { left: '{{value}}', operator: 'equals', right: 'Welcome, akib!' } },
    { id: 'meta', type: 'read-element', config: { selector: 'text=Country', url: '' } },
    { id: 'close', type: 'close-tab' },
  ], [['open', 'form'], ['form', 'wait'], ['wait', 'read'], ['read', 'if'], ['if', 'meta', 'true'], ['meta', 'close']]);
  const record = await run(wf);
  check('run passed', record.status === 'passed', summary(record));
  check('landed on /welcome', String(step(record, 'wait')?.output?.url).includes('/welcome.html'));
  check('If took "true"', step(record, 'if')?.port === 'true', JSON.stringify(step(record, 'read')?.output?.value));
  check('select and checkbox were submitted', String(step(record, 'meta')?.output?.value).includes('Country: bd · Remember: on'), String(step(record, 'meta')?.output?.value));
}

{
  console.log('Wrong password goes to the error output');
  const wf = workflow('bad login', [
    { id: 'open', type: 'open-url', config: { url: `${base}/login.html`, active: false } },
    { id: 'form', type: 'fill-form', config: { fields: [{ locator: 'label=Email', value: 'a@b.co' }, { locator: 'label=Password', value: 'nope' }], submit: 'role=button[name="Sign in"]' } },
    { id: 'wait', type: 'wait-for', config: { mode: 'url', url: '/welcome' }, step: { timeoutSeconds: 4, onError: 'port' } },
    { id: 'ok', type: 'set-variable', config: { name: 'result', value: 'logged in' } },
    { id: 'seen', type: 'wait-for', config: { mode: 'text', text: 'Wrong email or password' } },
    { id: 'close', type: 'close-tab' },
  ], [['open', 'form'], ['form', 'wait'], ['wait', 'ok'], ['wait', 'seen', 'error'], ['seen', 'close']]);
  const record = await run(wf);
  check('run passed (error was handled)', record.status === 'passed', summary(record));
  check('Wait For was routed to "error"', step(record, 'wait')?.status === 'handled' && step(record, 'wait')?.port === 'error');
  check('the timeout explains itself', String(step(record, 'wait')?.error).includes('waiting for the URL to match /welcome'), step(record, 'wait')?.error);
  check('error message on the page was found', step(record, 'seen')?.status === 'passed');
  check('success branch did not run', !step(record, 'ok'));
}

{
  console.log('Single-page app: overlay, controlled inputs, custom checkbox, disabled button, pushState, shadow DOM');
  const wf = workflow('spa', [
    { id: 'open', type: 'open-url', config: { url: `${base}/spa.html`, active: true } },
    { id: 'early', type: 'click', config: { locator: 'fancy-counter >>> button' }, step: { timeoutSeconds: 2, onError: 'continue' } },
    { id: 'cookies', type: 'click', config: { locator: 'role=button[name="Accept"]' } },
    { id: 'name', type: 'fill', config: { locator: 'label="Full name"', value: 'Akib Hasan' } },
    { id: 'email', type: 'fill', config: { locator: 'placeholder=you@example.com', value: 'akib@test.dev', mode: 'type' } },
    { id: 'plan', type: 'select-option', config: { locator: 'label=Plan', value: 'Pro' } },
    { id: 'terms', type: 'check', config: { locator: 'label="I accept the terms"' } },
    { id: 'state', type: 'read-element', config: { selector: 'testid=state', url: '' } },
    { id: 'create', type: 'click', config: { locator: 'role=button[name="Create account"]' } },
    { id: 'thanks', type: 'wait-for', config: { mode: 'text', text: 'Thanks, Akib Hasan!' } },
    { id: 'route', type: 'wait-for', config: { mode: 'url', url: '**/spa/done' } },
    { id: 'order', type: 'read-element', config: { selector: '#order', url: '' } },
    { id: 'valid', type: 'if', config: { left: '{{value}}', operator: 'matches', right: '/^#\\d+$/' } },
    { id: 'shadow', type: 'click', config: { locator: 'fancy-counter >>> button' } },
    { id: 'count', type: 'read-element', config: { selector: 'fancy-counter >>> .count', url: '' } },
    { id: 'close', type: 'close-tab' },
  ]);
  wf.edges = wf.edges.map((edge) => (edge.source === 'valid' ? { ...edge, sourcePort: 'true' } : edge));
  const record = await run(wf);
  check('run passed', record.status === 'passed', summary(record));
  check('clicking under the cookie banner waited and said why', String(step(record, 'early')?.error).includes('is covered by'), step(record, 'early')?.error);
  check('controlled inputs, select and checkbox reached the app state', String(step(record, 'state')?.output?.value) === '{"name":"Akib Hasan","email":"akib@test.dev","plan":"pro","terms":true}', String(step(record, 'state')?.output?.value));
  check('SPA route change seen', String(step(record, 'route')?.output?.url).endsWith('/spa/done'));
  check('order number read and checked', step(record, 'valid')?.port === 'true', String(step(record, 'order')?.output?.value));
  check('shadow DOM button clicked', step(record, 'count')?.output?.value === '1', String(step(record, 'count')?.output?.value));
}

{
  console.log('Clear failures');
  const wf = workflow('strict', [
    { id: 'open', type: 'open-url', config: { url: `${base}/login.html`, active: false } },
    { id: 'any', type: 'click', config: { locator: 'button' } },
  ]);
  const record = await run(wf);
  check('two matches fail with a hint', record.status === 'failed' && String(record.error).includes('matches 2 elements') && String(record.error).includes('nth=0'), record.error);
  const missing = workflow('missing', [
    { id: 'open', type: 'open-url', config: { url: `${base}/login.html`, active: false } },
    { id: 'gone', type: 'click', config: { locator: 'text=Does not exist' }, step: { timeoutSeconds: 3 } },
  ]);
  const second = await run(missing);
  check('missing element times out with the reason', /Timed out after \d+s: waiting for text=Does not exist: no element matches/.test(String(second.error)), second.error);
}

{
  console.log('Editor: Detect fields on a real form');
  const target = await context.newPage();
  await target.goto(`${base}/login.html`);
  // The editor saves what it has when it closes, so close it before replacing the workflows.
  await editor.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const wf = workflow('detect', [{ id: 'ff', type: 'fill-form', config: { fields: [] } }]);
  await worker.evaluate((w) => chrome.storage.local.set({ 'bf:workflows': [w] }), wf);
  editor = await openEditor();
  await editor.click('.bf-node:has-text("Fill Form")');
  await editor.click('button:has-text("Detect fields")');
  await target.waitForTimeout(800);
  await target.click('#email');
  await target.keyboard.press('Enter');
  await editor.waitForSelector('.bf-pick.done', { timeout: 10_000 });
  const locators = await editor.$$eval('.bf-rows tbody tr td:first-child input', (inputs) => inputs.map((input) => input.value));
  check('rows created from the form', JSON.stringify(locators) === JSON.stringify(['label="Email"', 'label="Password"', 'label="Country"', 'label="Remember me"']), JSON.stringify(locators));
  const hint = await editor.getAttribute('.bf-rows tbody tr:nth-child(3) td:nth-child(2) input', 'placeholder');
  check('select rows hint their options', String(hint).includes('Bangladesh'), hint);
  await target.close();
}

check('no errors in the editor page', pageErrors.length === 0, pageErrors.join('\n'));
await context.close();
server.close();
rmSync(profile, { recursive: true, force: true });
console.log(failures === 0 ? '\nAll e2e checks passed.' : `\n${failures} e2e check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
