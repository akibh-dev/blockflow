// e2e scenarios: real input inside frames, picking and recording inside frames and shadow roots,
// recording that follows a popup, recording into an existing workflow.
// Run alone with `npm run e2e -- frames-recording`. `h` is the shared harness (tests/e2e/harness.mjs).

/** @param {import('../harness.mjs').Harness} h */
export default async function (h) {
  const { base, check, context, run, seedWorkflows, server, step, summary, worker, workflow } = h;
  const port = server.address().port;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const saved = async (name) => (await worker.evaluate(() => chrome.storage.local.get('bf:workflows')))['bf:workflows'].find((w) => w.name === name);

  console.log('Frames and recording: real input in frames, picker/recorder in frames, shadow DOM, popups');

  // --- Real input in frames (M0.2a) -----------------------------------------------------------
  {
    const real = await run(workflow('real input in frames', [
      { id: 'open', type: 'open-url', config: { url: `${base}/trusted-frames.html`, active: false } },
      { id: 'c1', type: 'click', config: { locator: 'frame=#same >> #press' }, step: { realInput: true } },
      { id: 'r1', type: 'read-element', config: { selector: 'frame=#same >> #result', url: '' } },
      { id: 'c2', type: 'click', config: { locator: 'frame=#other >> #press' }, step: { realInput: true } },
      { id: 'r2', type: 'read-element', config: { selector: 'frame=#other >> #result', url: '' } },
      { id: 't2', type: 'fill', config: { locator: 'frame=#other >> label=Name', value: 'Akib' }, step: { realInput: true } },
      { id: 'r3', type: 'read-element', config: { selector: 'frame=#other >> label=Name', url: '', read: 'attribute', name: 'data-trusted' } },
      { id: 'v', type: 'assert', config: { subject: 'input', locator: 'frame=#other >> label=Name', operator: 'equals', expected: 'Akib' } },
      { id: 'close', type: 'close-tab' },
    ]));
    check('real-input click lands inside a same-origin frame (trusted)', step(real, 'r1')?.output?.value === 'trusted', summary(real));
    check('real-input click lands inside a cross-origin frame (trusted)', step(real, 'r2')?.output?.value === 'trusted', summary(real));
    check('real typing inside a cross-origin frame', step(real, 'r3')?.output?.value === 'yes' && step(real, 'v')?.status === 'passed', summary(real));
  }

  // --- Picking inside frames and shadow roots (M0.2b, M0.2c, picker tab reuse, hints) ------------
  {
    await seedWorkflows([
      workflow('pick in frames', [
        { id: 'open', type: 'open-url', config: { url: `${base}/frames.html` } },
        { id: 'c', type: 'click', config: { locator: '' } },
        { id: 'r', type: 'read-element', config: { selector: '', url: `${base}/shadow.html` } },
      ]),
    ]);
    // An upstream URL prefers a tab already open on that site: leave only the editor open, so the
    // picker opens (and then keeps) its own tab.
    for (const page of context.pages()) if (page !== h.editor) await page.close();
    const pagesBefore = context.pages().length;
    /** Presses "Pick on page" on the selected block and returns the tab the picker shows up in. */
    const startPick = async (urlPart) => {
      await h.editor.click('.bf-field:has-text("Element") button:has-text("Pick on page")');
      for (let i = 0; i < 60; i += 1) {
        const target = context.pages().find((page) => page.url().includes(urlPart));
        if (target && (await target.locator('#blockflow-picker-host .bar').count()) > 0) return target;
        await wait(200);
      }
      throw new Error(`The picker did not appear on ${urlPart}`);
    };
    const pickedValue = async () => {
      await h.editor.waitForSelector('.bf-pick.done', { timeout: 10_000 });
      return h.editor.inputValue('.bf-field:has-text("Element") input');
    };

    // Click has no URL of its own: the picker opens the Open Tab's page before it.
    await h.editor.click('.bf-node:has-text("Click")');
    const target = await startPick('/frames.html');
    const hint = await target.locator('#blockflow-picker-host .hint').textContent();
    check('picker hint fits an action block', hint === 'Click the element this step should use. Esc to cancel.', hint);
    await wait(500); // the frames' pickers
    await target.frameLocator('#other').locator('#pay').click();
    await wait(300);
    const shown = await target.locator('#blockflow-picker-host .sel').textContent();
    await target.keyboard.press('Enter');
    const crossPick = await pickedValue();
    check('the top toolbar shows a pick made in a frame', String(shown).startsWith('(in a frame)'), shown);
    check('pick inside a cross-origin frame gives frame=… >> locator', crossPick === 'frame=#other >> role=button[name="Pay"]', crossPick);

    await h.editor.click('.bf-node:has-text("Open Tab")');
    await h.editor.click('.bf-node:has-text("Click")');
    const again = await startPick('/frames.html');
    await wait(500);
    await again.frameLocator('#same').locator('#card').click();
    await again.keyboard.press('Enter');
    const samePick = await pickedValue();
    check('pick inside a same-origin frame', samePick === 'frame=#same >> label="Card number"', samePick);
    check('the picker reuses its tab', again === target && context.pages().length === pagesBefore + 1, `${context.pages().length} pages, ${pagesBefore} before`);

    // Read Element has its own URL: the picker tab goes there. The element is in a shadow root.
    await h.editor.click('.bf-node:has-text("Read Element")');
    const shadowTab = await startPick('/shadow.html');
    const watchHint = await shadowTab.locator('#blockflow-picker-host .hint').textContent();
    check('picker hint fits a watch/read block', watchHint === 'Click the part of the page to watch. Esc to cancel.', watchHint);
    await shadowTab.locator('#join').click();
    await shadowTab.keyboard.press('Enter');
    const shadowPick = await pickedValue();
    const alternatives = await h.editor.locator('.bf-candidates button').allTextContents();
    check('pick inside a shadow root gives a >>> selector and readable alternatives', shadowPick === 'sign-up >>> #join' && alternatives.includes('role=button[name="Join"]'), `${shadowPick} | ${alternatives.join(' | ')}`);
    check('the same picker tab moved to the block URL', shadowTab === target, shadowTab.url());
    await target.close();
  }

  // --- Recording inside frames, into an existing workflow (M0.2c, M0.2e) -------------------------
  {
    await seedWorkflows([
      workflow('rec frames', [
        { id: 'open', type: 'open-url', config: { url: `${base}/frames.html` } },
        { id: 'note', type: 'log', config: { message: 'ready' } },
      ]),
    ]);
    h.editor.once('dialog', (dialog) => dialog.accept(`${base}/frames.html`));
    const [recTab] = await Promise.all([context.waitForEvent('page'), h.editor.click('button:has-text("● Record")')]);
    await recTab.waitForLoadState('load');
    await recTab.waitForSelector('blockflow-recorder', { state: 'attached', timeout: 10_000 });
    await wait(800); // the frames' recorders work out where they are
    const same = recTab.frameLocator('#same');
    const other = recTab.frameLocator('#other');
    await same.locator('#card').pressSequentially('1111');
    await same.locator('#pay').click();
    await other.locator('#card').pressSequentially('4242');
    await other.locator('#pay').click();
    await recTab.locator('blockflow-recorder >> button[data-act="assert-text"]').click();
    await wait(400); // the mode reaches the frames
    await other.locator('#paid').click();
    await wait(500);
    await recTab.locator('blockflow-recorder >> button[data-act="stop"]').click();
    await h.editor.bringToFront();
    await h.editor.waitForFunction(() => document.querySelectorAll('.bf-node').length > 2, null, { timeout: 10_000 });
    await h.editor.waitForTimeout(800);
    await recTab.close();

    const recorded = await saved('rec frames');
    const added = recorded.nodes.filter((node) => node.id !== 'open' && node.id !== 'note');
    const locators = added.map((node) => `${node.type}:${node.config.locator ?? ''}`);
    check(
      'recording inside frames gives frame=… >> locators',
      JSON.stringify(locators) ===
        JSON.stringify([
          'fill:frame=#same >> label="Card number"',
          'click:frame=#same >> role=button[name="Pay"]',
          'fill:frame=#other >> label="Card number"',
          'click:frame=#other >> role=button[name="Pay"]',
          `assert:frame=#other >> text="Paid 4242 from localhost:${port}"`,
        ]),
      JSON.stringify(locators),
    );
    const first = added[0];
    check(
      'recording into a workflow: no second Open Tab, connected after the last block, placed to its right',
      recorded.nodes.filter((node) => node.type === 'open-url').length === 1 &&
        recorded.edges.some((edge) => edge.source === 'note' && edge.target === first?.id) &&
        first?.position.x > recorded.nodes.find((node) => node.id === 'note').position.x,
      JSON.stringify({ edges: recorded.edges.map((edge) => `${edge.source}->${edge.target}`), first: first?.position }),
    );
    const replay = await run(recorded);
    check('the recorded frame workflow replays and passes', replay.status === 'passed', summary(replay));
  }

  // --- Recording that opens a popup (M0.2d) ----------------------------------------------------
  {
    await seedWorkflows([workflow('rec popup', [])]);
    h.editor.once('dialog', (dialog) => dialog.accept(`${base}/popup.html`));
    const [recTab] = await Promise.all([context.waitForEvent('page'), h.editor.click('button:has-text("● Record")')]);
    await recTab.waitForLoadState('load');
    await recTab.waitForSelector('blockflow-recorder', { state: 'attached', timeout: 10_000 });
    const [popup] = await Promise.all([context.waitForEvent('page'), recTab.locator('text=Feed in a new tab').click()]);
    await popup.waitForLoadState('load');
    await popup.waitForSelector('blockflow-recorder', { state: 'attached', timeout: 10_000 });
    await popup.locator('blockflow-recorder >> button[data-act="assert-text"]').click();
    await popup.locator('h1').click();
    await wait(500);
    await popup.locator('blockflow-recorder >> button[data-act="stop"]').click();
    await h.editor.bringToFront();
    await h.editor.waitForFunction(() => document.querySelectorAll('.bf-node').length > 1, null, { timeout: 10_000 });
    await h.editor.waitForTimeout(800);
    await popup.close();
    await recTab.close();

    const recorded = await saved('rec popup');
    const shape = recorded.nodes.map((node) => `${node.type}@${node.config.tab ?? ''}`);
    check(
      'recording follows the popup: Wait for Popup, then steps on tab "popup"',
      JSON.stringify(shape) === JSON.stringify(['open-url@main', 'click@main', 'wait-for-popup@main', 'assert@popup']),
      JSON.stringify(shape),
    );
    const replay = await run({ ...recorded, nodes: [...recorded.nodes, { id: 'end', type: 'close-tab', position: { x: 0, y: 400 }, config: { tab: 'popup' } }], edges: [...recorded.edges, { id: 'e-end', source: recorded.nodes.at(-1).id, target: 'end' }] });
    check('the recorded popup workflow replays and passes', replay.status === 'passed', summary(replay));
  }
}
