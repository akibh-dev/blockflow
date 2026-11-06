// e2e scenarios (M2): Wait for Download, Screenshot, Cookies & Storage, Wait For request / response body.
// Run alone with `npm run e2e -- m2-browser`. `h` is the shared harness (tests/e2e/harness.mjs).

/** @param {import('../harness.mjs').Harness} h */
export default async function (h) {
  const { base, check, run, step, summary, workflow } = h;
  console.log('M2: downloads, screenshots, cookies and storage, requests');

  const downloads = await run(workflow('downloads', [
    { id: 'open', type: 'open-url', config: { url: `${base}/m2.html`, active: false } },
    { id: 'csv', type: 'click', config: { locator: 'text=Export CSV' } },
    { id: 'wait', type: 'wait-for-download', config: { url: 'export.csv', read: 'csv', dataset: 'e2e-export' } },
    { id: 'blob', type: 'click', config: { locator: '#blob' } },
    { id: 'json', type: 'wait-for-download', config: { url: 'blob:', read: 'json' } },
    { id: 'close', type: 'close-tab' },
  ]));
  const csv = step(downloads, 'wait')?.output;
  // (Under Playwright the browser saves downloads under GUID names, so the file name is not checked here;
  // the Firefox e2e checks it.)
  check('Wait for Download: CSV link → url, size, type, rows, dataset', csv?.download?.url === `${base}/export.csv` && csv?.download?.filename && csv?.download?.size === 21 && csv?.download?.mime === 'text/csv' && csv?.rows?.[1]?.name === 'cup' && csv?.datasetSize === 2, JSON.stringify(csv ?? summary(downloads)).slice(0, 600));
  const json = step(downloads, 'json')?.output;
  check('Wait for Download: a file the page made (blob:) read as JSON', Array.isArray(json?.data) && json.data[1]?.name === 'cup', JSON.stringify(json ?? summary(downloads)).slice(0, 600));

  const shots = await run(workflow('screenshots', [
    { id: 'open', type: 'open-url', config: { url: `${base}/m2.html`, active: false } },
    { id: 'visible', type: 'screenshot', config: {} },
    { id: 'full', type: 'screenshot', config: { area: 'full', format: 'jpeg', quality: 50 } },
    { id: 'element', type: 'screenshot', config: { area: 'element', locator: '#card' } },
    { id: 'close', type: 'close-tab' },
  ]));
  const size = (id) => step(shots, id)?.output?.screenshot;
  const visible = size('visible');
  const full = size('full');
  const element = size('element');
  check('Screenshot: visible area of a background tab (debugger)', visible?.width > 0 && visible?.height > 0 && Boolean(step(shots, 'visible')?.screenshot), JSON.stringify(visible ?? summary(shots)));
  check('Screenshot: full page is taller than the viewport', full?.height > 2600 && full.height > visible?.height, JSON.stringify(full ?? summary(shots)));
  const ratio = element ? element.width / 300 : 0;
  check('Screenshot: element is the 300×120 card', ratio >= 1 && Math.abs(element.height / ratio - 120) <= 2 && Math.abs(element.width / ratio - 300) <= 2, JSON.stringify(element ?? summary(shots)));
  const stored = await h.editor.evaluate(async (id) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('blockflow');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const shot = await new Promise((resolve) => {
      const request = db.transaction('screenshots').objectStore('screenshots').get(id);
      request.onsuccess = () => resolve(request.result);
    });
    return shot?.dataUrl?.slice(0, 22) ?? null;
  }, step(shots, 'element')?.screenshot);
  check('Screenshot: stored like step screenshots (IndexedDB, PNG)', stored === 'data:image/png;base64,', String(stored));

  const cookies = await run(workflow('cookies', [
    { id: 'open', type: 'open-url', config: { url: `${base}/login-cookie`, active: false } },
    { id: 'sid', type: 'cookies-storage', config: { action: 'get', name: 'sid' } },
    { id: 'set', type: 'cookies-storage', config: { action: 'set', name: 'theme', value: 'dark', maxAgeSeconds: 3600 } },
    { id: 'go', type: 'navigate', config: { action: 'goto', url: `${base}/whoami` } },
    { id: 'sent', type: 'read-element', config: { locator: 'body', url: '' } },
    { id: 'del', type: 'cookies-storage', config: { action: 'delete', name: 'theme' } },
    { id: 'clear', type: 'cookies-storage', config: { action: 'clear' } },
    { id: 'all', type: 'cookies-storage', config: { action: 'get' } },
    { id: 'lset', type: 'cookies-storage', config: { area: 'local', action: 'set', name: 'token', value: 'abc' } },
    { id: 'sset', type: 'cookies-storage', config: { area: 'session', action: 'set', name: 'step', value: '2' } },
    { id: 'lget', type: 'cookies-storage', config: { area: 'local', action: 'get' } },
    { id: 'ldel', type: 'cookies-storage', config: { area: 'local', action: 'delete', name: 'token' } },
    { id: 'sclear', type: 'cookies-storage', config: { area: 'session', action: 'clear' } },
    { id: 'info', type: 'page-info', config: { area: 'local' } },
    { id: 'close', type: 'close-tab' },
  ]));
  check('Cookies: reads an HttpOnly cookie', step(cookies, 'sid')?.output?.value === 's3cret' && step(cookies, 'sid')?.output?.cookies?.[0]?.httpOnly === true, JSON.stringify(step(cookies, 'sid')?.output?.cookies ?? summary(cookies)));
  check('Cookies: a cookie set by the block is sent to the site', /theme=dark/.test(String(step(cookies, 'sent')?.output?.value)) && /sid=s3cret/.test(String(step(cookies, 'sent')?.output?.value)), String(step(cookies, 'sent')?.output?.value ?? summary(cookies)));
  // (Other specs leave cookies and storage on the fixture origin, so counts are at least, not exact.)
  check('Cookies: delete one, clear the rest', step(cookies, 'del')?.output?.deleted === 1 && step(cookies, 'clear')?.output?.deleted >= 1 && JSON.stringify(step(cookies, 'all')?.output?.value) === '{}', summary(cookies));
  check(
    'Storage: local / session set, get, delete, clear',
    step(cookies, 'lget')?.output?.value?.token === 'abc' && step(cookies, 'ldel')?.output?.deleted === 1 && step(cookies, 'sclear')?.output?.deleted >= 1 && step(cookies, 'info')?.output?.value?.token === undefined,
    summary(cookies),
  );

  const network = await run(workflow('requests', [
    { id: 'open', type: 'open-url', config: { url: `${base}/m2.html`, active: false } },
    { id: 'send', type: 'click', config: { locator: '#send' } },
    { id: 'req', type: 'wait-for', config: { mode: 'request', url: '/api/save', method: 'POST' } },
    { id: 'res', type: 'wait-for', config: { mode: 'response', url: '/api/save', method: 'POST', status: '201' } },
    { id: 'later', type: 'click', config: { locator: '#later' } },
    { id: 'body', type: 'wait-for', config: { mode: 'response', url: '/api/slow', captureBody: true } },
    { id: 'close', type: 'close-tab' },
  ]));
  const request = step(network, 'req')?.output?.request;
  check('Wait For request: POST with its body', request?.method === 'POST' && JSON.parse(request?.postData ?? '{}').item === 'mug', JSON.stringify(request ?? summary(network)));
  check('Wait For response: method filter', step(network, 'res')?.output?.response?.status === 201, summary(network));
  const body = step(network, 'body')?.output?.response?.body;
  check('Wait For response: captured body (debugger)', typeof body === 'string' && typeof JSON.parse(body).order === 'number', String(body ?? summary(network)));

  // The same blocks exported as a Playwright test, run with real Playwright.
  const exported = workflow('Export: M2 browser blocks', [
    { id: 'open', type: 'open-url', config: { url: `${base}/m2.html`, active: false } },
    { id: 'csv', type: 'click', config: { locator: 'text=Export CSV' } },
    { id: 'dl', type: 'wait-for-download', config: { url: 'export.csv', read: 'csv' } },
    { id: 'rows', type: 'assert', config: { subject: 'value', value: '{{rows[1].name}} {{download.size}}', operator: 'equals', expected: 'cup 21' } },
    { id: 'full', type: 'screenshot', config: { area: 'full' } },
    { id: 'card', type: 'screenshot', config: { area: 'element', locator: '#card', format: 'jpeg' } },
    { id: 'set', type: 'cookies-storage', config: { action: 'set', name: 'theme', value: 'dark' } },
    { id: 'get', type: 'cookies-storage', config: { action: 'get', name: 'theme' } },
    { id: 'dark', type: 'assert', config: { subject: 'value', value: '{{value}}', operator: 'equals', expected: 'dark' } },
    { id: 'clear', type: 'cookies-storage', config: { action: 'clear' } },
    { id: 'gone', type: 'assert', config: { subject: 'value', value: '{{deleted}}', operator: 'equals', expected: '1' } },
    { id: 'lset', type: 'cookies-storage', config: { area: 'local', action: 'set', name: 'token', value: 'abc' } },
    { id: 'lget', type: 'cookies-storage', config: { area: 'local', action: 'get', name: 'token' } },
    { id: 'abc', type: 'assert', config: { subject: 'value', value: '{{value}}', operator: 'equals', expected: 'abc' } },
    { id: 'send', type: 'click', config: { locator: '#send' } },
    { id: 'req', type: 'wait-for', config: { mode: 'request', url: '/api/save', method: 'POST' } },
    { id: 'posted', type: 'assert', config: { subject: 'value', value: '{{request.postData}}', operator: 'contains', expected: 'mug' } },
    { id: 'later', type: 'click', config: { locator: '#later' } },
    { id: 'body', type: 'wait-for', config: { mode: 'response', url: '/api/slow', captureBody: true } },
    { id: 'order', type: 'assert', config: { subject: 'value', value: '{{response.body}}', operator: 'contains', expected: 'order' } },
    { id: 'close', type: 'close-tab' },
  ]);
  const inExtension = await run(exported);
  check('in BlockFlow: the M2 export workflow passes', inExtension.status === 'passed', summary(inExtension));
  await h.seedWorkflows([exported]);
  await h.editor.click('.bf-header .bf-tabs button:has-text("All workflows")');
  const fsp = await import('node:fs/promises');
  const dir = h.path.resolve(h.here, '../../.output-e2e/playwright-m2');
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const row = h.editor.locator('.bf-table tr', { hasText: exported.name });
  const [file] = await Promise.all([h.editor.waitForEvent('download'), row.locator('button:has-text("Playwright")').click()]);
  await fsp.copyFile(await file.path(), h.path.join(dir, 'm2.spec.ts'));
  const text = await fsp.readFile(h.path.join(dir, 'm2.spec.ts'), 'utf8');
  check('the spec maps every M2 block (no BlockFlow-only lines)', !text.includes('BlockFlow-only') && ['waitForDownload(', '.screenshot(', 'cookies(context', 'pageStorage(', 'waitForRequest('].every((part) => text.includes(part)), 'missing mapping');
  await fsp.writeFile(
    h.path.join(dir, 'playwright.config.mjs'),
    `export default { testDir: '.', timeout: 90000, workers: 1, reporter: 'line', use: { headless: true, launchOptions: { executablePath: ${JSON.stringify(h.executablePath)} } } };\n`,
  );
  const { spawn } = await import('node:child_process');
  const result = await new Promise((resolve) => {
    const child = spawn('npx', ['playwright', 'test', '--config', h.path.join(dir, 'playwright.config.mjs')], { cwd: h.path.resolve(h.here, '../..') });
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
  check('the exported M2 spec passes under npx playwright test', result.status === 0 && /1 passed/.test(result.stdout), `${result.stdout}\n${result.stderr}`.slice(-3000));
}
