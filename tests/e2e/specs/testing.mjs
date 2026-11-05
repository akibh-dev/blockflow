// e2e scenarios: Assert, screenshots, secrets, Run Workflow, Manual Step, reports.
// Run alone with `npm run e2e -- testing`. `h` is the shared harness (tests/e2e/harness.mjs).

/** @param {import('../harness.mjs').Harness} h */
export default async function (h) {
  const { base, check, context, executablePath, here, openEditor, PASSWORD, path, run, seedWorkflows, server, step, summary, worker, workflow } = h;
  {
    console.log('Phase C: Assert, screenshots, secrets, Run Workflow, Manual Step, reports');
    await worker.evaluate((password) => chrome.storage.local.set({ 'bf:secrets': { loginPassword: password } }), PASSWORD);
    const login = workflow('Log in (reusable)', [
      { id: 'form', type: 'fill-form', config: { fields: [{ locator: 'label=Email', value: '{{email}}' }, { locator: 'label=Password', value: '{{secret.loginPassword}}' }], submit: 'role=button[name="Sign in"]' } },
      { id: 'wait', type: 'wait-for', config: { mode: 'url', url: '/welcome' } },
    ]);
    const test = workflow('Login test', [
      { id: 'open', type: 'open-url', config: { url: `${base}/login.html`, active: true } },
      { id: 'who', type: 'set-variable', config: { name: 'email', value: 'tester@test.dev' } },
      { id: 'call', type: 'run-workflow', config: { workflow: login.id } },
      { id: 'greets', type: 'assert', config: { subject: 'text', locator: '#greeting', operator: 'equals', expected: 'Welcome, tester!' } },
      { id: 'title', type: 'assert', config: { subject: 'title', operator: 'contains', expected: 'welcome' } },
      { id: 'soft', type: 'assert', config: { subject: 'text', locator: '#greeting', operator: 'contains', expected: 'Goodbye', soft: true }, step: { timeoutSeconds: 3 } },
      { id: 'after', type: 'log', config: { message: 'kept going' } },
    ]);
    await seedWorkflows([login, test]);
    const record = await run(test);
    const all = (await worker.evaluate(() => chrome.storage.local.get('bf:runs')))['bf:runs'];
    const child = all.find((candidate) => candidate.parentRunId === record.id);
    check('called workflow ran in the same tab and passed', child?.status === 'passed' && step(record, 'call')?.status === 'passed', summary(record));
    check('asserts on the page passed', step(record, 'greets')?.status === 'passed' && step(record, 'title')?.status === 'passed');
    check('soft assert failed the run but the flow went on', record.status === 'failed' && step(record, 'soft')?.status === 'failed' && step(record, 'after')?.status === 'passed', summary(record));
    check('failed assert has a screenshot', Boolean(step(record, 'soft')?.screenshot), JSON.stringify(step(record, 'soft')));
    check('the password never shows up in run records', !JSON.stringify([record, child]).includes(PASSWORD));

    const manual = workflow('manual', [
      { id: 'm', type: 'manual-step', config: { message: 'Check the page, then continue' } },
      { id: 'l', type: 'log', config: { message: 'continued' } },
    ]);
    const pending = run(manual);
    await h.editor.waitForSelector('.bf-prompt', { timeout: 10_000 });
    await h.editor.click('.bf-prompt button:has-text("Continue")');
    const manualRecord = await pending;
    check('Manual Step waited for Continue in the editor', manualRecord.status === 'passed' && step(manualRecord, 'l')?.status === 'passed', summary(manualRecord));

    await h.editor.click('.bf-header .bf-tabs button:has-text("Reports")');
    await h.editor.click(`.bf-report-list button:has-text("Login test")`);
    await h.editor.waitForSelector('.bf-report-detail .bf-shot img', { timeout: 10_000 });
    check('report shows the step screenshot', true);
    const [junit] = await Promise.all([h.editor.waitForEvent('download'), h.editor.click('button:has-text("Export JUnit XML")')]);
    const xml = await (await import('node:fs/promises')).readFile(await junit.path(), 'utf8');
    check('JUnit export lists the failed soft assert', xml.includes('<testsuite name="Login test"') && xml.includes('<failure'), xml.slice(0, 200));
    const [htmlReport] = await Promise.all([h.editor.waitForEvent('download'), h.editor.click('button:has-text("Export HTML")')]);
    const page = await (await import('node:fs/promises')).readFile(await htmlReport.path(), 'utf8');
    check('HTML report embeds the screenshot', page.includes('<img src="data:image/jpeg;base64,'));
  }
}
