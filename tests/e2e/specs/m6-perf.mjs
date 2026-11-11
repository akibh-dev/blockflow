// e2e for M6.5: a 500-block workflow opens, renders and saves without lag. Prints the numbers.
//   BF_E2E=1 npx wxt build && BF_HEADLESS=1 node tests/e2e/run.mjs m6-perf
// Limits are for headless Chromium on a normal development machine; a slow CI runner may need BF_PERF_SLACK=2.

/** @param {import('../harness.mjs').Harness} h */
export default async function m6Perf(h) {
  const { check, worker, seedWorkflows } = h;
  const slack = Number(process.env.BF_PERF_SLACK ?? 1);
  console.log('M6.5 performance: a 500-block workflow');

  const N = 500;
  const COLS = 25;
  const nodes = Array.from({ length: N }, (_, i) => ({
    id: `n${i}`,
    type: 'log',
    position: { x: (i % COLS) * 260, y: Math.floor(i / COLS) * 120 },
    config: { message: `block ${i}` },
  }));
  const edges = nodes.slice(1).map((node, i) => ({ id: `e${i}`, source: `n${i}`, target: node.id }));
  const wf = { schemaVersion: 2, id: 'perf-500', name: 'Perf 500', enabled: false, nodes, edges };

  const t0 = Date.now();
  await seedWorkflows([wf]); // writes bf:workflows and reopens the editor
  await h.editor.waitForSelector('.react-flow__node', { timeout: 30_000 });
  const openMs = Date.now() - t0;
  const firstPaint = await h.editor.locator('.react-flow__node').count();
  console.log(`  opened in ${openMs} ms (${firstPaint} of ${N} blocks drawn: only those in view)`);
  check('only the blocks in view are drawn (the rest are virtualised)', firstPaint > 0 && firstPaint < N / 2, `${firstPaint} of ${N}`);
  check(`a ${N}-block workflow opens in under ${5 * slack} s`, openMs < 5000 * slack, `${openMs} ms`);

  // Dragging one node must save once, quickly.
  const first = h.editor.locator('.react-flow__node').first();
  const box = await first.boundingBox();
  const saves = await worker.evaluate(() => {
    globalThis.__bfPerfSaves = 0;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes['bf:workflows']) globalThis.__bfPerfSaves += 1;
    });
    return true;
  });
  const before = await worker.evaluate(async () => (await chrome.storage.local.get('bf:workflows'))['bf:workflows'][0].nodes[0].position);
  const t1 = Date.now();
  await h.editor.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await h.editor.mouse.down();
  for (let i = 1; i <= 20; i += 1) await h.editor.mouse.move(box.x + box.width / 2 + i * 6, box.y + box.height / 2 + i * 3);
  await h.editor.mouse.up();
  let moved = false;
  for (let deadline = Date.now() + 5000; Date.now() < deadline && !moved; ) {
    const now = await worker.evaluate(async () => (await chrome.storage.local.get('bf:workflows'))['bf:workflows'][0].nodes[0].position);
    moved = now.x !== before.x || now.y !== before.y;
    if (!moved) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const saveMs = Date.now() - t1;
  await new Promise((resolve) => setTimeout(resolve, 800)); // let any trailing debounced save land
  const writes = await worker.evaluate(() => globalThis.__bfPerfSaves);
  console.log(`  drag saved in ${saveMs} ms with ${writes} write(s) to bf:workflows`);
  check('the dragged position is saved', moved, saves ? 'not saved within 5 s' : '');
  check(`the drag is saved within ${2 * slack} s`, saveMs < 2000 * slack, `${saveMs} ms`);
  check('one drag causes few writes (debounced, not one per mouse move)', writes <= 3, `${writes} writes for 20 moves`);

  // Typing in the name field must stay responsive with 500 blocks on the canvas.
  const t2 = Date.now();
  await h.editor.fill('input[aria-label="Workflow name"]', 'Perf 500 renamed');
  await h.editor.waitForFunction(() => document.querySelector('input[aria-label="Workflow name"]')?.value === 'Perf 500 renamed');
  const renameMs = Date.now() - t2;
  console.log(`  rename applied in ${renameMs} ms`);
  check(`renaming is responsive (under ${1 * slack} s)`, renameMs < 1000 * slack, `${renameMs} ms`);

  // Fit view brings far more blocks into view (the controls' "fit view" button), still virtualised.
  await h.editor.click('.react-flow__controls-fitview');
  await h.editor.waitForFunction((before) => document.querySelectorAll('.react-flow__node').length > before, firstPaint, { timeout: 10_000 }).catch(() => {});
  const afterFit = await h.editor.locator('.react-flow__node').count();
  check('fit view shows more of the workflow', afterFit > firstPaint, `${firstPaint} -> ${afterFit}`);
}
