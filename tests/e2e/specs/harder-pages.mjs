// e2e scenarios: Upload, popups, dialogs, frames, API responses, real input, Run Script, Playwright export.
// Run alone with `npm run e2e -- harder-pages`. `h` is the shared harness (tests/e2e/harness.mjs).

/** @param {import('../harness.mjs').Harness} h */
export default async function (h) {
  const { base, check, context, executablePath, here, openEditor, PASSWORD, path, run, seedWorkflows, server, step, summary, worker, workflow } = h;
  {
    console.log('Phase F: upload, popups, dialogs, frames, API responses, real input, Run Script, Playwright export');
    const upload = await run(workflow('upload', [
      { id: 'open', type: 'open-url', config: { url: `${base}/upload.html`, active: false } },
      { id: 'up', type: 'upload-file', config: { locator: 'label=Upload CV', content: 'name,city\nAkib,Dhaka', filename: 'cv.csv', mime: 'text/csv' } },
      { id: 'read', type: 'read-element', config: { selector: '#out', url: '' } },
      { id: 'close', type: 'close-tab' },
    ]));
    check('Upload File set a file on a hidden input', step(upload, 'read')?.output?.value === 'cv.csv|text/csv|name,city Akib,Dhaka', JSON.stringify(step(upload, 'read')?.output?.value ?? summary(upload)));

    const popup = await run(workflow('popup', [
      { id: 'open', type: 'open-url', config: { url: `${base}/popup.html`, active: false } },
      { id: 'click', type: 'click', config: { locator: 'role=button[name="Open help"]' } },
      { id: 'catch', type: 'wait-for-popup', config: { name: 'help' } },
      { id: 'read', type: 'read-element', config: { selector: 'h1', url: '', tab: 'help' } },
      { id: 'link', type: 'click', config: { locator: 'text=Feed in a new tab' } },
      { id: 'catch2', type: 'wait-for-popup', config: { name: 'feed' } },
      { id: 'close1', type: 'close-tab', config: { tab: 'help' } },
      { id: 'close2', type: 'close-tab', config: { tab: 'feed' } },
      { id: 'close3', type: 'close-tab' },
    ]));
    check('Wait for Popup caught window.open and target=_blank', popup.status === 'passed' && step(popup, 'read')?.output?.value === 'Prices' && String(step(popup, 'catch2')?.output?.popupUrl).endsWith('/feed.html'), summary(popup));

    const dialogs = await run(workflow('dialogs', [
      { id: 'open', type: 'open-url', config: { url: `${base}/dialogs.html`, active: false } },
      { id: 'no', type: 'dialogs', config: { action: 'dismiss' } },
      { id: 'del', type: 'click', config: { locator: '#del' } },
      { id: 'kept', type: 'assert', config: { subject: 'text', locator: '#result', operator: 'equals', expected: 'kept' } },
      { id: 'yes', type: 'dialogs', config: { action: 'accept', text: 'Akib' } },
      { id: 'ask', type: 'click', config: { locator: '#ask' } },
      { id: 'hi', type: 'assert', config: { subject: 'text', locator: '#result', operator: 'equals', expected: 'Hi Akib' } },
      { id: 'read', type: 'dialogs', config: { action: 'read' } },
      { id: 'close', type: 'close-tab' },
    ]));
    check('Dialogs: confirm dismissed, prompt answered, messages read', dialogs.status === 'passed' && step(dialogs, 'read')?.output?.lastDialog === 'Your name?', summary(dialogs));

    const frames = await run(workflow('frames', [
      { id: 'open', type: 'open-url', config: { url: `${base}/frames.html`, active: false } },
      { id: 'f1', type: 'fill', config: { locator: 'frame=#same >> label=Card number', value: '1111' } },
      { id: 'p1', type: 'click', config: { locator: 'frame=#same >> role=button[name="Pay"]' } },
      { id: 'r1', type: 'read-element', config: { selector: 'frame=#same >> #paid', url: '' } },
      { id: 'f2', type: 'fill', config: { locator: 'frame=#other >> label=Card number', value: '4242' } },
      { id: 'p2', type: 'click', config: { locator: 'frame=#other >> role=button[name="Pay"]' } },
      { id: 'r2', type: 'read-element', config: { selector: 'frame=#other >> #paid', url: '' } },
      { id: 'close', type: 'close-tab' },
    ]));
    const port = server.address().port;
    check('same-origin iframe', step(frames, 'r1')?.output?.value === `Paid 1111 from 127.0.0.1:${port}`, String(step(frames, 'r1')?.output?.value ?? summary(frames)));
    check('cross-origin iframe (through its frame id)', step(frames, 'r2')?.output?.value === `Paid 4242 from localhost:${port}`, String(step(frames, 'r2')?.output?.value ?? summary(frames)));

    const api = await run(workflow('api', [
      { id: 'open', type: 'open-url', config: { url: `${base}/api.html`, active: false } },
      { id: 'save', type: 'click', config: { locator: 'role=button[name="Save"]' } },
      { id: 'wait', type: 'wait-for', config: { mode: 'response', url: '/api/save', status: '2xx' } },
      { id: 'close', type: 'close-tab' },
    ]));
    check('Wait For response saw POST /api/save → 201', step(api, 'wait')?.output?.response?.status === 201 && step(api, 'wait')?.output?.response?.method === 'POST', summary(api));

    const trusted = await run(workflow('trusted', [
      { id: 'open', type: 'open-url', config: { url: `${base}/trusted.html`, active: false } },
      { id: 'fake', type: 'click', config: { locator: '#press' } },
      { id: 'r1', type: 'read-element', config: { selector: '#result', url: '' } },
      { id: 'real', type: 'click', config: { locator: '#press' }, step: { realInput: true } },
      { id: 'r2', type: 'read-element', config: { selector: '#result', url: '' } },
      { id: 'type', type: 'fill', config: { locator: 'label=Name', value: 'Akib' }, step: { realInput: true } },
      { id: 'r3', type: 'read-element', config: { selector: 'label=Name', url: '', read: 'attribute', name: 'data-trusted' } },
      { id: 'v', type: 'assert', config: { subject: 'input', locator: 'label=Name', operator: 'equals', expected: 'Akib' } },
      { id: 'shot', type: 'assert', config: { subject: 'text', locator: '#result', operator: 'equals', expected: 'nope' }, step: { timeoutSeconds: 2, onError: 'continue' } },
      { id: 'close', type: 'close-tab' },
    ]));
    check('synthetic click is untrusted, real input is trusted', step(trusted, 'r1')?.output?.value === 'untrusted' && step(trusted, 'r2')?.output?.value === 'trusted', summary(trusted));
    check('real typing (trusted keys, value set)', step(trusted, 'r3')?.output?.value === 'yes' && step(trusted, 'v')?.status === 'passed', summary(trusted));
    check('screenshot of a background tab (through the debugger)', Boolean(step(trusted, 'shot')?.screenshot), JSON.stringify(step(trusted, 'shot')));

    const script = await run(workflow('script', [
      { id: 'open', type: 'open-url', config: { url: `${base}/table.html`, active: false } },
      { id: 'js', type: 'run-script', config: { code: "return document.querySelectorAll('tr').length;" } },
    ]));
    const scriptOk = step(script, 'js')?.output?.result === 4;
    const scriptExplains = String(script.error).includes('Chrome 135');
    check(`Run Script ${scriptOk ? 'ran' : 'explains what it needs on this browser'}`, scriptOk || scriptExplains, script.error);

    // Export as a Playwright test from the editor, then run it with real Playwright.
    const pwFlow = workflow('Exported login', [
      { id: 'open', type: 'open-url', config: { url: `${base}/login.html` } },
      { id: 'form', type: 'fill-form', config: { fields: [{ locator: 'label=Email', value: 'pw@test.dev' }, { locator: 'label=Password', value: '{{secret.loginPassword}}' }, { locator: 'label=Country', value: 'Bangladesh' }, { locator: 'label="Remember me"', value: 'true' }], submit: 'role=button[name="Sign in"]' } },
      { id: 'url', type: 'wait-for', config: { mode: 'url', url: '/welcome' } },
      { id: 'hi', type: 'assert', config: { subject: 'text', locator: '#greeting', operator: 'equals', expected: 'Welcome, pw!' } },
      { id: 'more', type: 'read-element', config: { selector: 'text=Country', url: '' } },
      { id: 'bd', type: 'if', config: { left: '{{value}}', operator: 'contains', right: 'bd' } },
      { id: 'log', type: 'log', config: { message: 'country ok' } },
    ]);
    pwFlow.edges = pwFlow.edges.map((edge) => (edge.source === 'bd' ? { ...edge, sourcePort: 'true' } : edge));
    await seedWorkflows([pwFlow]);
    await h.editor.click('.bf-header .bf-tabs button:has-text("All workflows")');
    const [spec] = await Promise.all([h.editor.waitForEvent('download'), h.editor.click('.bf-table button:has-text("Playwright")')]);
    const fs = await import('node:fs/promises');
    const dir = path.resolve(here, '../../.output-e2e/playwright');
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(await spec.path(), path.join(dir, 'exported.spec.ts'));
    await fs.writeFile(path.join(dir, 'playwright.config.mjs'), `export default { testDir: '.', timeout: 60000, reporter: 'line', use: { headless: true, launchOptions: { executablePath: ${JSON.stringify(executablePath)} } } };\n`);
    // Asynchronously: this process also serves the fixture site the exported test visits.
    const { spawn } = await import('node:child_process');
    const result = await new Promise((resolve) => {
      const child = spawn('npx', ['playwright', 'test', '--config', path.join(dir, 'playwright.config.mjs')], { cwd: path.resolve(here, '../..'), env: { ...process.env, LOGINPASSWORD: PASSWORD } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      const timer = setTimeout(() => child.kill(), 180_000);
      child.on('close', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });
    check('exported .spec.ts passes under npx playwright test', result.status === 0 && /1 passed/.test(result.stdout), `${result.stdout}\n${result.stderr}`.slice(-1500));
  }
}
