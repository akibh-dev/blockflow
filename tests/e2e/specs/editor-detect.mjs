// e2e scenarios: Editor: Detect fields on a real form.
// Run alone with `npm run e2e -- editor-detect`. `h` is the shared harness (tests/e2e/harness.mjs).

/** @param {import('../harness.mjs').Harness} h */
export default async function (h) {
  const { base, check, context, executablePath, here, openEditor, PASSWORD, path, run, seedWorkflows, server, step, summary, worker, workflow } = h;
  {
    console.log('Editor: Detect fields on a real form');
    const target = await context.newPage();
    await target.goto(`${base}/login.html`);
    // The editor saves what it has when it closes, so close it before replacing the workflows.
    await h.editor.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const wf = workflow('detect', [{ id: 'ff', type: 'fill-form', config: { fields: [] } }]);
    await worker.evaluate((w) => chrome.storage.local.set({ 'bf:workflows': [w] }), wf);
    h.editor = await openEditor();
    await h.editor.click('.bf-node:has-text("Fill Form")');
    await h.editor.click('button:has-text("Detect fields")');
    await target.waitForTimeout(800);
    await target.click('#email');
    await target.keyboard.press('Enter');
    await h.editor.waitForSelector('.bf-pick.done', { timeout: 10_000 });
    const locators = await h.editor.$$eval('.bf-rows tbody tr td:first-child input', (inputs) => inputs.map((input) => input.value));
    check('rows created from the form', JSON.stringify(locators) === JSON.stringify(['label="Email"', 'label="Password"', 'label="Country"', 'label="Remember me"']), JSON.stringify(locators));
    const hint = await h.editor.getAttribute('.bf-rows tbody tr:nth-child(3) td:nth-child(2) input', 'placeholder');
    check('select rows hint their options', String(hint).includes('Bangladesh'), hint);
    await target.close();
  }
}
