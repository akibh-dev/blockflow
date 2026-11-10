// M5.1 trace: a traced run (bf:run-workflow options {trace: true}) stores before/after pictures in IndexedDB,
// the element's box matches the page, the Reports timeline shows the filmstrip and the box, the HTML export
// embeds the pictures, and `step.trace: true` traces a single step of an untraced run. Also the `box` and
// `highlight` page ops in a real tab.

/** @param {import('../harness.mjs').Harness} h */
export default async function (h) {
  const { base, check, context, seedWorkflows, step, summary, worker, workflow } = h;
  console.log('M5.1: trace timeline');

  /** Like harness `run`, with `options` on the message (the harness one sends none). */
  async function runWith(wf, options) {
    const readRuns = async () => (await worker.evaluate(() => chrome.storage.local.get('bf:runs')))['bf:runs'] ?? [];
    const seen = new Set((await readRuns()).filter((candidate) => candidate.workflowId === wf.id).map((candidate) => candidate.id));
    await h.editor.evaluate(([w, o]) => chrome.runtime.sendMessage({ type: 'bf:run-workflow', workflow: w, ...(o ? { options: o } : {}) }), [wf, options]);
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const done = (await readRuns()).findLast((candidate) => candidate.workflowId === wf.id && !seen.has(candidate.id) && candidate.status !== 'running');
      if (done) return done;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Run of ${wf.name} did not finish`);
  }

  /** The stored pictures (IndexedDB `blockflow` / `screenshots`) with these ids: id → data URL prefix. */
  const stored = (ids) =>
    worker.evaluate(async (wanted) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('blockflow');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const out = {};
      for (const id of wanted) {
        const shot = await new Promise((resolve) => {
          const request = db.transaction('screenshots').objectStore('screenshots').get(id);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(undefined);
        });
        out[id] = shot ? String(shot.dataUrl).slice(0, 23) : null;
      }
      db.close();
      return out;
    }, ids);

  const wf = workflow('M5 traced', [
    { id: 'open', type: 'open-url', config: { url: `${base}/clicks.html`, active: true } },
    { id: 'click', type: 'click', config: { locator: '#target' } },
    { id: 'fill', type: 'fill', config: { locator: '#name', value: 'traced' } },
  ]);
  await seedWorkflows([wf]);
  const started = Date.now();
  const traced = await runWith(wf, { trace: true });
  const tracedMs = Date.now() - started;
  check('traced run passes and is marked mode.trace', traced.status === 'passed' && traced.mode?.trace === true, summary(traced) + JSON.stringify(traced.mode));
  const clickTrace = step(traced, 'click')?.trace;
  const fillTrace = step(traced, 'fill')?.trace;
  check('click and fill have before/after pictures, URL', Boolean(clickTrace?.before && clickTrace?.after && fillTrace?.before && fillTrace?.after) && String(clickTrace?.url).endsWith('/clicks.html'), JSON.stringify({ clickTrace, fillTrace }));
  // Open Tab has no tab before it runs: only the after picture, on the tab it opened (from its output).
  const openTrace = step(traced, 'open')?.trace;
  check('Open Tab is traced after it opened its tab (no before picture)', !openTrace?.before && Boolean(openTrace?.after) && String(openTrace?.url).endsWith('/clicks.html'), JSON.stringify(openTrace));
  const ids = [clickTrace?.before, clickTrace?.after, fillTrace?.before, fillTrace?.after].filter(Boolean);
  const pictures = await stored(ids);
  check('trace pictures are in IndexedDB (JPEG, ~t| ids)', ids.length === 4 && ids.every((id) => id.startsWith('~t|') && pictures[id] === 'data:image/jpeg;base64,'), JSON.stringify(pictures));

  const tabId = step(traced, 'open')?.output?.tabId;
  const page = context.pages().find((candidate) => candidate.url().endsWith('/clicks.html'));
  if (page) {
    const real = await page.evaluate(() => {
      const rect = document.querySelector('#target').getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, vw: innerWidth, vh: innerHeight };
    });
    const box = clickTrace?.box;
    const near = (a, b) => typeof a === 'number' && Math.abs(a - b) <= 2;
    check('box matches the element in the page', Boolean(box) && near(box.x, real.x) && near(box.y, real.y) && near(box.width, real.width) && near(box.height, real.height), JSON.stringify({ box, real }));
    check('viewport is recorded with the box', clickTrace?.viewport?.width === real.vw && clickTrace?.viewport?.height === real.vh, JSON.stringify(clickTrace?.viewport));

    // The page ops themselves, through the agent the run injected.
    const agentRun = (request) =>
      worker.evaluate(async ([id, call]) => (await chrome.scripting.executeScript({ target: { tabId: id }, func: (c) => globalThis.__blockflowAgent.run(c), args: [call] }))[0]?.result, [tabId, { request, budgetMs: 0 }]);
    const boxAnswer = await agentRun({ op: 'box', locator: '#target' });
    check('box op answers the element box at once', boxAnswer?.status === 'done' && boxAnswer.result.found === true && near(boxAnswer.result.x, real.x) && boxAnswer.result.visible === true, JSON.stringify(boxAnswer));
    const missing = await agentRun({ op: 'box', locator: '#nope' });
    check('box op: nothing matching → found: false', missing?.status === 'done' && missing.result.found === false, JSON.stringify(missing));
    const lit = await agentRun({ op: 'highlight', locator: '#target', label: 'Paused: Click' });
    const overlay = await page.evaluate(() => {
      const el = document.querySelector('[data-blockflow-highlight]');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, events: getComputedStyle(el).pointerEvents, hitsTarget: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.id };
    });
    check('highlight draws an overlay over the element that does not catch clicks', lit?.result?.highlighted === true && overlay && near(overlay.x, real.x - 2) && near(overlay.y, real.y - 2) && overlay.events === 'none' && overlay.hitsTarget === 'target', JSON.stringify({ lit, overlay }));
    await agentRun({ op: 'highlight', clear: true });
    check('highlight clear removes it', (await page.evaluate(() => document.querySelectorAll('[data-blockflow-highlight]').length)) === 0);
    await agentRun({ op: 'highlight', locator: '#target', ms: 300 });
    await new Promise((resolve) => setTimeout(resolve, 700));
    check('highlight with ms goes away by itself', (await page.evaluate(() => document.querySelectorAll('[data-blockflow-highlight]').length)) === 0);
  } else check('the traced tab is open', false, context.pages().map((candidate) => candidate.url()).join(', '));

  // Reports timeline: filmstrip with pictures, box over the after picture.
  await h.editor.bringToFront();
  await h.editor.click('.bf-header .bf-tabs button:has-text("Reports")');
  await h.editor.click('.bf-report-list button:has-text("M5 traced")');
  const film = await h.editor.waitForSelector('.bf-filmstrip .bf-filmstrip-frame img', { timeout: 10_000 }).then(() => true, () => false);
  check('Reports shows a filmstrip of the traced steps', film && (await h.editor.locator('.bf-filmstrip .bf-filmstrip-frame').count()) === 3);
  const boxShown = await h.editor.waitForSelector('[data-testid="trace-box"]', { timeout: 10_000 }).then(() => true, () => false);
  check('the box is drawn over the after picture', boxShown);
  await h.editor.locator('.bf-filmstrip .bf-filmstrip-frame').nth(1).click();
  check('clicking a frame picks its step', (await h.editor.locator('.bf-report-steps li.bf-picked').count()) === 1);
  check('the step shows its URL and before/after', (await h.editor.locator('.bf-report-steps .bf-trace-url').first().innerText()).endsWith('/clicks.html') && (await h.editor.locator('.bf-trace-shot img').count()) >= 4);
  await h.editor.selectOption('select[aria-label="Workflow"]', wf.id);
  const [htmlReport] = await Promise.all([h.editor.waitForEvent('download'), h.editor.click('button:has-text("Export HTML")')]);
  const html = await (await import('node:fs/promises')).readFile(await htmlReport.path(), 'utf8');
  check('HTML export embeds the trace pictures and the box', (html.match(/<img src="data:image\/jpeg;base64,/g) ?? []).length >= 4 && html.includes('class="box"'), html.length);

  // An untraced run where only one step has step.trace.
  const single = workflow('M5 one traced step', [
    { id: 'open', type: 'open-url', config: { url: `${base}/clicks.html`, active: true } },
    { id: 'click', type: 'click', config: { locator: '#target' }, step: { trace: true } },
    { id: 'fill', type: 'fill', config: { locator: '#name', value: 'x' } },
  ]);
  await seedWorkflows([single]);
  const untracedStart = Date.now();
  const one = await runWith(single);
  const untracedMs = Date.now() - untracedStart;
  check('untraced run with step.trace: only that step is traced', one.status === 'passed' && !one.mode && Boolean(step(one, 'click')?.trace?.after) && step(one, 'fill')?.trace === undefined, summary(one) + JSON.stringify(one.steps.map((s) => s.trace)));
  check('tracing did not use the debugger', traced.usedDebugger !== true && one.usedDebugger !== true);
  console.log(`    (traced run ${tracedMs} ms, run with one traced step ${untracedMs} ms)`);

  // Network summary: only when the run already uses the debugger on the tab (HAR Record attaches it here).
  const net = workflow('M5 traced network', [
    { id: 'open', type: 'open-url', config: { url: `${base}/m3-telemetry.html`, active: true } },
    { id: 'har', type: 'har-record' },
    { id: 'fetch', type: 'click', config: { locator: '#fetch' }, step: { trace: true } },
    { id: 'response', type: 'wait-for', config: { mode: 'text', locator: '#status', text: 'Fetched 200' }, step: { trace: true } },
    { id: 'stop', type: 'har-record', config: { action: 'stop' } },
  ]);
  await seedWorkflows([net]);
  const netRun = await runWith(net);
  const counted = (step(netRun, 'fetch')?.trace?.network?.requests ?? 0) + (step(netRun, 'response')?.trace?.network?.requests ?? 0);
  const slowest = [...(step(netRun, 'fetch')?.trace?.network?.slowest ?? []), ...(step(netRun, 'response')?.trace?.network?.slowest ?? [])];
  check('with CDP already on, traced steps get a network summary', netRun.status === 'passed' && counted >= 1 && slowest.some((request) => request.url.includes('/export.csv')), summary(netRun) + JSON.stringify(netRun.steps.map((s) => s.trace?.network)));
  check('without CDP there is no network summary', step(traced, 'click')?.trace?.network === undefined);

  for (const id of [tabId, step(one, 'open')?.output?.tabId, step(netRun, 'open')?.output?.tabId]) if (Number.isInteger(id)) await worker.evaluate((t) => chrome.tabs.remove(t).catch(() => {}), id);
}
