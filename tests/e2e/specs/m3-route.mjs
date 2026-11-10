/** M3.1 request routing against real browser Fetch and declarative session rules. */
/** @param {import('../harness.mjs').Harness} h */
export default async function (h) {
  const { base, check, run, step, summary, workflow, worker } = h;
  console.log('M3: request routes (CDP and browser rules)');
  const rules = (entries) => JSON.stringify(entries);
  const posts = [];
  const observe = (request) => {
    if (request.url !== '/api/save' || request.method !== 'POST') return;
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => posts.push({ body, header: request.headers['x-route'] }));
  };
  h.server.on('request', observe);
  const opened = [];
  try {
    const mocked = await run(workflow('M3 CDP mock and modify', [
      { id: 'open', type: 'open-url', config: { url: `${base}/m3-route.html`, active: false } },
      { id: 'route', type: 'route', config: { backend: 'cdp', rules: rules([
        { url: '**/api/m3-mock', action: 'fulfill', body: 'old' },
        { url: '**/api/m3-mock', method: 'GET', action: 'fulfill', status: 202, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-mock': 'yes' }, body: 'বাংলা' },
        { url: '**/api/save', method: 'GET', action: 'abort' },
        { url: '**/api/save', method: 'POST', action: 'modify', headers: { 'x-route': 'modified' }, body: '{"item":"modified"}' },
      ]) } },
      { id: 'mock', type: 'click', config: { locator: '#mock' } },
      { id: 'mocked', type: 'assert', config: { subject: 'text', locator: '#mock-result', operator: 'equals', expected: '202|বাংলা|yes' } },
      { id: 'save', type: 'click', config: { locator: '#save' } },
      { id: 'saved', type: 'assert', config: { subject: 'text', locator: '#save-result', operator: 'contains', expected: '201|{"saved":true}' } },
      { id: 'clear', type: 'route', config: { action: 'clear' } },
      { id: 'again', type: 'click', config: { locator: '#mock' } },
      { id: 'real', type: 'assert', config: { subject: 'text', locator: '#mock-result', operator: 'contains', expected: '404|' } },
    ]));
    const tabId = step(mocked, 'open')?.output?.tabId; opened.push(tabId);
    check('CDP fulfill: method, newest match, Unicode response, status and headers', step(mocked, 'mocked')?.status === 'passed', summary(mocked));
    check('CDP modify changes the actual request body and headers sent to the server', posts.some((post) => post.body === '{"item":"modified"}' && post.header === 'modified') && step(mocked, 'saved')?.status === 'passed', `${JSON.stringify(posts)} ${summary(mocked)}`);
    check('Route clear restores real page traffic', step(mocked, 'real')?.status === 'passed', summary(mocked));

    const browser = await run(workflow('M3 browser block and redirect', [
      { id: 'open', type: 'open-url', config: { url: `${base}/m3-route.html`, active: false } },
      { id: 'route', type: 'route', config: { backend: 'dnr', rules: rules([
        { url: '**/api/m3-mock', action: 'abort' },
        { url: '**/api/m3-redirect', action: 'redirect', redirectUrl: `${base}/export.csv` },
      ]) } },
      { id: 'block', type: 'click', config: { locator: '#mock' } },
      { id: 'blocked', type: 'assert', config: { subject: 'text', locator: '#mock-result', operator: 'equals', expected: 'blocked' } },
      { id: 'redirect', type: 'click', config: { locator: '#redirect' } },
      { id: 'redirected', type: 'assert', config: { subject: 'text', locator: '#redirect-result', operator: 'contains', expected: 'name,qty' } },
    ]));
    opened.push(step(browser, 'open')?.output?.tabId);
    check('Browser rules block and redirect in a tab without CDP', browser.status === 'passed' && browser.usedDebugger === undefined, summary(browser));
    const reserved = await worker.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).filter((rule) => rule.id >= 1_000_000 && rule.id <= 1_099_999));
    check('Run completion removes its browser session rules', reserved.length === 0, JSON.stringify(reserved));

    const aborted = await run(workflow('M3 CDP abort', [
      { id: 'open', type: 'open-url', config: { url: `${base}/m3-route.html`, active: false } },
      { id: 'route', type: 'route', config: { backend: 'cdp', rules: rules([{ url: '**/api/m3-mock', action: 'abort' }]) } },
      { id: 'block', type: 'click', config: { locator: '#mock' } },
      { id: 'blocked', type: 'assert', config: { subject: 'text', locator: '#mock-result', operator: 'equals', expected: 'blocked' } },
    ]));
    opened.push(step(aborted, 'open')?.output?.tabId);
    check('CDP abort rejects the page request', aborted.status === 'passed', summary(aborted));
  } finally {
    h.server.off('request', observe);
    for (const tabId of opened.filter(Number.isInteger)) await worker.evaluate((id) => chrome.tabs.remove(id).catch(() => {}), tabId);
  }
}
