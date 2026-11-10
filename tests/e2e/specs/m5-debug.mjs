// M5.2 / M5.5: debug runs (breakpoint, Step, Continue, Stop while paused, pause on error) and Run from here.
// The run pauses in the worker (src/browser/debugChannel.ts); the pause is listed in storage.session
// `bf:debug-pause` and answered with `bf:debug-answer` (DebugBanner) or `bf:stop-run` (Stop).
/** @param {import('../harness.mjs').Harness} h */
export default async function (h) {
  const { base, check, workflow, worker, step, summary } = h;
  console.log('M5 debug: breakpoints, Step / Continue / Stop, pause on error, Run from here');

  const poll = async (read, what, timeout = 20_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };
  const pauses = async () => (await h.editor.evaluate(() => chrome.storage.session.get('bf:debug-pause')))['bf:debug-pause'] ?? [];
  const pausedAt = (runOrWorkflow, nodeId) =>
    poll(async () => (await pauses()).find((p) => (p.workflowId === runOrWorkflow || p.runId === runOrWorkflow) && (!nodeId || p.nodeId === nodeId)), `a pause at ${nodeId}`);
  const readRuns = async () => (await worker.evaluate(() => chrome.storage.local.get('bf:runs')))['bf:runs'] ?? [];
  /** Sends bf:run-workflow with `options` from the editor page; resolves with a function that waits for the finished run. */
  const start = async (wf, options) => {
    const seen = new Set((await readRuns()).filter((r) => r.workflowId === wf.id).map((r) => r.id));
    await h.editor.evaluate(([w, o]) => chrome.runtime.sendMessage({ type: 'bf:run-workflow', workflow: w, options: o }), [wf, options]);
    return () => poll(async () => (await readRuns()).findLast((r) => r.workflowId === wf.id && !seen.has(r.id) && r.status !== 'running'), `the run of ${wf.name} to finish`, 90_000);
  };
  /** Banner button when the editor mounts DebugBanner (root wires it into Editor.tsx), else the same message. */
  let bannerMounted;
  const answer = async (runId, action) => {
    const label = { continue: 'Continue', step: 'Step', stop: 'Stop' }[action];
    const button = h.editor.locator(`.bf-debug-pause[data-run-id="${runId}"] button`, { hasText: label });
    if (bannerMounted && (await button.count()) > 0) await button.first().click();
    else await h.editor.evaluate(([r, a]) => chrome.runtime.sendMessage({ type: 'bf:debug-answer', runId: r, action: a }), [runId, action]);
  };
  const fixturePage = () => h.context.pages().find((page) => page.url().includes('/clicks.html'));
  const highlighted = async () => Boolean(await fixturePage()?.evaluate(() => document.querySelector('[data-blockflow-highlight]') !== null));

  const debugged = workflow('M5 debug breakpoints', [
    { id: 'open', type: 'open-url', config: { url: `${base}/clicks.html`, active: false } },
    { id: 'press', type: 'click', config: { locator: '#target' }, step: { pause: true } },
    { id: 'check', type: 'assert', config: { subject: 'text', locator: '#log', operator: 'contains', expected: 'click' } },
    { id: 'done', type: 'log', config: { message: 'done' } },
  ]);
  const stopped = workflow('M5 debug stop while paused', [
    { id: 'first', type: 'log', config: { message: 'first' } },
    { id: 'held', type: 'log', config: { message: 'held' }, step: { pause: true } },
    { id: 'never', type: 'log', config: { message: 'never' } },
  ]);
  const failing = workflow('M5 debug pause on error', [
    { id: 'first', type: 'log', config: { message: 'first' } },
    { id: 'bad', type: 'assert', config: { subject: 'value', value: 'actual', operator: 'equals', expected: 'expected' }, step: { screenshot: 'never' } },
  ]);
  await h.seedWorkflows([debugged, stopped, failing]);

  // --- breakpoint, highlight, editor reopen, Step, Continue after > 30 s ------------------------
  const finished = await start(debugged, { debug: {} });
  const first = await pausedAt(debugged.id, 'press');
  check('a debug run pauses at the breakpoint, listed in storage.session', first.reason === 'breakpoint' && first.workflowName === 'M5 debug breakpoints' && first.locator === '#target', JSON.stringify(first));
  check('the paused input carries the step input (the tab)', typeof first.tabId === 'number' && first.input && typeof first.input === 'object', JSON.stringify(first.input));
  const banner = h.editor.locator(`.bf-debug-pause[data-run-id="${first.runId}"]`);
  bannerMounted = await banner.waitFor({ timeout: 3000 }).then(() => true, () => false);
  if (bannerMounted) check('the banner shows the paused step and its input', (await banner.textContent()).includes('paused before Click') && (await banner.locator('pre').textContent()).includes('"tabId"'));
  else console.log('    (DebugBanner is not mounted in Editor.tsx in this build: answering with bf:debug-answer messages)');
  check('the element is outlined on the page while paused', await poll(highlighted, 'the highlight', 5000).catch(() => false));
  check('the paused step has not run', !(await fixturePage()?.evaluate(() => document.getElementById('log').textContent.includes('click'))));

  // Close the editor and open it again: the pause is still there and can be answered.
  const placeholder = await h.context.newPage();
  await h.editor.close();
  h.editor = await h.openEditor();
  await placeholder.close();
  const again = await pausedAt(first.runId, 'press');
  check('after the editor is reopened the pause is still listed', again.runId === first.runId);
  if (bannerMounted) check('…and the reopened editor shows the banner', await h.editor.locator(`.bf-debug-pause[data-run-id="${first.runId}"]`).waitFor({ timeout: 5000 }).then(() => true, () => false));

  await answer(first.runId, 'step');
  const stepped = await pausedAt(first.runId, 'check');
  check('Step runs the block and pauses before the next one', stepped.reason === 'step');
  check('…the stepped block ran (the click happened)', Boolean(await fixturePage()?.evaluate(() => document.getElementById('log').textContent.includes('click'))));
  check('…and the outline moved to the next step', await highlighted());

  // Paused for longer than the MV3 idle timeout (30 s): the worker must still be there to continue.
  console.log('    waiting 33 s while paused (MV3 idle timeout)…');
  await new Promise((resolve) => setTimeout(resolve, 33_000));
  check('the pause survives 30 s of waiting', (await pauses()).some((p) => p.runId === first.runId && p.nodeId === 'check'));
  await answer(first.runId, 'continue');
  const passed = await finished();
  check('Continue runs to the end', passed.status === 'passed' && passed.mode?.debug === true && step(passed, 'done')?.status === 'passed', summary(passed));
  check('nothing is left paused and the outline is gone', (await pauses()).length === 0 && !(await highlighted()));

  // --- Stop while paused (the Stop button's message) --------------------------------------------
  const stopDone = await start(stopped, { debug: {} });
  const held = await pausedAt(stopped.id, 'held');
  await h.editor.evaluate((runId) => chrome.runtime.sendMessage({ type: 'bf:stop-run', runId }), held.runId);
  const cancelled = await stopDone();
  check('Stop ends a paused run', cancelled.status === 'cancelled' && step(cancelled, 'held')?.status === 'skipped' && !step(cancelled, 'never'), summary(cancelled));
  check('…and removes the pause', !(await pauses()).some((p) => p.runId === held.runId));

  // Stop from the banner (bf:debug-answer stop) as well.
  const stopDone2 = await start(stopped, { debug: {} });
  const held2 = await pausedAt(stopped.id, 'held');
  await answer(held2.runId, 'stop');
  const cancelled2 = await stopDone2();
  check('the banner’s Stop ends the run too', cancelled2.status === 'cancelled' && !step(cancelled2, 'never'), summary(cancelled2));

  // --- pause on error -----------------------------------------------------------------------------
  const failDone = await start(failing, { debug: { pauseOnError: true } });
  const onError = await pausedAt(failing.id, 'bad');
  check('pause on error pauses at the failing step with its error', onError.reason === 'error' && /expected/i.test(onError.error ?? ''), JSON.stringify(onError));
  await answer(onError.runId, 'continue');
  const failed = await failDone();
  check('…Continue then handles the failure (the run fails)', failed.status === 'failed' && step(failed, 'bad')?.status === 'failed', summary(failed));
  const noPause = await (await start(failing, { debug: {} }))();
  check('without pause on error a failing debug run does not pause', noPause.status === 'failed');

  // --- Run from here: the last run's input of `check` -------------------------------------------
  const input = step(passed, 'check')?.input;
  check('the last run kept the input of the step (not shortened)', input && !('$preview' in input), JSON.stringify(input));
  const fromHere = await (await start(debugged, { startAt: { nodeId: 'check', input } }))();
  check(
    'Run from here starts at that block with that input and goes on',
    fromHere.status === 'passed' && fromHere.mode?.startedAt === 'check' && fromHere.steps[0]?.nodeId === 'check' && !step(fromHere, 'open') && step(fromHere, 'done')?.status === 'passed',
    summary(fromHere),
  );
  check('…with the same input as the earlier run', JSON.stringify(step(fromHere, 'check')?.input) === JSON.stringify(input));

  await fixturePage()?.close().catch(() => {});

  // --- the editor UI (RunControls, DebugBanner, ConfigPanel), once root mounts them in Editor.tsx ----
  await h.editor.click(`.bf-workflow-name:has-text("${stopped.name}")`).catch(() => {});
  await h.editor.waitForTimeout(400);
  if ((await h.editor.locator('.bf-run-controls').count()) === 0) {
    console.log('    (RunControls is not mounted in Editor.tsx in this build: editor UI checks skipped)');
    return;
  }
  const latest = async (id, seen) => poll(async () => (await readRuns()).findLast((r) => r.workflowId === id && !seen.has(r.id) && r.status !== 'running'), 'a finished run', 30_000);
  const seenNow = async (id) => new Set((await readRuns()).filter((r) => r.workflowId === id).map((r) => r.id));

  let seen = await seenNow(stopped.id);
  await h.editor.click('.bf-run-controls button:has-text("Debug")');
  const uiPause = await pausedAt(stopped.id, 'held');
  const uiBanner = h.editor.locator(`.bf-debug-pause[data-run-id="${uiPause.runId}"]`);
  check('🐞 Debug pauses and the banner appears', await uiBanner.waitFor({ timeout: 5000 }).then(() => true, () => false));
  check('the header shows Stop while paused', await h.editor.locator('header button.bf-stop:has-text("Stop")').isVisible());
  await uiBanner.locator('button', { hasText: 'Continue' }).click();
  const uiDone = await latest(stopped.id, seen);
  check('Continue in the banner finishes the run', uiDone.status === 'passed' && uiDone.mode?.debug === true && (await uiBanner.count()) === 0, summary(uiDone));

  seen = await seenNow(stopped.id);
  await h.editor.click('.bf-run-controls button:has-text("Run with trace")');
  const traced = await latest(stopped.id, seen);
  check('Run with trace starts a traced run', traced.mode?.trace === true && traced.status === 'passed', JSON.stringify(traced.mode));

  // Step settings toggles are saved with the block.
  await h.editor.click('.react-flow__node[data-id="first"]');
  await h.editor.click('.bf-step-settings summary').catch(() => {});
  await h.editor.locator('label:has-text("Trace this step") input').check();
  await h.editor.waitForTimeout(900);
  const savedWf = (await worker.evaluate(() => chrome.storage.local.get('bf:workflows')))['bf:workflows'].find((w) => w.id === stopped.id);
  check('"Trace this step" is saved as step.trace', savedWf?.nodes.find((n) => n.id === 'first')?.step?.trace === true, JSON.stringify(savedWf?.nodes.find((n) => n.id === 'first')?.step));

  // Run from here on "held": its input from the last run.
  await h.editor.click('.react-flow__node[data-id="held"]');
  const fromButton = h.editor.locator('.bf-run-from button');
  check('Run from here is enabled for a block the last run reached', await fromButton.isEnabled());
  seen = await seenNow(stopped.id);
  await fromButton.click();
  const uiFrom = await latest(stopped.id, seen);
  check('the button runs from that block', uiFrom.mode?.startedAt === 'held' && uiFrom.steps[0]?.nodeId === 'held' && uiFrom.status === 'passed', summary(uiFrom));
}
