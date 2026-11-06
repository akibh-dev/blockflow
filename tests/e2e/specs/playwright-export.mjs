// e2e: richer workflows exported as Playwright tests (M0.2g). Each workflow first runs in the
// extension (so we know it passes there), then is exported from the editor's "Playwright" button and
// run with real `npx playwright test` against the fixture site: data tables + For Each, templates
// with $json and dashed keys, Transform/Filter, every kind of Assert, Wait For response, dialogs,
// uploads (text and URL), popups, Timer delays, retries and error handling.
// Run alone with `npm run e2e -- playwright-export`. `h` is the shared harness (tests/e2e/harness.mjs).

/**
 * The workflows, also used outside the browser while developing the exporter.
 * @param {string} base fixture site address
 * @param {(name: string, nodes: object[], edges?: Array<[string, string, string?]>) => object} workflow
 */
export function exportWorkflows(base, workflow) {
  // Semicolon-separated CSV with quotes (and a quoted separator) to exercise the CSV parser.
  const people = 'email;country;greeting\n"ann@test.dev";Bangladesh;"Welcome, ann!"\n"bob@test.dev";"United States";"Welcome, bob!"';
  const logins = workflow('Export: data-driven logins', [
    { id: 'rows', type: 'data-table', config: { text: people, into: 'people' } },
    { id: 'each', type: 'for-each', config: { list: 'people', as: 'person' } },
    { id: 'open', type: 'open-url', config: { url: `${base}/login.html`, where: 'workflow', active: false } },
    { id: 'tag', type: 'set-variable', config: { name: 'login-email', value: '{{ $json.person.email }}' } },
    {
      id: 'form',
      type: 'fill-form',
      config: {
        fields: [
          { locator: 'label=Email', value: '{{login-email}}' },
          { locator: 'label=Password', value: '{{secret.loginPassword}}' },
          { locator: 'label=Country', value: '{{$json.person.country}}' },
        ],
        submit: 'role=button[name="Sign in"]',
      },
    },
    { id: 'url', type: 'wait-for', config: { mode: 'url', url: '**/welcome.html?name=*' } },
    { id: 'hi', type: 'assert', config: { subject: 'text', locator: '#greeting', operator: 'equals', expected: '{{person.greeting}}' } },
    { id: 'title', type: 'assert', config: { subject: 'title', operator: 'equals', expected: 'Fixture: welcome' } },
    { id: 'where', type: 'assert', config: { subject: 'url', operator: 'matches', expected: '/name=(ann|bob)/' } },
    { id: 'short', type: 'assert', config: { subject: 'text', locator: '#country', operator: 'starts-with', expected: '{{ lower(slice(person.country, 0, 1)) }}' } },
    { id: 'n', type: 'assert', config: { subject: 'value', value: '{{ index + 1 }}', operator: 'less-equal', expected: '{{total}}' } },
    { id: 'sum', type: 'transform', config: { values: [{ name: 'emails', expression: "join(pluck(people, 'email'), ' ')" }] } },
    { id: 'all', type: 'assert', config: { subject: 'value', value: '{{emails}} ({{count}})', operator: 'equals', expected: 'ann@test.dev bob@test.dev (2)' } },
  ], [
    ['rows', 'each'], ['each', 'open', 'each'], ['open', 'tag'], ['tag', 'form'], ['form', 'url'], ['url', 'hi'], ['hi', 'title'], ['title', 'where'], ['where', 'short'], ['short', 'n'],
    ['each', 'sum', 'done'], ['sum', 'all'],
  ]);

  const pages = workflow('Export: API, dialogs and uploads', [
    { id: 'name', type: 'set-variable', config: { name: 'name', value: 'Akib' } },
    { id: 'open', type: 'open-url', config: { url: `${base}/api.html`, active: false } },
    { id: 'save', type: 'click', config: { locator: 'role=button[name="Save"]' } },
    { id: 'wait', type: 'wait-for', config: { mode: 'response', url: '**/api/save', status: '2xx' }, step: { timeoutSeconds: 10 } },
    { id: 'code', type: 'assert', config: { subject: 'value', value: '{{response.method}} {{response.status}}', operator: 'equals', expected: 'POST 201' } },
    { id: 'saved', type: 'assert', config: { subject: 'text', locator: '#status', operator: 'equals', expected: 'Saved' }, step: { timeoutSeconds: 5 } },
    { id: 'nope', type: 'click', config: { locator: '#does-not-exist' }, step: { timeoutSeconds: 1, onError: 'continue' } },
    { id: 'pause', type: 'timer', config: { seconds: 1, repeat: false } },
    { id: 'go', type: 'navigate', config: { action: 'goto', url: `${base}/dialogs.html` } },
    { id: 'no', type: 'dialogs', config: { action: 'dismiss' } },
    { id: 'del', type: 'click', config: { locator: '#del' } },
    { id: 'kept', type: 'assert', config: { subject: 'text', locator: '#result', operator: 'equals', expected: 'kept' } },
    { id: 'yes', type: 'dialogs', config: { action: 'accept', text: '{{name}}' } },
    { id: 'ask', type: 'click', config: { locator: '#ask' }, step: { retries: 2 } },
    { id: 'hi', type: 'assert', config: { subject: 'text', locator: '#result', operator: 'contains', expected: 'Hi {{name}}' } },
    { id: 'read', type: 'dialogs', config: { action: 'read' } },
    { id: 'asked', type: 'assert', config: { subject: 'value', value: '{{lastDialog}}', operator: 'equals', expected: 'Your name?' } },
    { id: 'up', type: 'navigate', config: { action: 'goto', url: `${base}/upload.html` } },
    { id: 'text', type: 'upload-file', config: { locator: 'label=Upload CV', source: 'text', content: 'name,city\n{{name}},Dhaka', filename: 'cv.csv', mime: 'text/csv' } },
    { id: 'got', type: 'assert', config: { subject: 'text', locator: '#out', operator: 'equals', expected: 'cv.csv|text/csv|name,city Akib,Dhaka' } },
    { id: 'url', type: 'upload-file', config: { locator: 'label=Upload CV', source: 'url', url: `${base}/table.html`, filename: '' } },
    { id: 'got2', type: 'assert', config: { subject: 'text', locator: '#out', operator: 'matches', expected: '/^table\\.html\\|text\\/html\\|/' } },
    { id: 'drop', type: 'upload-file', config: { locator: '#zone', target: 'dropzone', source: 'data', data: 'data:text/plain;base64,aGVsbG8=', filename: 'hi.txt' } },
    { id: 'got3', type: 'assert', config: { subject: 'text', locator: '#dropped', operator: 'equals', expected: 'hi.txt|text/plain|hello' } },
    { id: 'clicks', type: 'navigate', config: { action: 'goto', url: `${base}/clicks.html` } },
    { id: 'mid', type: 'click', config: { locator: '#target', button: 'middle', modifiers: 'Shift', position: '5,6' } },
    { id: 'midLog', type: 'assert', config: { subject: 'text', locator: '#log', operator: 'contains', expected: 'auxclick 1 1 Shift 5,6' } },
    { id: 'focus', type: 'element-action', config: { locator: 'label=Name', action: 'focus' } },
    { id: 'clear', type: 'element-action', config: { locator: 'label=Name', action: 'clear' } },
    { id: 'empty', type: 'assert', config: { subject: 'input', locator: 'label=Name', operator: 'equals', expected: '' } },
    { id: 'event', type: 'element-action', config: { locator: '#custom-target', action: 'dispatch-event', eventType: 'my-event', detail: '{"n": 2}' } },
    { id: 'custom', type: 'assert', config: { subject: 'text', locator: '#custom', operator: 'equals', expected: 'custom-target {"n":2}' } },
    { id: 'dnd', type: 'navigate', config: { action: 'goto', url: `${base}/dnd.html` } },
    { id: 'sort', type: 'drag', config: { from: '#list >> text=Apple', to: '#list >> text=Cherry' } },
    { id: 'sorted', type: 'assert', config: { subject: 'text', locator: '#order', operator: 'equals', expected: 'Banana,Cherry,Apple' } },
    { id: 'slide', type: 'drag', config: { from: 'role=slider', to: '#track', toPosition: '150,10' } },
    { id: 'slid', type: 'assert', config: { subject: 'text', locator: '#value', operator: 'equals', expected: '75' } },
    { id: 'close', type: 'close-tab' },
  ]);

  const scrape = workflow('Export: scrape, popups and errors', [
    { id: 'open', type: 'open-url', config: { url: `${base}/table.html`, active: false } },
    { id: 'table', type: 'extract-table', config: { locator: '#prices', into: 'rows' } },
    { id: 'filter', type: 'filter', config: { list: 'rows', left: '{{item.Price}}', operator: 'greater', right: '10', into: 'expensive' } },
    { id: 'calc', type: 'transform', config: { values: [{ name: 'names', expression: "join(pluck(expensive, 'Product'), ', ')" }, { name: 'total', expression: "sum(pluck(rows, 'Price'))" }] } },
    { id: 'js', type: 'run-script', config: { code: "const rows = document.querySelectorAll('tr').length;\nreturn `${rows} rows, ${data.names}`;", into: 'script' } },
    { id: 'ran', type: 'assert', config: { subject: 'value', value: '{{script}}', operator: 'equals', expected: '4 rows, Kettle, Toaster' } },
    { id: 'names', type: 'assert', config: { subject: 'value', value: '{{names}}', operator: 'equals', expected: 'Kettle, Toaster' } },
    { id: 'total', type: 'assert', config: { subject: 'value', value: '{{ total }}', operator: 'equals', expected: '70' } },
    { id: 'count', type: 'assert', config: { subject: 'count', locator: '#prices tbody tr', operator: 'greater-equal', expected: '3' } },
    { id: 'h1', type: 'assert', config: { subject: 'text', locator: 'h1', operator: 'matches', expected: '/^pri/i' } },
    { id: 'href', type: 'assert', config: { subject: 'attribute', locator: '#prices a', name: 'href', operator: 'starts-with', expected: '/p/' } },
    { id: 'soft', type: 'assert', config: { subject: 'text', locator: 'role=cell[name="Mug"]', operator: 'not-empty', expected: '', soft: true } },
    { id: 'loop', type: 'repeat', config: { times: 2 } },
    { id: 'tick', type: 'set-variable', config: { name: 'last', value: '{{iteration}}' } },
    { id: 'if', type: 'if', config: { left: '{{iteration}}', operator: 'equals', right: '2' } },
    { id: 'log', type: 'log', config: { message: 'second round, last = {{last}}' } },
    { id: 'pop', type: 'open-url', config: { url: `${base}/popup.html`, active: false } },
    { id: 'help', type: 'click', config: { locator: 'role=button[name="Open help"]' } },
    { id: 'catch', type: 'wait-for-popup', config: { name: 'help' } },
    { id: 'helpTitle', type: 'assert', config: { subject: 'title', tab: 'help', operator: 'contains', expected: 'price table' } },
    { id: 'feed', type: 'click', config: { locator: 'text=Feed in a new tab' } },
    { id: 'catch2', type: 'wait-for-popup', config: { name: 'feed' } },
    { id: 'feedUrl', type: 'assert', config: { subject: 'url', tab: 'feed', operator: 'ends-with', expected: '/feed.html' } },
    { id: 'missing', type: 'assert', config: { subject: 'text', locator: '#missing', operator: 'equals', expected: 'x' }, step: { timeoutSeconds: 1, onError: 'port' } },
    { id: 'recover', type: 'set-variable', config: { name: 'recovered', value: 'yes after {{errorBlock}}' } },
    { id: 'check', type: 'assert', config: { subject: 'value', value: '{{recovered}}', operator: 'equals', expected: 'yes after Assert' } },
    { id: 'close', type: 'close-tab', config: { tab: 'help' } },
    { id: 'close2', type: 'close-tab', config: { tab: 'feed' } },
    { id: 'close3', type: 'close-tab' },
  ], [
    ['open', 'table'], ['table', 'filter'], ['filter', 'calc'], ['calc', 'js'], ['js', 'ran'], ['ran', 'names'], ['names', 'total'], ['total', 'count'], ['count', 'h1'], ['h1', 'href'], ['href', 'soft'], ['soft', 'loop'],
    ['loop', 'tick', 'each'], ['tick', 'if'], ['if', 'log', 'true'],
    ['loop', 'pop', 'done'], ['pop', 'help'], ['help', 'catch'], ['catch', 'helpTitle'], ['helpTitle', 'feed'], ['feed', 'catch2'], ['catch2', 'feedUrl'], ['feedUrl', 'missing'],
    ['missing', 'recover', 'error'], ['recover', 'check'], ['check', 'close'], ['close', 'close2'], ['close2', 'close3'],
  ]);
  return [logins, pages, scrape];
}

/** @param {import('../harness.mjs').Harness} h */
export default async function (h) {
  const { base, check, executablePath, here, PASSWORD, path, run, seedWorkflows, summary, worker, workflow } = h;
  console.log('Playwright export: richer workflows, run in BlockFlow, then exported and run with npx playwright test');
  await worker.evaluate((password) => chrome.storage.local.set({ 'bf:secrets': { loginPassword: password } }), PASSWORD);
  const flows = exportWorkflows(base, workflow);

  for (const flow of flows) {
    let record = await run(flow);
    let note = '';
    // Run Script needs Chrome 135+ with user scripts allowed; elsewhere check the rest without it.
    const script = record.steps.find((s) => s.nodeId === 'js');
    if (script?.status === 'failed' && String(script.error).includes('Chrome 135')) {
      const nodes = flow.nodes.filter((node) => node.id !== 'js' && node.id !== 'ran');
      const edges = flow.edges.filter((edge) => !['js', 'ran'].includes(edge.source) && !['js', 'ran'].includes(edge.target));
      record = await run({ ...flow, id: `${flow.id}-no-script`, nodes, edges: [...edges, { id: 'calc--names', source: 'calc', target: 'names' }] });
      note = ' (without Run Script: this browser has no user scripts)';
    }
    check(`in BlockFlow: ${flow.name}${note}`, record.status === 'passed', summary(record));
  }

  // Export each one from the editor's workflow list, like a user would.
  await seedWorkflows(flows);
  await h.editor.click('.bf-header .bf-tabs button:has-text("All workflows")');
  const fs = await import('node:fs/promises');
  const dir = path.resolve(here, '../../.output-e2e/playwright-export');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  for (const [index, flow] of flows.entries()) {
    const row = h.editor.locator('.bf-table tr', { hasText: flow.name });
    const [download] = await Promise.all([h.editor.waitForEvent('download'), row.locator('button:has-text("Playwright")').click()]);
    await fs.copyFile(await download.path(), path.join(dir, `export-${index + 1}.spec.ts`));
  }
  const specs = (await fs.readdir(dir)).filter((name) => name.endsWith('.spec.ts'));
  check('three specs downloaded', specs.length === 3, specs.join(', '));
  const texts = await Promise.all(specs.map((name) => fs.readFile(path.join(dir, name), 'utf8')));
  const all = texts.join('\n');
  check(
    'the specs use real Playwright for responses, dialogs, uploads, popups and asserts',
    ['waitForResponse(', 'answerDialogs(', '.setInputFiles(', 'waitForPopup(', 'toHaveTitle(', 'toHaveURL(regexOf(', 'expect.poll(', 'expect.configure({ soft: true }).poll(', 'page.waitForTimeout(1000)', 'await retry(2,'].every((part) => all.includes(part)) &&
      !all.includes('BlockFlow-only'),
    'missing mapping',
  );

  await fs.writeFile(
    path.join(dir, 'playwright.config.mjs'),
    `export default { testDir: '.', timeout: 90000, workers: 1, reporter: 'line', use: { headless: true, launchOptions: { executablePath: ${JSON.stringify(executablePath)} } } };\n`,
  );
  // Asynchronously: this process also serves the fixture site the exported tests visit.
  const { spawn } = await import('node:child_process');
  const result = await new Promise((resolve) => {
    const child = spawn('npx', ['playwright', 'test', '--config', path.join(dir, 'playwright.config.mjs')], { cwd: path.resolve(here, '../..'), env: { ...process.env, LOGINPASSWORD: PASSWORD } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), 300_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
  check('the 3 exported specs pass under npx playwright test', result.status === 0 && /3 passed/.test(result.stdout), `${result.stdout}\n${result.stderr}`.slice(-3000));
}
