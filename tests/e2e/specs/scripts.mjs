// e2e scenarios: importing a script file (src/core/script.ts) in the editor: it is compiled, laid out
// (src/core/layout.ts) and runs; Tidy up and Export as script are offered.
// Run alone with `npm run e2e -- scripts`. `h` is the shared harness (tests/e2e/harness.mjs).

/** @param {import('../harness.mjs').Harness} h */
export default async function (h) {
  const { base, check, run, seedWorkflows, step, summary, worker, workflow } = h;
  console.log('M1.2: script import, auto-layout, Tidy up, Export as script');
  await seedWorkflows([workflow('placeholder', [{ id: 'note', type: 'log', config: { message: 'x' } }])]);

  const script = {
    format: 'blockflow-script',
    version: 1,
    name: 'Script import',
    steps: [
      { id: 'open', open: { url: `${base}/table.html`, where: 'window' } },
      { id: 'title', assert: { locator: 'h1', expected: 'Prices' } },
      { id: 'heading', 'read-element': { tab: 'main', locator: 'h1' } },
      { id: 'big', if: { left: '{{value}}', operator: 'equals', right: 'Prices' }, true: [{ id: 'yes', log: 'it says {{value}}' }] },
      { id: 'close', 'close-tab': {} },
    ],
  };
  await h.editor.setInputFiles('input[type=file]', { name: 'import.script.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(script)) });
  await h.editor.waitForTimeout(1000);
  const stored = (await worker.evaluate(() => chrome.storage.local.get('bf:workflows')))['bf:workflows'] ?? [];
  const imported = stored.find((candidate) => candidate.name === 'Script import');
  const at = (origin) => imported?.nodes.find((node) => node.origin === origin)?.position;
  check(
    'a script imports as blocks, laid out left to right (If: true above the rejoin)',
    imported?.nodes.length === 6 && at('open')?.x === 0 && at('title')?.x === 260 && at('yes')?.y === 0 && at('close')?.x === 1300 && imported.enabled === false,
    JSON.stringify(imported?.nodes.map((node) => [node.origin, node.position])),
  );
  check('its connections follow the script (If false → next step)', imported?.edges.length === 6, JSON.stringify(imported?.edges));

  const result = await run(imported);
  const yes = imported.nodes.find((node) => node.origin === 'yes');
  check('the imported script runs and passes', result.status === 'passed' && step(result, yes.id)?.status === 'passed', summary(result));

  // The canvas: Export as script is enabled for this tree; Tidy up is one undoable change.
  await h.editor.click('.bf-sidebar >> text=Script import');
  await h.editor.waitForTimeout(400);
  check('Export as script is enabled', await h.editor.isEnabled('button:has-text("Export as script")'));
  const nodeBox = async () => h.editor.locator('.react-flow__node').first().boundingBox();
  const start = await nodeBox();
  await h.editor.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await h.editor.mouse.down();
  await h.editor.mouse.move(start.x + start.width / 2 + 30, start.y + start.height / 2 + 160, { steps: 10 });
  await h.editor.mouse.up();
  await h.editor.waitForTimeout(700);
  const moved = await nodeBox();
  const dragged = (await worker.evaluate(() => chrome.storage.local.get('bf:workflows')))['bf:workflows'].find((candidate) => candidate.id === imported.id);
  check('(a block was dragged off the grid)', JSON.stringify(dragged?.nodes.map((node) => node.position)) !== JSON.stringify(imported.nodes.map((node) => node.position)));
  await h.editor.click('button:has-text("Tidy up")');
  await h.editor.waitForTimeout(700);
  const after = (await worker.evaluate(() => chrome.storage.local.get('bf:workflows')))['bf:workflows'].find((candidate) => candidate.id === imported.id);
  check(
    'Tidy up puts the blocks back on the grid',
    JSON.stringify(after?.nodes.map((node) => node.position)) === JSON.stringify(imported.nodes.map((node) => node.position)),
    `${JSON.stringify(moved)} ${JSON.stringify(after?.nodes.map((node) => node.position))}`,
  );
  await h.editor.click('.react-flow__pane');
  await h.editor.keyboard.press('Control+z');
  await h.editor.waitForTimeout(700);
  const undone = (await worker.evaluate(() => chrome.storage.local.get('bf:workflows')))['bf:workflows'].find((candidate) => candidate.id === imported.id);
  check('Undo reverts Tidy up', JSON.stringify(undone?.nodes.map((node) => node.position)) === JSON.stringify(dragged?.nodes.map((node) => node.position)));
}
