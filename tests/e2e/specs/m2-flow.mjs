// e2e for M2 flow control: a Switch edited in the editor shows one output handle per case, keeps a
// connection through a case rename, drops it with the case, and routes a real run; Repeat until stops on
// its condition (and fails at `max`). Run alone with `npm run e2e -- m2-flow`.

/** @param {import('../harness.mjs').Harness} h */
export default async function m2Flow(h) {
  const { check, run, seedWorkflows, step, summary, worker, workflow } = h;
  console.log('M2 flow: Switch with dynamic ports in the editor, Repeat until');

  const stored = async (id) => ((await worker.evaluate(() => chrome.storage.local.get('bf:workflows')))['bf:workflows'] ?? []).find((w) => w.id === id);
  const settle = () => h.editor.waitForTimeout(700);

  // --- Switch ------------------------------------------------------------------------------------
  const sw = workflow(
    'M2 switch',
    [
      { id: 'set', type: 'set-variable', config: { name: 'status', value: '404' }, position: { x: 0, y: 0 } },
      {
        id: 'sw',
        type: 'switch',
        config: { value: '{{status}}', cases: [{ port: 'ok', operator: 'equals', value: '200' }, { port: 'missing', operator: 'equals', value: '404' }] },
        position: { x: 220, y: 0 },
      },
      { id: 'a', type: 'log', config: { message: 'went ok' }, position: { x: 480, y: -120 } },
      { id: 'b', type: 'log', config: { message: 'went missing' }, position: { x: 480, y: 60 } },
      { id: 'c', type: 'log', config: { message: 'went default' }, position: { x: 480, y: 240 } },
    ],
    [['set', 'sw'], ['sw', 'a', 'ok'], ['sw', 'c', 'default']],
  );
  await seedWorkflows([sw]);
  await h.editor.click('.bf-workflow-name:has-text("M2 switch")');
  await settle();
  // Everything on screen (the canvas is narrow next to the settings panel).
  await h.editor.click('.react-flow__controls-fitview');
  await settle();

  const switchNode = h.editor.locator('.react-flow__node:has(.bf-node-head:has-text("Switch"))');
  const handles = async () => switchNode.locator('.react-flow__handle.source').evaluateAll((list) => list.map((el) => el.getAttribute('data-handleid')));
  check('Switch shows one output handle per case, then default', JSON.stringify(await handles()) === JSON.stringify(['ok', 'missing', 'default']), JSON.stringify(await handles()));

  // Connect "missing" → the second Log by dragging from its handle.
  const from = await switchNode.locator('.react-flow__handle.source[data-handleid="missing"]').boundingBox();
  const to = await h.editor.locator('.react-flow__node:has-text("went missing") .react-flow__handle.target').boundingBox();
  await h.editor.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await h.editor.mouse.down();
  await h.editor.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await h.editor.mouse.up();
  await settle();
  let saved = await stored(sw.id);
  check('a connection dragged from a case handle is saved with that port', saved?.edges.some((e) => e.source === 'sw' && e.target === 'b' && e.sourcePort === 'missing'), JSON.stringify(saved?.edges));

  // Add a case in the config panel: a new handle appears.
  await switchNode.click();
  await h.editor.click('.bf-rows button:has-text("+ Add row")');
  await h.editor.fill('input[aria-label="Output 3"]', 'server');
  await h.editor.selectOption('select[aria-label="Condition 3"]', 'matches');
  await h.editor.fill('input[aria-label="Compare to 3"]', '/^5/');
  await settle();
  if (process.env.BF_DEBUG) await h.editor.screenshot({ path: `${process.env.BF_DEBUG}/m2-switch.png` });
  check('adding a case adds its handle before default', JSON.stringify(await handles()) === JSON.stringify(['ok', 'missing', 'server', 'default']), JSON.stringify(await handles()));

  // Rename "missing" by typing over it key by key: the connection follows.
  const name2 = h.editor.locator('input[aria-label="Output 2"]');
  await name2.click();
  await name2.press('End');
  for (let i = 0; i < 'missing'.length; i += 1) await name2.press('Backspace');
  await name2.pressSequentially('notfound', { delay: 20 });
  await settle();
  saved = await stored(sw.id);
  check(
    'renaming a case keeps its connection (now from the new name)',
    JSON.stringify(await handles()) === JSON.stringify(['ok', 'notfound', 'server', 'default']) && saved?.edges.some((e) => e.source === 'sw' && e.target === 'b' && e.sourcePort === 'notfound'),
    `${JSON.stringify(await handles())} ${JSON.stringify(saved?.edges)}`,
  );

  // Routes in a real run: status 404 → "notfound" → "went missing".
  let result = await run(saved);
  check(
    'the run goes out of the matching case only',
    result.status === 'passed' && step(result, 'sw')?.port === 'notfound' && step(result, 'b')?.status === 'passed' && step(result, 'b')?.input?.status === '404' && !step(result, 'a') && !step(result, 'c'),
    summary(result),
  );
  result = await run({ ...saved, nodes: saved.nodes.map((n) => (n.id === 'set' ? { ...n, config: { ...n.config, value: '302' } } : n)) });
  check('no match goes out of default', result.status === 'passed' && step(result, 'sw')?.port === 'default' && step(result, 'c')?.status === 'passed', summary(result));

  // Removing the case removes its handle and its connection.
  await h.editor.locator('.bf-rows tr:has(input[aria-label="Output 2"]) button[title="Remove row"]').click();
  await settle();
  saved = await stored(sw.id);
  check(
    'removing a case removes its handle and its connection',
    JSON.stringify(await handles()) === JSON.stringify(['ok', 'server', 'default']) && !saved?.edges.some((e) => e.target === 'b'),
    `${JSON.stringify(await handles())} ${JSON.stringify(saved?.edges)}`,
  );

  // --- Repeat until ------------------------------------------------------------------------------
  const until = workflow(
    'M2 repeat until',
    [
      { id: 'r', type: 'repeat', config: { mode: 'until', left: '{{n}}', operator: 'greater-equal', right: '30', max: 10 } },
      { id: 'n', type: 'set-variable', config: { name: 'n', value: '{{iteration * 10}}' } },
      { id: 'end', type: 'log', config: { message: 'done after {{iterations}}' } },
    ],
    [['r', 'n', 'each'], ['r', 'end', 'done']],
  );
  result = await run(until);
  const rounds = result.steps.filter((s) => s.nodeId === 'n').length;
  check(
    'Repeat until stops once the condition holds on what the round produced',
    result.status === 'passed' && rounds === 3 && step(result, 'end')?.output?.iterations === 3 && String(step(result, 'end')?.output?.n) === '30',
    `${rounds} rounds · ${summary(result)}`,
  );
  result = await run({ ...until, id: 'e2e-until-max', nodes: until.nodes.map((n) => (n.id === 'r' ? { ...n, config: { ...n.config, right: '999', max: 2 } } : n)) });
  check(
    'Repeat until fails at max',
    result.status === 'failed' && result.steps.filter((s) => s.nodeId === 'n').length === 2 && /after 2 times/.test(step(result, 'r')?.error ?? ''),
    summary(result),
  );
}
