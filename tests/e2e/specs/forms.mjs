// e2e scenarios: Login forms, error outputs, a single-page app, clear failures.
// Run alone with `npm run e2e -- forms`. `h` is the shared harness (tests/e2e/harness.mjs).

/** @param {import('../harness.mjs').Harness} h */
export default async function (h) {
  const { base, check, context, executablePath, here, openEditor, PASSWORD, path, run, seedWorkflows, server, step, summary, worker, workflow } = h;
  {
    console.log('Classic login form (new page after submit)');
    const wf = workflow('login', [
      { id: 'open', type: 'open-url', config: { url: `${base}/login.html`, active: false } },
      {
        id: 'form',
        type: 'fill-form',
        config: {
          fields: [
            { locator: 'label=Email', value: 'akib@test.dev' },
            { locator: 'label=Password', value: PASSWORD },
            { locator: 'label=Country', value: 'Bangladesh' },
            { locator: 'label="Remember me"', value: 'true' },
          ],
          submit: 'role=button[name="Sign in"]',
        },
      },
      { id: 'wait', type: 'wait-for', config: { mode: 'url', url: '/welcome' } },
      { id: 'read', type: 'read-element', config: { locator: '#greeting', url: '' } },
      { id: 'if', type: 'if', config: { left: '{{value}}', operator: 'equals', right: 'Welcome, akib!' } },
      { id: 'meta', type: 'read-element', config: { locator: 'text=Country', url: '' } },
      { id: 'close', type: 'close-tab' },
    ], [['open', 'form'], ['form', 'wait'], ['wait', 'read'], ['read', 'if'], ['if', 'meta', 'true'], ['meta', 'close']]);
    const record = await run(wf);
    check('run passed', record.status === 'passed', summary(record));
    check('landed on /welcome', String(step(record, 'wait')?.output?.url).includes('/welcome.html'));
    check('If took "true"', step(record, 'if')?.port === 'true', JSON.stringify(step(record, 'read')?.output?.value));
    check('select and checkbox were submitted', String(step(record, 'meta')?.output?.value).includes('Country: bd · Remember: on'), String(step(record, 'meta')?.output?.value));
  }

  {
    console.log('Wrong password goes to the error output');
    const wf = workflow('bad login', [
      { id: 'open', type: 'open-url', config: { url: `${base}/login.html`, active: false } },
      { id: 'form', type: 'fill-form', config: { fields: [{ locator: 'label=Email', value: 'a@b.co' }, { locator: 'label=Password', value: 'nope' }], submit: 'role=button[name="Sign in"]' } },
      { id: 'wait', type: 'wait-for', config: { mode: 'url', url: '/welcome' }, step: { timeoutSeconds: 4, onError: 'port' } },
      { id: 'ok', type: 'set-variable', config: { name: 'result', value: 'logged in' } },
      { id: 'seen', type: 'wait-for', config: { mode: 'text', text: 'Wrong email or password' } },
      { id: 'close', type: 'close-tab' },
    ], [['open', 'form'], ['form', 'wait'], ['wait', 'ok'], ['wait', 'seen', 'error'], ['seen', 'close']]);
    const record = await run(wf);
    check('run passed (error was handled)', record.status === 'passed', summary(record));
    check('Wait For was routed to "error"', step(record, 'wait')?.status === 'handled' && step(record, 'wait')?.port === 'error');
    check('the timeout explains itself', String(step(record, 'wait')?.error).includes('waiting for the URL to match /welcome'), step(record, 'wait')?.error);
    check('error message on the page was found', step(record, 'seen')?.status === 'passed');
    check('success branch did not run', !step(record, 'ok'));
  }

  {
    console.log('Single-page app: overlay, controlled inputs, custom checkbox, disabled button, pushState, shadow DOM');
    const wf = workflow('spa', [
      { id: 'open', type: 'open-url', config: { url: `${base}/spa.html`, active: true } },
      { id: 'early', type: 'click', config: { locator: 'fancy-counter >>> button' }, step: { timeoutSeconds: 2, onError: 'continue' } },
      { id: 'cookies', type: 'click', config: { locator: 'role=button[name="Accept"]' } },
      { id: 'name', type: 'fill', config: { locator: 'label="Full name"', value: 'Akib Hasan' } },
      { id: 'email', type: 'fill', config: { locator: 'placeholder=you@example.com', value: 'akib@test.dev', mode: 'type' } },
      { id: 'plan', type: 'select-option', config: { locator: 'label=Plan', value: 'Pro' } },
      { id: 'terms', type: 'check', config: { locator: 'label="I accept the terms"' } },
      { id: 'state', type: 'read-element', config: { locator: 'testid=state', url: '' } },
      { id: 'create', type: 'click', config: { locator: 'role=button[name="Create account"]' } },
      { id: 'thanks', type: 'wait-for', config: { mode: 'text', text: 'Thanks, Akib Hasan!' } },
      { id: 'route', type: 'wait-for', config: { mode: 'url', url: '**/spa/done' } },
      { id: 'order', type: 'read-element', config: { locator: '#order', url: '' } },
      { id: 'valid', type: 'if', config: { left: '{{value}}', operator: 'matches', right: '/^#\\d+$/' } },
      { id: 'shadow', type: 'click', config: { locator: 'fancy-counter >>> button' } },
      { id: 'count', type: 'read-element', config: { locator: 'fancy-counter >>> .count', url: '' } },
      { id: 'close', type: 'close-tab' },
    ]);
    wf.edges = wf.edges.map((edge) => (edge.source === 'valid' ? { ...edge, sourcePort: 'true' } : edge));
    const record = await run(wf);
    check('run passed', record.status === 'passed', summary(record));
    check('clicking under the cookie banner waited and said why', String(step(record, 'early')?.error).includes('is covered by'), step(record, 'early')?.error);
    check('controlled inputs, select and checkbox reached the app state', String(step(record, 'state')?.output?.value) === '{"name":"Akib Hasan","email":"akib@test.dev","plan":"pro","terms":true}', String(step(record, 'state')?.output?.value));
    check('SPA route change seen', String(step(record, 'route')?.output?.url).endsWith('/spa/done'));
    check('order number read and checked', step(record, 'valid')?.port === 'true', String(step(record, 'order')?.output?.value));
    check('shadow DOM button clicked', step(record, 'count')?.output?.value === '1', String(step(record, 'count')?.output?.value));
  }

  {
    console.log('Clear failures');
    const wf = workflow('strict', [
      { id: 'open', type: 'open-url', config: { url: `${base}/login.html`, active: false } },
      { id: 'any', type: 'click', config: { locator: 'button' } },
    ]);
    const record = await run(wf);
    check('two matches fail with a hint', record.status === 'failed' && String(record.error).includes('matches 2 elements') && String(record.error).includes('nth=0'), record.error);
    const missing = workflow('missing', [
      { id: 'open', type: 'open-url', config: { url: `${base}/login.html`, active: false } },
      { id: 'gone', type: 'click', config: { locator: 'text=Does not exist' }, step: { timeoutSeconds: 3 } },
    ]);
    const second = await run(missing);
    check('missing element times out with the reason', /Timed out after \d+s: waiting for text=Does not exist: no element matches/.test(String(second.error)), second.error);
  }
}
