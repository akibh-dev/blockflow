// e2e scenarios for the editor's own UI: in-editor dialogs and toasts (no window.alert/confirm/prompt),
// cleanup when a workflow is deleted, the real-input setting only on page actions, undo per workflow,
// paste at the mouse, and the first-run "Try it" card with the playground (scripts/playground.mjs).
// Run alone with `npm run e2e -- editor-ux`. `h` is the shared harness (tests/e2e/harness.mjs).
import { PLAYGROUND_PORT, startPlayground } from '../../../scripts/playground.mjs';

/** @param {import('../harness.mjs').Harness} h */
export default async function editorUx(h) {
  const { check, seedWorkflows, summary, worker, workflow } = h;
  console.log('Editor UX: dialogs, cleanup on delete, real input, undo per workflow, paste at mouse, Try it card');

  const stored = async (key) => (await worker.evaluate((k) => chrome.storage.local.get(k), key))[key];
  const workflows = async () => (await stored('bf:workflows')) ?? [];
  const nodeCount = () => h.editor.locator('.bf-node').count();
  let nativeDialogs = 0;
  const watchNative = (page) => page.on('dialog', (dialog) => {
    nativeDialogs += 1;
    void dialog.dismiss();
  });

  // --- dialogs, toasts, the All workflows switch, cleanup on delete ---------------------------
  const good = workflow('UX good', [{ id: 'note', type: 'log', config: { message: 'hi' } }]);
  const broken = workflow('UX broken', [{ id: 'c', type: 'click', config: { locator: '' } }]);
  await seedWorkflows([good, broken]);
  watchNative(h.editor);

  await h.editor.click('.bf-tabs button:has-text("All workflows")');
  const brokenSwitch = h.editor.locator('input[aria-label="UX broken on"]');
  check('All workflows: the switch of a workflow with problems is disabled, with a tooltip',
    (await brokenSwitch.isDisabled()) && (await h.editor.locator('label.bf-switch:has(input[aria-label="UX broken on"])').getAttribute('title')) === 'Fix the problems first'
      && !(await h.editor.locator('input[aria-label="UX good on"]').isDisabled()));

  await h.editor.click('button:has-text("Turn all on")');
  const toast = h.editor.locator('.bf-toast.error');
  await toast.waitFor({ timeout: 5_000 });
  await h.editor.waitForTimeout(700);
  const afterAllOn = await workflows();
  check('"Turn all on" switches on what it can and names the rest in one toast',
    (await toast.count()) === 1 && (await toast.textContent()).includes('“UX broken”')
      && afterAllOn.find((w) => w.id === good.id)?.enabled === true && afterAllOn.find((w) => w.id === broken.id)?.enabled === false,
    await toast.textContent());
  await h.editor.click('button:has-text("Turn all off")');

  // Block state of the workflow about to be deleted, and of another one.
  await worker.evaluate((id) => chrome.storage.local.set({ [`bf:state:${id}::note::seen`]: 1, 'bf:state:keep-me::n::k': 2 }), good.id);
  const deleteGood = () => h.editor.click(`.bf-table tr:has(button:has-text("UX good")) button:has-text("Delete")`);
  await deleteGood();
  await h.editor.locator('.bf-modal').waitFor({ timeout: 5_000 });
  const question = await h.editor.locator('.bf-modal-message').textContent();
  await h.editor.click('.bf-modal button:has-text("Cancel")');
  await h.editor.waitForTimeout(700);
  check('delete asks in an in-editor dialog; Cancel keeps the workflow',
    question?.includes('Delete “UX good”?') && (await h.editor.locator('.bf-modal').count()) === 0 && (await workflows()).some((w) => w.id === good.id), question ?? '');
  await deleteGood();
  await h.editor.keyboard.press('Escape');
  await h.editor.waitForTimeout(300);
  const keptAfterEscape = (await h.editor.locator('.bf-modal').count()) === 0;
  await deleteGood();
  await h.editor.click('.bf-modal button:has-text("Delete")');
  let state;
  for (let i = 0; i < 20; i += 1) {
    await h.editor.waitForTimeout(250);
    state = await worker.evaluate(() => chrome.storage.local.get(null));
    if (!(state['bf:workflows'] ?? []).some((w) => w.name === 'UX good') && !Object.keys(state).some((key) => key.includes('::note::'))) break;
  }
  check('Escape cancels; Delete removes the workflow and its block state (not other workflows\' state)',
    keptAfterEscape && !(state['bf:workflows'] ?? []).some((w) => w.id === good.id) && state[`bf:state:${good.id}::note::seen`] === undefined && state['bf:state:keep-me::n::k'] === 2,
    Object.keys(state).filter((key) => key.startsWith('bf:state:')).join(', '));

  // Recorder start URL: validated in the dialog, Cancel starts nothing.
  await h.editor.click('.bf-tabs button:has-text("Canvas")');
  await h.editor.click('button:has-text("● Record")');
  await h.editor.fill('.bf-modal input', 'not a url');
  await h.editor.click('.bf-modal button:has-text("Start recording")');
  const urlProblem = await h.editor.locator('.bf-modal-error').textContent().catch(() => '');
  await h.editor.click('.bf-modal button:has-text("Cancel")');
  await h.editor.waitForTimeout(300);
  check('the recorder asks for its start URL in the editor and checks it', urlProblem.includes('http(s)') && (await stored('bf:recording')) === undefined, urlProblem);

  // --- real input only on page actions ----------------------------------------------------------
  await seedWorkflows([workflow('UX real input', [
    { id: 'c', type: 'click', config: { locator: '#a' } },
    { id: 'l', type: 'log', config: { message: 'x' } },
  ])]);
  watchNative(h.editor);
  const realInputs = () => h.editor.locator('.bf-step-settings label:has-text("Use real mouse and keyboard")').count();
  await h.editor.click('.bf-node:has-text("Click")');
  const onClick = await realInputs();
  await h.editor.click('.bf-node:has-text("Log")');
  const onLog = await realInputs();
  check('"Use real mouse and keyboard" is offered on Click, not on Log', onClick === 1 && onLog === 0, `${onClick} ${onLog}`);

  // --- undo per workflow, paste at the mouse -------------------------------------------------------
  const one = workflow('UX one', [{ id: 'a', type: 'log', config: { message: 'one' } }]);
  const two = workflow('UX two', [{ id: 'b', type: 'log', config: { message: 'two' } }]);
  await seedWorkflows([one, two]);
  watchNative(h.editor);
  const addLog = async () => {
    await h.editor.fill('input[aria-label="Find a block"]', 'log');
    await h.editor.click('.bf-palette button:has-text("Log")');
    await h.editor.fill('input[aria-label="Find a block"]', '');
    await h.editor.waitForTimeout(700);
  };
  const openWorkflow = async (name) => {
    await h.editor.click(`.bf-workflow-name:has-text("${name}")`);
    await h.editor.waitForTimeout(400);
  };
  await openWorkflow('UX one');
  await addLog();
  await openWorkflow('UX two');
  await addLog();
  await addLog();
  await openWorkflow('UX one');
  const oneBefore = await nodeCount();
  await h.editor.click('.react-flow__pane', { position: { x: 20, y: 20 } });
  await h.editor.keyboard.press('Control+z');
  await h.editor.waitForTimeout(300);
  const oneAfter = await nodeCount();
  await openWorkflow('UX two');
  await h.editor.click('.react-flow__pane', { position: { x: 20, y: 20 } });
  await h.editor.keyboard.press('Control+z');
  await h.editor.waitForTimeout(300);
  const twoAfter = await nodeCount();
  check('undo history survives switching workflows (one history per workflow)', oneBefore === 2 && oneAfter === 1 && twoAfter === 2, `${oneBefore} ${oneAfter} ${twoAfter}`);

  await h.editor.click('.bf-node >> nth=0');
  await h.editor.keyboard.press('Control+c');
  const pane = await h.editor.locator('.react-flow__pane').boundingBox();
  const mouse = { x: Math.round(pane.x + pane.width * 0.3), y: Math.round(pane.y + pane.height * 0.75) };
  await h.editor.mouse.move(mouse.x, mouse.y);
  await h.editor.keyboard.press('Control+v');
  await h.editor.waitForTimeout(300);
  const pasted = await h.editor.locator('.react-flow__node.selected').boundingBox();
  // Paste again without moving: offset from the first copy, not on top of it.
  await h.editor.keyboard.press('Control+v');
  await h.editor.waitForTimeout(300);
  const again = await h.editor.locator('.react-flow__node.selected').boundingBox();
  check('paste puts the block at the mouse; pasting again without moving offsets it',
    pasted && Math.abs(pasted.x - mouse.x) <= 4 && Math.abs(pasted.y - mouse.y) <= 4 && again && again.x > pasted.x + 10 && again.y > pasted.y + 10,
    JSON.stringify({ mouse, pasted, again }));

  // --- first-run "Try it" card and the playground -------------------------------------------------
  await worker.evaluate(() => chrome.storage.local.remove('bf:onboarding'));
  await h.editor.reload();
  const card = h.editor.locator('.bf-tryit');
  await card.waitFor({ timeout: 5_000 });
  await h.editor.locator('.bf-tryit-status.down').waitFor({ timeout: 5_000 });
  const playground = await startPlayground(PLAYGROUND_PORT);
  try {
    await h.editor.click('.bf-tryit button:has-text("Check again")');
    await h.editor.locator('.bf-tryit-status.up').waitFor({ timeout: 5_000 });
    check('the Try it card sees whether the playground is running', true);
    await h.editor.click('.bf-tryit button:has-text("Create the Try-it workflow")');
    await h.editor.waitForTimeout(800);
    const tour = (await workflows()).find((w) => w.name === 'Try it: playground tour');
    check('it creates the playground template and opens it', Boolean(tour) && (await h.editor.inputValue('.bf-name')) === 'Try it: playground tour' && (await nodeCount()) === tour.nodes.length);
    if (tour) {
      const record = await h.run(tour);
      check('the Try-it workflow passes against the playground', record.status === 'passed', summary(record));
      for (const page of h.context.pages()) if (page.url().includes(`localhost:${PLAYGROUND_PORT}`)) await page.close();
    }
  } finally {
    playground.close();
  }
  await h.editor.click('.bf-tryit-close');
  await h.editor.reload();
  await h.editor.waitForSelector('.bf-node', { timeout: 5_000 });
  check('a closed Try it card stays closed', (await card.count()) === 0 && (await stored('bf:onboarding'))?.tryItDismissed === true);
  // Leave it dismissed for whatever spec runs next.

  check('no native alert/confirm/prompt was shown', nativeDialogs === 0, String(nativeDialogs));
}
