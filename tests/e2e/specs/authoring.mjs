// e2e scenarios: Recorder, picker, Page Visited, editing tools, templates, autocomplete.
// Run alone with `npm run e2e -- authoring`. `h` is the shared harness (tests/e2e/harness.mjs).

/** @param {import('../harness.mjs').Harness} h */
export default async function (h) {
  const { base, check, context, executablePath, here, openEditor, PASSWORD, path, run, seedWorkflows, server, step, summary, worker, workflow } = h;
  {
    console.log('Phase E: recorder, picker, Page Visited, editing tools, templates, autocomplete');
    await seedWorkflows([workflow('recorded', [{ id: 'note', type: 'log', config: { message: 'start' } }])]);
    await worker.evaluate((password) => chrome.storage.local.set({ 'bf:secrets': { password } }), PASSWORD);
    h.editor.once('dialog', (dialog) => dialog.accept(`${base}/login.html`));
    const [recordTab] = await Promise.all([context.waitForEvent('page'), h.editor.click('button:has-text("● Record")')]);
    await recordTab.waitForLoadState('load');
    await recordTab.waitForSelector('blockflow-recorder', { state: 'attached', timeout: 10_000 });
    await recordTab.locator('#email').pressSequentially('rec@test.dev');
    await recordTab.locator('#password').pressSequentially(PASSWORD);
    await recordTab.locator('#country').selectOption('bd');
    await recordTab.locator('text=Remember me').click();
    await Promise.all([recordTab.waitForURL(/welcome/), recordTab.locator('button:has-text("Sign in")').click()]);
    await recordTab.waitForSelector('blockflow-recorder', { state: 'attached', timeout: 10_000 });
    await recordTab.locator('blockflow-recorder >> button[data-act="assert-text"]').click();
    await recordTab.locator('#greeting').click();
    await recordTab.waitForTimeout(300);
    h.editor.once('dialog', (dialog) => dialog.accept());
    await recordTab.locator('blockflow-recorder >> button[data-act="stop"]').click();
    await h.editor.bringToFront();
    await h.editor.waitForFunction(() => document.querySelectorAll('.bf-node').length > 1, null, { timeout: 10_000 });
    await h.editor.waitForTimeout(800);
    const recorded = (await worker.evaluate(() => chrome.storage.local.get('bf:workflows')))['bf:workflows'].find((w) => w.name === 'recorded');
    const types = recorded.nodes.filter((node) => node.type !== 'log').map((node) => node.type);
    check('recording became Open Tab → Fill Form → Wait For → Assert', JSON.stringify(types) === JSON.stringify(['open-url', 'fill-form', 'wait-for', 'assert']), JSON.stringify(types));
    const form = recorded.nodes.find((node) => node.type === 'fill-form');
    check('readable locators, password as {{secret.password}}, submit captured', JSON.stringify(form?.config.fields) === JSON.stringify([
      { locator: 'label="Email"', value: 'rec@test.dev' },
      { locator: 'label="Password"', value: '{{secret.password}}' },
      { locator: 'label="Country"', value: 'Bangladesh' },
      { locator: 'label="Remember me"', value: 'true' },
    ]) && form?.config.submit === 'role=button[name="Sign in"]', JSON.stringify(form?.config));
    await recordTab.close();
    const replay = await run({ ...recorded, nodes: recorded.nodes.filter((node) => node.type !== 'log'), edges: recorded.edges.filter((edge) => !recorded.nodes.find((n) => n.type === 'log' && (n.id === edge.source || n.id === edge.target))) });
    check('the recorded workflow replays and passes', replay.status === 'passed', summary(replay));

    // Picking an element for a Click gives a readable locator, with alternatives.
    const target = await context.newPage();
    await target.goto(`${base}/login.html`);
    await seedWorkflows([workflow('pick', [{ id: 'c', type: 'click', config: { locator: '' } }])]);
    await h.editor.click('.bf-node:has-text("Click")');
    await h.editor.click('.bf-field:has-text("Element") button:has-text("Pick on page")');
    await target.waitForTimeout(800);
    await target.click('button:has-text("Forgot password?")');
    await target.keyboard.press('Enter');
    await h.editor.waitForSelector('.bf-candidates', { timeout: 10_000 });
    const picked = await h.editor.inputValue('.bf-field:has-text("Element") input');
    const alternatives = await h.editor.locator('.bf-candidates button').allTextContents();
    check('pick gives a readable locator and alternatives', picked === 'role=button[name="Forgot password?"]' && alternatives.length >= 2, `${picked} | ${alternatives.join(' | ')}`);
    await target.close();

    // Undo / redo / copy / paste.
    const count = () => h.editor.locator('.bf-node').count();
    await h.editor.click('.react-flow__pane');
    await h.editor.fill('input[aria-label="Find a block"]', 'log');
    await h.editor.click('.bf-palette button:has-text("Log")');
    await h.editor.fill('input[aria-label="Find a block"]', '');
    await h.editor.waitForTimeout(700);
    const afterAdd = await count();
    await h.editor.click('.react-flow__pane');
    await h.editor.keyboard.press('Control+z');
    await h.editor.waitForTimeout(300);
    const afterUndo = await count();
    await h.editor.keyboard.press('Control+Shift+z');
    await h.editor.waitForTimeout(300);
    const afterRedo = await count();
    await h.editor.click('.bf-node:has-text("Click")');
    await h.editor.keyboard.press('Control+c');
    await h.editor.keyboard.press('Control+v');
    await h.editor.waitForTimeout(300);
    const afterPaste = await count();
    check('undo, redo, copy + paste', afterUndo === afterAdd - 1 && afterRedo === afterAdd && afterPaste === afterAdd + 1, `${afterAdd} ${afterUndo} ${afterRedo} ${afterPaste}`);

    // Templates.
    await h.editor.click('.bf-sidebar button:has-text("+ New")');
    await h.editor.click('.bf-menu-list button:has-text("Scrape all pages to CSV")');
    await h.editor.waitForTimeout(600);
    check('a template becomes a workflow', (await h.editor.inputValue('.bf-name')) === 'Scrape all pages to CSV' && (await count()) === 6, String(await count()));

    // {{ autocomplete in a Download block after Extract List.
    await h.editor.click('.bf-node:has-text("Download")');
    const nameField = h.editor.locator('.bf-field:has-text("File name") input');
    await nameField.fill('');
    await nameField.pressSequentially('x-{{');
    const offered = await h.editor.locator('.bf-suggest button').allTextContents();
    check('{{ offers the data names of earlier blocks', offered.includes('{{pages}}') || offered.includes('{{count}}'), offered.join(' '));
    await h.editor.keyboard.press('Escape');

    // Page Visited: an enabled workflow starts when a matching page opens in any tab.
    const visited = workflow('on visit', [
      { id: 'p', type: 'page-visited', config: { url: '/table.html', when: 'load' } },
      { id: 'r', type: 'read-element', config: { selector: 'h1', url: '' } },
    ]);
    visited.enabled = true;
    await seedWorkflows([visited]);
    await h.editor.waitForTimeout(800);
    const visit = await context.newPage();
    await visit.goto(`${base}/table.html`);
    let eventRun;
    for (let i = 0; i < 40 && !eventRun; i += 1) {
      await h.editor.waitForTimeout(250);
      eventRun = ((await worker.evaluate(() => chrome.storage.local.get('bf:runs')))['bf:runs'] ?? []).find((r) => r.workflowId === visited.id && r.trigger === 'event' && r.status !== 'running');
    }
    check('Page Visited started a run on the visited tab', eventRun?.status === 'passed' && step(eventRun, 'r')?.output?.value === 'Prices', JSON.stringify(eventRun && summary(eventRun)));
    await visit.close();
    await seedWorkflows([{ ...visited, enabled: false }]);
  }
}
