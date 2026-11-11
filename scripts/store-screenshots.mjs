// Store listing screenshots (1280x800 PNGs) of the real editor, from the e2e build on the fixture site.
//   BF_E2E=1 npx wxt build && npm run store:screenshots            (BF_BROWSER=/path/to/chromium to choose)
// Writes docs/store/screenshots/*.png. The fixture pages only show demo content, no personal data.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../tests/e2e/harness.mjs';
import { PASSWORD } from '../tests/e2e/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs/store/screenshots');
mkdirSync(outDir, { recursive: true });

const h = await launch();
const { base, worker, workflow, seedWorkflows } = h;
const size = { width: 1280, height: 800 };

/** A run with options (trace), like the editor's "Run with trace" button. */
async function runWith(wf, options) {
  const readRuns = async () => (await worker.evaluate(() => chrome.storage.local.get('bf:runs')))['bf:runs'] ?? [];
  const seen = new Set((await readRuns()).filter((run) => run.workflowId === wf.id).map((run) => run.id));
  await h.editor.evaluate(([w, o]) => chrome.runtime.sendMessage({ type: 'bf:run-workflow', workflow: w, ...(o ? { options: o } : {}) }), [wf, options]);
  for (const deadline = Date.now() + 90_000; Date.now() < deadline; ) {
    const done = (await readRuns()).findLast((run) => run.workflowId === wf.id && !seen.has(run.id) && run.status !== 'running');
    if (done) return done;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('run did not finish');
}

async function shot(name) {
  await h.editor.setViewportSize(size);
  await h.editor.waitForTimeout(500);
  await h.editor.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log(`wrote docs/store/screenshots/${name}.png`);
}

try {
  const login = workflow('Login test: sign in and check the greeting', [
    { id: 'open', type: 'open-url', config: { url: `${base}/login.html`, active: true } },
    { id: 'form', type: 'fill-form', config: { fields: [
      { locator: 'label=Email', value: 'ann@example.com' },
      { locator: 'label=Password', value: PASSWORD },
      { locator: 'label=Country', value: 'Bangladesh' },
    ], submit: 'role=button[name="Sign in"]' } },
    { id: 'wait', type: 'wait-for', config: { mode: 'url', url: '/welcome' } },
    { id: 'see', type: 'assert', config: { subject: 'text', locator: '#greeting', operator: 'contains', expected: 'Welcome' } },
    { id: 'close', type: 'close-tab' },
  ]);
  const second = workflow('Check the welcome page', [
    { id: 'open', type: 'open-url', config: { url: `${base}/welcome.html`, active: true } },
    { id: 'see', type: 'assert', config: { subject: 'text', locator: '#greeting', operator: 'contains', expected: 'Welcome' } },
    { id: 'close', type: 'close-tab' },
  ]);
  await seedWorkflows([login, second]);
  await worker.evaluate((suites) => chrome.storage.local.set({ 'bf:suites': suites }), [{ id: 'smoke', name: 'Smoke tests', workflowIds: [login.id, second.id] }]);

  // 1. The canvas after a run (green marks).
  await runWith(login);
  await h.editor.reload();
  await h.editor.waitForSelector('.react-flow__node');
  await h.editor.click(`.bf-sidebar >> text=${login.name}`).catch(() => {});
  await h.editor.click('.react-flow__controls-fitview').catch(() => {});
  await h.editor.waitForTimeout(800);
  await shot('1-canvas');

  // 2. Reports: a traced run with the filmstrip.
  // The tab must be showing for the browser to take its picture: bring the run's tab forward while it runs.
  await runWith(login, { trace: true });
  await h.editor.bringToFront();
  await h.editor.click('.bf-header .bf-tabs button:has-text("Reports")');
  await h.editor.waitForSelector('.bf-report-list button');
  await h.editor.locator('.bf-report-list button').first().click();
  await h.editor.waitForSelector('.bf-filmstrip .bf-filmstrip-frame img', { timeout: 15_000 }).catch(() => {});
  await shot('2-reports-trace');

  // 3. Suites: a saved suite with its last result.
  await h.editor.click('.bf-header .bf-tabs button:has-text("Suites")');
  await h.editor.getByRole('button', { name: 'Smoke tests' }).click();
  await h.editor.getByRole('button', { name: '▶ Run suite' }).click();
  await h.editor.waitForSelector('.bf-suite-result .bf-run-status', { timeout: 60_000 }).catch(() => {});
  await shot('3-suites');

  // 4. Settings: outside control (off) and limits.
  await h.editor.click('.bf-header .bf-tabs button:has-text("Settings")');
  await shot('4-settings');

  // 5. Secrets page.
  await h.editor.click('.bf-header .bf-tabs button:has-text("Secrets")');
  await shot('5-secrets');
} finally {
  await h.close();
}
