// e2e scenario (M5.3): Screenshot with "compare" against a baseline per (workflow, block), masks, the
// visual.mismatch failure with a stored diff picture, and "Accept new baseline" (bf:accept-baseline).
// Run alone: BF_HEADLESS=1 BF_EXTENSION_DIR=.output-visual/chrome-mv3 node tests/e2e/run.mjs m5-visual
// Fixture: tests/fixtures/site/visual.html (?v=2 moves/recolours #hero, ?clock=… and ?badge=… change masked parts).

/** @param {import('../harness.mjs').Harness} h */
export default async function (h) {
  const { base, check, run, step, summary, workflow } = h;
  console.log('M5: visual comparison');

  const wf = workflow('visual compare', [
    { id: 'open', type: 'open-url', config: { url: `${base}/visual.html`, active: false } },
    { id: 'page', type: 'screenshot', config: { compare: true, mask: [{ region: '#clock' }, { region: '272, 332, 40, 20' }] } },
    // #badge is at 272,332 (40×20) on the page: masked by a rectangle there, by its locator in the element shot.
    { id: 'card', type: 'screenshot', config: { area: 'element', locator: '#card', compare: true, mask: [{ region: '#badge' }] } },
    { id: 'full', type: 'screenshot', config: { area: 'full', compare: true, mask: [{ region: '#clock' }, { region: '#badge' }] } },
    { id: 'close', type: 'close-tab' },
  ]);
  /** Runs the same workflow (same id, so the same baselines) on visual.html with `query`. */
  const runWith = (query) => {
    wf.nodes[0].config.url = `${base}/visual.html${query}`;
    return run(wf);
  };
  /** The comparisons of a node, newest first (IndexedDB `blockflow-visual`, read in the editor page). */
  const comparisons = (nodeId) =>
    h.editor.evaluate(async (id) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('blockflow-visual');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const all = await new Promise((resolve) => {
        const request = db.transaction('comparisons').objectStore('comparisons').index('nodeId').getAll(id);
        request.onsuccess = () => resolve(request.result);
      });
      db.close();
      return all.sort((a, b) => b.ts - a.ts);
    }, nodeId);
  /** The start of a stored screenshot's data: URL, or null. */
  const stored = (id) =>
    h.editor.evaluate(async (shotId) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('blockflow');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const shot = await new Promise((resolve) => {
        const request = db.transaction('screenshots').objectStore('screenshots').get(shotId);
        request.onsuccess = () => resolve(request.result);
      });
      db.close();
      return shot?.dataUrl?.slice(0, 22) ?? null;
    }, id);

  const first = await runWith('');
  check(
    'Visual: first run passes and stores the baselines (visible area, element, full page)',
    first.status === 'passed' && ['page', 'card', 'full'].every((id) => step(first, id)?.output?.visual?.status === 'baseline-saved'),
    JSON.stringify(step(first, 'page')?.output?.visual ?? summary(first)),
  );

  const same = await runWith('');
  check(
    'Visual: the same page matches (0 differing pixels)',
    same.status === 'passed' && step(same, 'page')?.output?.visual?.status === 'match' && step(same, 'page')?.output?.visual?.diffPixels === 0 && step(same, 'card')?.output?.visual?.status === 'match' && step(same, 'full')?.output?.visual?.status === 'match',
    JSON.stringify(step(same, 'page')?.output?.visual ?? summary(same)),
  );

  const masked = await runWith('?clock=23:59&badge=%23f59e0b');
  check(
    'Visual: changes inside masked regions pass (#clock by locator, #badge by rectangle and by locator in the element shot)',
    masked.status === 'passed' && ['page', 'card', 'full'].every((id) => step(masked, id)?.output?.visual?.status === 'match'),
    `${JSON.stringify(step(masked, 'page')?.output?.visual)} ${JSON.stringify(step(masked, 'card')?.output?.visual)} ${summary(masked)}`,
  );

  const changed = await runWith('?v=2');
  const failed = step(changed, 'page');
  check('Visual: a moved/recoloured element fails with visual.mismatch', changed.status === 'failed' && failed?.status === 'failed' && failed?.code === 'visual.mismatch' && /differs from the baseline/.test(failed?.error ?? ''), summary(changed));
  const [mismatch] = await comparisons('page');
  check(
    'Visual: the mismatch is stored with baseline / actual / diff pictures',
    mismatch?.status === 'mismatch' && mismatch.diffRatio > 0.01 && Boolean(mismatch.diffId && mismatch.baselineId && mismatch.actualId) && mismatch.runId === changed.id,
    JSON.stringify(mismatch),
  );
  const pictures = mismatch ? await Promise.all([stored(mismatch.baselineId), stored(mismatch.actualId), stored(mismatch.diffId)]) : [];
  check('Visual: the three pictures are PNG screenshots in IndexedDB', pictures.length === 3 && pictures.every((prefix) => prefix === 'data:image/png;base64,'), JSON.stringify(pictures));

  // Accept new baseline (what the Visual compare panel sends), then the new look passes.
  const reply = await h.editor.evaluate(
    (comparisonId) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ timeout: true }), 15_000);
        chrome.runtime.onMessage.addListener(function listener(message) {
          if (message?.type !== 'bf:baseline-accepted' || message.comparisonId !== comparisonId) return;
          clearTimeout(timer);
          chrome.runtime.onMessage.removeListener(listener);
          resolve(message);
        });
        void chrome.runtime.sendMessage({ type: 'bf:accept-baseline', comparisonId });
      }),
    mismatch?.id,
  );
  check('Visual: bf:accept-baseline answers bf:baseline-accepted', reply?.type === 'bf:baseline-accepted' && !reply.error, JSON.stringify(reply));
  const [acceptedRecord] = (await comparisons('page')).filter((item) => item.id === mismatch?.id);
  check('Visual: the comparison is marked accepted', typeof acceptedRecord?.acceptedAt === 'number', JSON.stringify(acceptedRecord));

  const after = await runWith('?v=2');
  // Baselines are per block: only "page" was accepted, the full-page block still has the old look.
  check(
    'Visual: after accepting, the new look passes that block (others keep their own baseline)',
    step(after, 'page')?.status === 'passed' && step(after, 'page')?.output?.visual?.status === 'match' && step(after, 'full')?.code === 'visual.mismatch',
    summary(after),
  );
  const old = await runWith('');
  check('Visual: and the old look now fails', old.status === 'failed' && step(old, 'page')?.code === 'visual.mismatch', summary(old));
}
