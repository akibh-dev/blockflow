// e2e scenarios: Scraping, loops, datasets, downloads.
// Run alone with `npm run e2e -- scraping`. `h` is the shared harness (tests/e2e/harness.mjs).

/** @param {import('../harness.mjs').Harness} h */
export default async function (h) {
  const { base, check, context, executablePath, here, openEditor, PASSWORD, path, run, seedWorkflows, server, step, summary, worker, workflow } = h;
  {
    console.log('Phase D: scraping, loops, datasets, downloads');
    const scrape = workflow('scrape products', [
      { id: 'open', type: 'open-url', config: { url: `${base}/products?page=1`, active: false } },
      { id: 'pages', type: 'paginate', config: { locator: 'a.next', maxPages: 10 } },
      { id: 'cards', type: 'extract-list', config: { locator: 'li.card', fields: [{ name: 'title', locator: 'h2', attribute: '' }, { name: 'price', locator: '.price', attribute: '' }, { name: 'link', locator: 'a', attribute: 'href' }] } },
      { id: 'save', type: 'save-dataset', config: { dataset: 'e2e-products', value: 'items', mode: 'append' } },
      { id: 'file', type: 'download', config: { from: 'dataset', dataset: 'e2e-products', format: 'csv', filename: 'e2e-products.csv' } },
    ], [['open', 'pages'], ['pages', 'cards', 'each'], ['cards', 'save'], ['pages', 'file', 'done']]);
    // Start from an empty dataset.
    await run(workflow('clear', [{ id: 'all', type: 'save-dataset', config: { dataset: 'e2e-products', value: '[]', mode: 'replace' } }]));
    const record = await run(scrape);
    check('paginated 3 pages and passed', record.status === 'passed' && step(record, 'file')?.input?.pages === 3, summary(record));
    check('dataset has all 9 products with absolute links', step(record, 'file')?.status === 'passed' && JSON.stringify(record).includes(`${base}/p/9`), JSON.stringify(step(record, 'save')?.output ?? {}).slice(0, 300));
    const rows = await h.editor.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('blockflow');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return new Promise((resolve) => {
        const get = db.transaction('datasets').objectStore('datasets').get('e2e-products');
        get.onsuccess = () => resolve(get.result?.rows ?? []);
      });
    });
    check('IndexedDB dataset holds 9 rows', rows.length === 9 && rows[8].price === '$90', JSON.stringify(rows.slice(-1)));
    // Playwright stores downloads under random names, so look for the CSV by its content.
    const downloads = await worker.evaluate(() => new Promise((resolve) => chrome.downloads.search({}, resolve)));
    const csv = downloads.find((item) => item.url.startsWith('data:text/csv'));
    check('CSV file downloaded', Boolean(csv) && csv.error === undefined && decodeURIComponent(csv.url).includes(`Product 9,$90,${base}/p/9`), JSON.stringify(downloads.map((item) => [item.url.slice(0, 60), item.state, item.error])));

    const noTab = workflow('table over http', [
      { id: 'get', type: 'http-request', config: { url: `${base}/table.html`, method: 'GET' } },
      { id: 'table', type: 'extract-table', config: { source: 'html', html: '{{body}}', baseUrl: '{{url}}', locator: '#prices' } },
      { id: 'links', type: 'extract-list', config: { source: 'html', html: '{{body}}', baseUrl: '{{url}}', locator: '#prices tbody tr', fields: [{ name: 'link', locator: 'a', attribute: 'href' }] } },
      { id: 'total', type: 'transform', config: { values: [{ name: 'total', expression: "sum(pluck(rows, 'Price'))" }] } },
      { id: 'check', type: 'assert', config: { subject: 'value', value: '{{total}}', operator: 'equals', expected: '70' } },
    ]);
    const tableRun = await run(noTab);
    check('HTTP + Extract Table/List from HTML without a tab (offscreen parser)', tableRun.status === 'passed', summary(tableRun));
    check('relative links resolved against the page address', JSON.stringify(step(tableRun, 'links')?.output ?? {}).includes(`${base}/p/kettle`));

    const feed = workflow('infinite feed', [
      { id: 'open', type: 'open-url', config: { url: `${base}/feed.html`, active: false } },
      { id: 'down', type: 'scroll', config: { to: 'end', maxScrolls: 15, pauseMs: 600 } },
      { id: 'posts', type: 'extract-list', config: { locator: 'article.post' } },
      { id: 'count', type: 'assert', config: { subject: 'value', value: '{{count}}', operator: 'equals', expected: '40' } },
      { id: 'close', type: 'close-tab' },
    ]);
    const feedRun = await run(feed);
    check('scrolled an infinite list to the end (40 posts)', feedRun.status === 'passed', summary(feedRun));

    const dataDriven = workflow('data-driven login', [
      { id: 'data', type: 'data-table', config: { text: `email,password\ngood@test.dev,${PASSWORD}\nbad@test.dev,wrong` } },
      { id: 'each', type: 'for-each', config: { list: 'rows', as: 'row' } },
      { id: 'open', type: 'open-url', config: { url: `${base}/login.html`, active: false } },
      { id: 'form', type: 'fill-form', config: { fields: [{ locator: 'label=Email', value: '{{row.email}}' }, { locator: 'label=Password', value: '{{row.password}}' }], submit: 'role=button[name="Sign in"]' } },
      { id: 'settle', type: 'wait-for', config: { mode: 'load' } },
      { id: 'heading', type: 'read-element', config: { locator: 'h1', url: '' } },
    ]);
    dataDriven.nodes.push(
      { id: 'shape', type: 'set-variable', position: { x: 1800, y: 0 }, config: { name: 'outcome', value: '{{row.email}} → {{value}}' } },
      { id: 'save', type: 'save-dataset', position: { x: 2000, y: 0 }, config: { dataset: 'e2e-logins', value: 'outcome', mode: 'append' } },
      { id: 'close', type: 'close-tab', position: { x: 2200, y: 0 }, config: {} },
      { id: 'clear', type: 'save-dataset', position: { x: 0, y: 200 }, config: { dataset: 'e2e-logins', value: '[]', mode: 'replace' } },
    );
    dataDriven.edges = [
      { id: 'a', source: 'clear', target: 'data' },
      { id: 'b', source: 'data', target: 'each' },
      { id: 'c', source: 'each', target: 'open', sourcePort: 'each' },
      { id: 'd', source: 'open', target: 'form' },
      { id: 'e', source: 'form', target: 'settle' },
      { id: 'f', source: 'settle', target: 'heading' },
      { id: 'g', source: 'heading', target: 'shape' },
      { id: 'h', source: 'shape', target: 'save' },
      { id: 'i', source: 'save', target: 'close' },
    ];
    const ddRun = await run(dataDriven);
    const outcomes = ddRun.steps.filter((s) => s.nodeId === 'shape').map((s) => s.output?.outcome);
    check('For Each ran one login per CSV row', ddRun.status === 'passed' && JSON.stringify(outcomes) === JSON.stringify(['good@test.dev → Welcome, good!', 'bad@test.dev → Sign in']), `${summary(ddRun)}\n      ${JSON.stringify(outcomes)}`);

    await h.editor.click('.bf-header .bf-tabs button:has-text("Data")');
    await h.editor.click('.bf-report-list button:has-text("e2e-products")');
    const previewRows = await h.editor.locator('.bf-data-preview tbody tr').count();
    check('Data page previews the dataset', previewRows === 9, String(previewRows));
  }
}
