// Shared e2e harness: builds nothing, just launches a Chromium-based browser with the e2e build of
// the extension (.output-e2e/chrome-mv3, built with BF_E2E=1) in a throwaway profile, serves
// tests/fixtures/site, and gives the specs in ./specs helpers to run workflows through the real
// background worker. Used by run.mjs.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PASSWORD, startServer } from './server.mjs';

/**
 * @typedef {Awaited<ReturnType<typeof launch>>} Harness
 */

/** Starts the fixture server and the browser with the extension; returns the helpers specs use. */
export async function launch() {
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
  /** Opens the extension's editor page in a new tab, collecting its uncaught errors in `pageErrors`. */
  async function openEditor() {
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/editor.html`);
    return page;
  }
  // The first-run "Try it" card floats over the canvas; specs other than editor-ux do not want it.
  await worker.evaluate(() => chrome.storage.local.set({ 'bf:onboarding': { tryItDismissed: true } }));
  let editor = await openEditor();

  let failures = 0;
  /** Prints ✓/✗ for one assertion (with `detail` on failure) and counts failures for the exit code. */
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

  /**
   * Runs `wf` through the background worker (`bf:run-workflow` message from the editor page), then polls
   * `bf:runs` in storage every 200 ms until a finished run of that workflow appears (90 s limit).
   */
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

  /** The step record of node `id` in a run record (the first one, for nodes inside loops). */
  const step = (record, id) => record.steps.find((candidate) => candidate.nodeId === id);
  /** One-line `node:status (error)` trail of a run, printed when a check fails. */
  const summary = (record) => record.steps.map((s) => `${s.nodeId}:${s.status}${s.error ? ` (${s.error})` : ''}`).join(' → ');

  const h = {
    base,
    server,
    context,
    worker,
    extensionId,
    executablePath,
    here,
    path,
    PASSWORD,
    check,
    workflow,
    run,
    seedWorkflows,
    step,
    summary,
    openEditor,
    /** The current editor tab (reopened by seedWorkflows). */
    get editor() {
      return editor;
    },
    set editor(page) {
      editor = page;
    },
    get failures() {
      return failures;
    },
    pageErrors,
    /** Closes the browser and the server and removes the profile. */
    async close() {
      await context.close();
      server.close();
      rmSync(profile, { recursive: true, force: true });
    },
  };
  return h;
}
