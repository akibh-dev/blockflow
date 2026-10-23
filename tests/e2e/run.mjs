// End-to-end tests: loads the built extension (.output/chrome-mv3) into a Chromium-based browser
// with a throwaway profile, serves tests/fixtures/site, runs workflows through the real background
// worker and checks their runs. Usage: npm run e2e   (BF_BROWSER=/path/to/chrome to pick a browser)
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PASSWORD, startServer } from './server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Built by `npm run e2e` (BF_E2E=1): optional permissions granted up front, separate folder.
const extension = path.resolve(here, '../../.output-e2e/chrome-mv3');
const playwrightChromium = (() => {
  // A Chromium installed by `npx playwright install chromium`, if any.
  const cache = path.join(os.homedir(), '.cache/ms-playwright');
  try {
    const dir = readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort().at(-1);
    return dir ? path.join(cache, dir, 'chrome-linux/chrome') : undefined;
  } catch {
    return undefined;
  }
})();
const candidates = [
  process.env.BF_BROWSER,
  '/opt/brave.com/brave-origin/brave',
  '/opt/brave.com/brave/brave',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  playwrightChromium,
].filter(Boolean);
const executablePath = candidates.find((candidate) => existsSync(candidate));
if (!executablePath) throw new Error('No Chromium-based browser found. Set BF_BROWSER=/path/to/chrome');
if (!existsSync(path.join(extension, 'manifest.json'))) throw new Error('Build first: BF_E2E=1 npx wxt build (npm run e2e does it)');

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
const profile = mkdtempSync(path.join(os.tmpdir(), 'blockflow-e2e-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath,
  headless: false,
  timeout: 60_000,
  viewport: { width: 1300, height: 850 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run', ...(process.env.BF_HEADLESS ? ['--headless=new'] : [])],
});
// (If launching times out, the browser may be mid-update or blocked: try another with BF_BROWSER.)
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

/** Replaces the saved workflows. The editor saves its copy when it closes, so it is reopened around this. */
async function seedWorkflows(list) {
  await editor.close();
  await new Promise((resolve) => setTimeout(resolve, 400));
  await worker.evaluate((workflows) => chrome.storage.local.set({ 'bf:workflows': workflows }), list);
  editor = await openEditor();
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
          { locator: 'label=Password', value: PASSWORD },
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


{
  console.log('Phase C: Assert, screenshots, secrets, Run Workflow, Manual Step, reports');
  await worker.evaluate((password) => chrome.storage.local.set({ 'bf:secrets': { loginPassword: password } }), PASSWORD);
  const login = workflow('Log in (reusable)', [
    { id: 'form', type: 'fill-form', config: { fields: [{ locator: 'label=Email', value: '{{email}}' }, { locator: 'label=Password', value: '{{secret.loginPassword}}' }], submit: 'role=button[name="Sign in"]' } },
    { id: 'wait', type: 'wait-for', config: { mode: 'url', url: '/welcome' } },
  ]);
  const test = workflow('Login test', [
    { id: 'open', type: 'open-url', config: { url: `${base}/login.html`, active: true } },
    { id: 'who', type: 'set-variable', config: { name: 'email', value: 'tester@test.dev' } },
    { id: 'call', type: 'run-workflow', config: { workflow: login.id } },
    { id: 'greets', type: 'assert', config: { subject: 'text', locator: '#greeting', operator: 'equals', expected: 'Welcome, tester!' } },
    { id: 'title', type: 'assert', config: { subject: 'title', operator: 'contains', expected: 'welcome' } },
    { id: 'soft', type: 'assert', config: { subject: 'text', locator: '#greeting', operator: 'contains', expected: 'Goodbye', soft: true }, step: { timeoutSeconds: 3 } },
    { id: 'after', type: 'log', config: { message: 'kept going' } },
  ]);
  await seedWorkflows([login, test]);
  const record = await run(test);
  const all = (await worker.evaluate(() => chrome.storage.local.get('bf:runs')))['bf:runs'];
  const child = all.find((candidate) => candidate.parentRunId === record.id);
  check('called workflow ran in the same tab and passed', child?.status === 'passed' && step(record, 'call')?.status === 'passed', summary(record));
  check('asserts on the page passed', step(record, 'greets')?.status === 'passed' && step(record, 'title')?.status === 'passed');
  check('soft assert failed the run but the flow went on', record.status === 'failed' && step(record, 'soft')?.status === 'failed' && step(record, 'after')?.status === 'passed', summary(record));
  check('failed assert has a screenshot', Boolean(step(record, 'soft')?.screenshot), JSON.stringify(step(record, 'soft')));
  check('the password never shows up in run records', !JSON.stringify([record, child]).includes(PASSWORD));

  const manual = workflow('manual', [
    { id: 'm', type: 'manual-step', config: { message: 'Check the page, then continue' } },
    { id: 'l', type: 'log', config: { message: 'continued' } },
  ]);
  const pending = run(manual);
  await editor.waitForSelector('.bf-prompt', { timeout: 10_000 });
  await editor.click('.bf-prompt button:has-text("Continue")');
  const manualRecord = await pending;
  check('Manual Step waited for Continue in the editor', manualRecord.status === 'passed' && step(manualRecord, 'l')?.status === 'passed', summary(manualRecord));

  await editor.click('.bf-header .bf-tabs button:has-text("Reports")');
  await editor.click(`.bf-report-list button:has-text("Login test")`);
  await editor.waitForSelector('.bf-report-detail .bf-shot img', { timeout: 10_000 });
  check('report shows the step screenshot', true);
  const [junit] = await Promise.all([editor.waitForEvent('download'), editor.click('button:has-text("Export JUnit XML")')]);
  const xml = await (await import('node:fs/promises')).readFile(await junit.path(), 'utf8');
  check('JUnit export lists the failed soft assert', xml.includes('<testsuite name="Login test"') && xml.includes('<failure'), xml.slice(0, 200));
  const [htmlReport] = await Promise.all([editor.waitForEvent('download'), editor.click('button:has-text("Export HTML")')]);
  const page = await (await import('node:fs/promises')).readFile(await htmlReport.path(), 'utf8');
  check('HTML report embeds the screenshot', page.includes('<img src="data:image/jpeg;base64,'));
}


{
  console.log('Phase D: scraping, loops, datasets, downloads');
  const scrape = workflow('scrape products', [
    { id: 'open', type: 'open-url', config: { url: `${base}/products?page=1`, active: false } },
    { id: 'pages', type: 'paginate', config: { next: 'a.next', maxPages: 10 } },
    { id: 'cards', type: 'extract-list', config: { locator: 'li.card', fields: [{ name: 'title', locator: 'h2', attribute: '' }, { name: 'price', locator: '.price', attribute: '' }, { name: 'link', locator: 'a', attribute: 'href' }] } },
    { id: 'save', type: 'save-dataset', config: { dataset: 'e2e-products', value: 'items', mode: 'append' } },
    { id: 'file', type: 'download', config: { from: 'dataset', dataset: 'e2e-products', format: 'csv', filename: 'e2e-products.csv' } },
  ], [['open', 'pages'], ['pages', 'cards', 'each'], ['cards', 'save'], ['pages', 'file', 'done']]);
  // Start from an empty dataset.
  await run(workflow('clear', [{ id: 'all', type: 'save-dataset', config: { dataset: 'e2e-products', value: '[]', mode: 'replace' } }]));
  const record = await run(scrape);
  check('paginated 3 pages and passed', record.status === 'passed' && step(record, 'file')?.input?.pages === 3, summary(record));
  check('dataset has all 9 products with absolute links', step(record, 'file')?.status === 'passed' && JSON.stringify(record).includes(`${base}/p/9`), JSON.stringify(step(record, 'save')?.output ?? {}).slice(0, 300));
  const rows = await editor.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('blockflow');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise((resolve) => {
      const get = db.transaction('datasets').objectStore('datasets').get('e2e-products');
      get.onsuccess = () => resolve(get.result?.rows ?? []);
    });
  });
  check('IndexedDB dataset holds 9 rows', rows.length === 9 && rows[8].price === '$90', JSON.stringify(rows.slice(-1)));
  // Playwright stores downloads under random names, so look for the CSV by its content.
  const downloads = await worker.evaluate(() => new Promise((resolve) => chrome.downloads.search({}, resolve)));
  const csv = downloads.find((item) => item.url.startsWith('data:text/csv'));
  check('CSV file downloaded', Boolean(csv) && csv.error === undefined && decodeURIComponent(csv.url).includes(`Product 9,$90,${base}/p/9`), JSON.stringify(downloads.map((item) => [item.url.slice(0, 60), item.state, item.error])));

  const noTab = workflow('table over http', [
    { id: 'get', type: 'http-request', config: { url: `${base}/table.html`, method: 'GET' } },
    { id: 'table', type: 'extract-table', config: { source: 'html', html: '{{body}}', baseUrl: '{{url}}', locator: '#prices' } },
    { id: 'links', type: 'extract-list', config: { source: 'html', html: '{{body}}', baseUrl: '{{url}}', locator: '#prices tbody tr', fields: [{ name: 'link', locator: 'a', attribute: 'href' }] } },
    { id: 'total', type: 'transform', config: { values: [{ name: 'total', expression: "sum(pluck(rows, 'Price'))" }] } },
    { id: 'check', type: 'assert', config: { subject: 'value', value: '{{total}}', operator: 'equals', expected: '70' } },
  ]);
  const tableRun = await run(noTab);
  check('HTTP + Extract Table/List from HTML without a tab (offscreen parser)', tableRun.status === 'passed', summary(tableRun));
  check('relative links resolved against the page address', JSON.stringify(step(tableRun, 'links')?.output ?? {}).includes(`${base}/p/kettle`));

  const feed = workflow('infinite feed', [
    { id: 'open', type: 'open-url', config: { url: `${base}/feed.html`, active: false } },
    { id: 'down', type: 'scroll', config: { to: 'end', maxScrolls: 15, pauseMs: 600 } },
    { id: 'posts', type: 'extract-list', config: { locator: 'article.post' } },
    { id: 'count', type: 'assert', config: { subject: 'value', value: '{{count}}', operator: 'equals', expected: '40' } },
    { id: 'close', type: 'close-tab' },
  ]);
  const feedRun = await run(feed);
  check('scrolled an infinite list to the end (40 posts)', feedRun.status === 'passed', summary(feedRun));

  const dataDriven = workflow('data-driven login', [
    { id: 'data', type: 'data-table', config: { text: `email,password\ngood@test.dev,${PASSWORD}\nbad@test.dev,wrong` } },
    { id: 'each', type: 'for-each', config: { list: 'rows', as: 'row' } },
    { id: 'open', type: 'open-url', config: { url: `${base}/login.html`, active: false } },
    { id: 'form', type: 'fill-form', config: { fields: [{ locator: 'label=Email', value: '{{row.email}}' }, { locator: 'label=Password', value: '{{row.password}}' }], submit: 'role=button[name="Sign in"]' } },
    { id: 'settle', type: 'wait-for', config: { mode: 'load' } },
    { id: 'heading', type: 'read-element', config: { selector: 'h1', url: '' } },
  ]);
  dataDriven.nodes.push(
    { id: 'shape', type: 'set-variable', position: { x: 1800, y: 0 }, config: { name: 'outcome', value: '{{row.email}} → {{value}}' } },
    { id: 'save', type: 'save-dataset', position: { x: 2000, y: 0 }, config: { dataset: 'e2e-logins', value: 'outcome', mode: 'append' } },
    { id: 'close', type: 'close-tab', position: { x: 2200, y: 0 }, config: {} },
    { id: 'clear', type: 'save-dataset', position: { x: 0, y: 200 }, config: { dataset: 'e2e-logins', value: '[]', mode: 'replace' } },
  );
  dataDriven.edges = [
    { id: 'a', source: 'clear', target: 'data' },
    { id: 'b', source: 'data', target: 'each' },
    { id: 'c', source: 'each', target: 'open', sourcePort: 'each' },
    { id: 'd', source: 'open', target: 'form' },
    { id: 'e', source: 'form', target: 'settle' },
    { id: 'f', source: 'settle', target: 'heading' },
    { id: 'g', source: 'heading', target: 'shape' },
    { id: 'h', source: 'shape', target: 'save' },
    { id: 'i', source: 'save', target: 'close' },
  ];
  const ddRun = await run(dataDriven);
  const outcomes = ddRun.steps.filter((s) => s.nodeId === 'shape').map((s) => s.output?.outcome);
  check('For Each ran one login per CSV row', ddRun.status === 'passed' && JSON.stringify(outcomes) === JSON.stringify(['good@test.dev → Welcome, good!', 'bad@test.dev → Sign in']), `${summary(ddRun)}\n      ${JSON.stringify(outcomes)}`);

  await editor.click('.bf-header .bf-tabs button:has-text("Data")');
  await editor.click('.bf-report-list button:has-text("e2e-products")');
  const previewRows = await editor.locator('.bf-data-preview tbody tr').count();
  check('Data page previews the dataset', previewRows === 9, String(previewRows));
}


{
  console.log('Phase E: recorder, picker, Page Visited, editing tools, templates, autocomplete');
  await seedWorkflows([workflow('recorded', [{ id: 'note', type: 'log', config: { message: 'start' } }])]);
  await worker.evaluate((password) => chrome.storage.local.set({ 'bf:secrets': { password } }), PASSWORD);
  editor.once('dialog', (dialog) => dialog.accept(`${base}/login.html`));
  const [recordTab] = await Promise.all([context.waitForEvent('page'), editor.click('button:has-text("● Record")')]);
  await recordTab.waitForLoadState('load');
  await recordTab.waitForSelector('blockflow-recorder', { state: 'attached', timeout: 10_000 });
  await recordTab.locator('#email').pressSequentially('rec@test.dev');
  await recordTab.locator('#password').pressSequentially(PASSWORD);
  await recordTab.locator('#country').selectOption('bd');
  await recordTab.locator('text=Remember me').click();
  await Promise.all([recordTab.waitForURL(/welcome/), recordTab.locator('button:has-text("Sign in")').click()]);
  await recordTab.waitForSelector('blockflow-recorder', { state: 'attached', timeout: 10_000 });
  await recordTab.locator('blockflow-recorder >> button[data-act="assert-text"]').click();
  await recordTab.locator('#greeting').click();
  await recordTab.waitForTimeout(300);
  editor.once('dialog', (dialog) => dialog.accept());
  await recordTab.locator('blockflow-recorder >> button[data-act="stop"]').click();
  await editor.bringToFront();
  await editor.waitForFunction(() => document.querySelectorAll('.bf-node').length > 1, null, { timeout: 10_000 });
  await editor.waitForTimeout(800);
  const recorded = (await worker.evaluate(() => chrome.storage.local.get('bf:workflows')))['bf:workflows'].find((w) => w.name === 'recorded');
  const types = recorded.nodes.filter((node) => node.type !== 'log').map((node) => node.type);
  check('recording became Open Tab → Fill Form → Wait For → Assert', JSON.stringify(types) === JSON.stringify(['open-url', 'fill-form', 'wait-for', 'assert']), JSON.stringify(types));
  const form = recorded.nodes.find((node) => node.type === 'fill-form');
  check('readable locators, password as {{secret.password}}, submit captured', JSON.stringify(form?.config.fields) === JSON.stringify([
    { locator: 'label="Email"', value: 'rec@test.dev' },
    { locator: 'label="Password"', value: '{{secret.password}}' },
    { locator: 'label="Country"', value: 'Bangladesh' },
    { locator: 'label="Remember me"', value: 'true' },
  ]) && form?.config.submit === 'role=button[name="Sign in"]', JSON.stringify(form?.config));
  await recordTab.close();
  const replay = await run({ ...recorded, nodes: recorded.nodes.filter((node) => node.type !== 'log'), edges: recorded.edges.filter((edge) => !recorded.nodes.find((n) => n.type === 'log' && (n.id === edge.source || n.id === edge.target))) });
  check('the recorded workflow replays and passes', replay.status === 'passed', summary(replay));

  // Picking an element for a Click gives a readable locator, with alternatives.
  const target = await context.newPage();
  await target.goto(`${base}/login.html`);
  await seedWorkflows([workflow('pick', [{ id: 'c', type: 'click', config: { locator: '' } }])]);
  await editor.click('.bf-node:has-text("Click")');
  await editor.click('.bf-field:has-text("Element") button:has-text("Pick on page")');
  await target.waitForTimeout(800);
  await target.click('button:has-text("Forgot password?")');
  await target.keyboard.press('Enter');
  await editor.waitForSelector('.bf-candidates', { timeout: 10_000 });
  const picked = await editor.inputValue('.bf-field:has-text("Element") input');
  const alternatives = await editor.locator('.bf-candidates button').allTextContents();
  check('pick gives a readable locator and alternatives', picked === 'role=button[name="Forgot password?"]' && alternatives.length >= 2, `${picked} | ${alternatives.join(' | ')}`);
  await target.close();

  // Undo / redo / copy / paste.
  const count = () => editor.locator('.bf-node').count();
  await editor.click('.react-flow__pane');
  await editor.fill('input[aria-label="Find a block"]', 'log');
  await editor.click('.bf-palette button:has-text("Log")');
  await editor.fill('input[aria-label="Find a block"]', '');
  await editor.waitForTimeout(700);
  const afterAdd = await count();
  await editor.click('.react-flow__pane');
  await editor.keyboard.press('Control+z');
  await editor.waitForTimeout(300);
  const afterUndo = await count();
  await editor.keyboard.press('Control+Shift+z');
  await editor.waitForTimeout(300);
  const afterRedo = await count();
  await editor.click('.bf-node:has-text("Click")');
  await editor.keyboard.press('Control+c');
  await editor.keyboard.press('Control+v');
  await editor.waitForTimeout(300);
  const afterPaste = await count();
  check('undo, redo, copy + paste', afterUndo === afterAdd - 1 && afterRedo === afterAdd && afterPaste === afterAdd + 1, `${afterAdd} ${afterUndo} ${afterRedo} ${afterPaste}`);

  // Templates.
  await editor.click('.bf-sidebar button:has-text("+ New")');
  await editor.click('.bf-menu-list button:has-text("Scrape all pages to CSV")');
  await editor.waitForTimeout(600);
  check('a template becomes a workflow', (await editor.inputValue('.bf-name')) === 'Scrape all pages to CSV' && (await count()) === 6, String(await count()));

  // {{ autocomplete in a Download block after Extract List.
  await editor.click('.bf-node:has-text("Download")');
  const nameField = editor.locator('.bf-field:has-text("File name") input');
  await nameField.fill('');
  await nameField.pressSequentially('x-{{');
  const offered = await editor.locator('.bf-suggest button').allTextContents();
  check('{{ offers the data names of earlier blocks', offered.includes('{{pages}}') || offered.includes('{{count}}'), offered.join(' '));
  await editor.keyboard.press('Escape');

  // Page Visited: an enabled workflow starts when a matching page opens in any tab.
  const visited = workflow('on visit', [
    { id: 'p', type: 'page-visited', config: { url: '/table.html', when: 'load' } },
    { id: 'r', type: 'read-element', config: { selector: 'h1', url: '' } },
  ]);
  visited.enabled = true;
  await seedWorkflows([visited]);
  await editor.waitForTimeout(800);
  const visit = await context.newPage();
  await visit.goto(`${base}/table.html`);
  let eventRun;
  for (let i = 0; i < 40 && !eventRun; i += 1) {
    await editor.waitForTimeout(250);
    eventRun = ((await worker.evaluate(() => chrome.storage.local.get('bf:runs')))['bf:runs'] ?? []).find((r) => r.workflowId === visited.id && r.trigger === 'event' && r.status !== 'running');
  }
  check('Page Visited started a run on the visited tab', eventRun?.status === 'passed' && step(eventRun, 'r')?.output?.value === 'Prices', JSON.stringify(eventRun && summary(eventRun)));
  await visit.close();
  await seedWorkflows([{ ...visited, enabled: false }]);
}


{
  console.log('Phase F: upload, popups, dialogs, frames, API responses, real input, Run Script, Playwright export');
  const upload = await run(workflow('upload', [
    { id: 'open', type: 'open-url', config: { url: `${base}/upload.html`, active: false } },
    { id: 'up', type: 'upload-file', config: { locator: 'label=Upload CV', content: 'name,city\nAkib,Dhaka', filename: 'cv.csv', mime: 'text/csv' } },
    { id: 'read', type: 'read-element', config: { selector: '#out', url: '' } },
    { id: 'close', type: 'close-tab' },
  ]));
  check('Upload File set a file on a hidden input', step(upload, 'read')?.output?.value === 'cv.csv|text/csv|name,city Akib,Dhaka', JSON.stringify(step(upload, 'read')?.output?.value ?? summary(upload)));

  const popup = await run(workflow('popup', [
    { id: 'open', type: 'open-url', config: { url: `${base}/popup.html`, active: false } },
    { id: 'click', type: 'click', config: { locator: 'role=button[name="Open help"]' } },
    { id: 'catch', type: 'wait-for-popup', config: { name: 'help' } },
    { id: 'read', type: 'read-element', config: { selector: 'h1', url: '', tab: 'help' } },
    { id: 'link', type: 'click', config: { locator: 'text=Feed in a new tab' } },
    { id: 'catch2', type: 'wait-for-popup', config: { name: 'feed' } },
    { id: 'close1', type: 'close-tab', config: { tab: 'help' } },
    { id: 'close2', type: 'close-tab', config: { tab: 'feed' } },
    { id: 'close3', type: 'close-tab' },
  ]));
  check('Wait for Popup caught window.open and target=_blank', popup.status === 'passed' && step(popup, 'read')?.output?.value === 'Prices' && String(step(popup, 'catch2')?.output?.popupUrl).endsWith('/feed.html'), summary(popup));

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
  check('Dialogs: confirm dismissed, prompt answered, messages read', dialogs.status === 'passed' && step(dialogs, 'read')?.output?.lastDialog === 'Your name?', summary(dialogs));

  const frames = await run(workflow('frames', [
    { id: 'open', type: 'open-url', config: { url: `${base}/frames.html`, active: false } },
    { id: 'f1', type: 'fill', config: { locator: 'frame=#same >> label=Card number', value: '1111' } },
    { id: 'p1', type: 'click', config: { locator: 'frame=#same >> role=button[name="Pay"]' } },
    { id: 'r1', type: 'read-element', config: { selector: 'frame=#same >> #paid', url: '' } },
    { id: 'f2', type: 'fill', config: { locator: 'frame=#other >> label=Card number', value: '4242' } },
    { id: 'p2', type: 'click', config: { locator: 'frame=#other >> role=button[name="Pay"]' } },
    { id: 'r2', type: 'read-element', config: { selector: 'frame=#other >> #paid', url: '' } },
    { id: 'close', type: 'close-tab' },
  ]));
  const port = server.address().port;
  check('same-origin iframe', step(frames, 'r1')?.output?.value === `Paid 1111 from 127.0.0.1:${port}`, String(step(frames, 'r1')?.output?.value ?? summary(frames)));
  check('cross-origin iframe (through its frame id)', step(frames, 'r2')?.output?.value === `Paid 4242 from localhost:${port}`, String(step(frames, 'r2')?.output?.value ?? summary(frames)));

  const api = await run(workflow('api', [
    { id: 'open', type: 'open-url', config: { url: `${base}/api.html`, active: false } },
    { id: 'save', type: 'click', config: { locator: 'role=button[name="Save"]' } },
    { id: 'wait', type: 'wait-for', config: { mode: 'response', url: '/api/save', status: '2xx' } },
    { id: 'close', type: 'close-tab' },
  ]));
  check('Wait For response saw POST /api/save → 201', step(api, 'wait')?.output?.response?.status === 201 && step(api, 'wait')?.output?.response?.method === 'POST', summary(api));

  const trusted = await run(workflow('trusted', [
    { id: 'open', type: 'open-url', config: { url: `${base}/trusted.html`, active: false } },
    { id: 'fake', type: 'click', config: { locator: '#press' } },
    { id: 'r1', type: 'read-element', config: { selector: '#result', url: '' } },
    { id: 'real', type: 'click', config: { locator: '#press' }, step: { realInput: true } },
    { id: 'r2', type: 'read-element', config: { selector: '#result', url: '' } },
    { id: 'type', type: 'fill', config: { locator: 'label=Name', value: 'Akib' }, step: { realInput: true } },
    { id: 'r3', type: 'read-element', config: { selector: 'label=Name', url: '', read: 'attribute', name: 'data-trusted' } },
    { id: 'v', type: 'assert', config: { subject: 'input', locator: 'label=Name', operator: 'equals', expected: 'Akib' } },
    { id: 'shot', type: 'assert', config: { subject: 'text', locator: '#result', operator: 'equals', expected: 'nope' }, step: { timeoutSeconds: 2, onError: 'continue' } },
    { id: 'close', type: 'close-tab' },
  ]));
  check('synthetic click is untrusted, real input is trusted', step(trusted, 'r1')?.output?.value === 'untrusted' && step(trusted, 'r2')?.output?.value === 'trusted', summary(trusted));
  check('real typing (trusted keys, value set)', step(trusted, 'r3')?.output?.value === 'yes' && step(trusted, 'v')?.status === 'passed', summary(trusted));
  check('screenshot of a background tab (through the debugger)', Boolean(step(trusted, 'shot')?.screenshot), JSON.stringify(step(trusted, 'shot')));

  const script = await run(workflow('script', [
    { id: 'open', type: 'open-url', config: { url: `${base}/table.html`, active: false } },
    { id: 'js', type: 'run-script', config: { code: "return document.querySelectorAll('tr').length;" } },
  ]));
  const scriptOk = step(script, 'js')?.output?.result === 4;
  const scriptExplains = String(script.error).includes('Chrome 135');
  check(`Run Script ${scriptOk ? 'ran' : 'explains what it needs on this browser'}`, scriptOk || scriptExplains, script.error);

  // Export as a Playwright test from the editor, then run it with real Playwright.
  const pwFlow = workflow('Exported login', [
    { id: 'open', type: 'open-url', config: { url: `${base}/login.html` } },
    { id: 'form', type: 'fill-form', config: { fields: [{ locator: 'label=Email', value: 'pw@test.dev' }, { locator: 'label=Password', value: '{{secret.loginPassword}}' }, { locator: 'label=Country', value: 'Bangladesh' }, { locator: 'label="Remember me"', value: 'true' }], submit: 'role=button[name="Sign in"]' } },
    { id: 'url', type: 'wait-for', config: { mode: 'url', url: '/welcome' } },
    { id: 'hi', type: 'assert', config: { subject: 'text', locator: '#greeting', operator: 'equals', expected: 'Welcome, pw!' } },
    { id: 'more', type: 'read-element', config: { selector: 'text=Country', url: '' } },
    { id: 'bd', type: 'if', config: { left: '{{value}}', operator: 'contains', right: 'bd' } },
    { id: 'log', type: 'log', config: { message: 'country ok' } },
  ]);
  pwFlow.edges = pwFlow.edges.map((edge) => (edge.source === 'bd' ? { ...edge, sourcePort: 'true' } : edge));
  await seedWorkflows([pwFlow]);
  await editor.click('.bf-header .bf-tabs button:has-text("All workflows")');
  const [spec] = await Promise.all([editor.waitForEvent('download'), editor.click('.bf-table button:has-text("Playwright")')]);
  const fs = await import('node:fs/promises');
  const dir = path.resolve(here, '../../.output-e2e/playwright');
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(await spec.path(), path.join(dir, 'exported.spec.ts'));
  await fs.writeFile(path.join(dir, 'playwright.config.mjs'), `export default { testDir: '.', timeout: 60000, reporter: 'line', use: { headless: true, launchOptions: { executablePath: ${JSON.stringify(executablePath)} } } };\n`);
  // Asynchronously: this process also serves the fixture site the exported test visits.
  const { spawn } = await import('node:child_process');
  const result = await new Promise((resolve) => {
    const child = spawn('npx', ['playwright', 'test', '--config', path.join(dir, 'playwright.config.mjs')], { cwd: path.resolve(here, '../..'), env: { ...process.env, LOGINPASSWORD: PASSWORD } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
  check('exported .spec.ts passes under npx playwright test', result.status === 0 && /1 passed/.test(result.stdout), `${result.stdout}\n${result.stderr}`.slice(-1500));
}

check('no errors in the editor page', pageErrors.length === 0, pageErrors.join('\n'));
await context.close();
server.close();
rmSync(profile, { recursive: true, force: true });
console.log(failures === 0 ? '\nAll e2e checks passed.' : `\n${failures} e2e check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
