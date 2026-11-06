// e2e checks for blocks that had none (IMPLEMENTATION §M0.3): Start, Timer, Schedule, Context Menu,
// Watch Element, Navigate, Press Key, Page Info, Stop, Repeat, Filter, Notify.
// Run alone with `npm run e2e -- blocks-coverage`. `h` is the shared harness (tests/e2e/harness.mjs).
// Fixtures: tests/fixtures/site/{meta,keys,ticker,spa}.html.

/** @param {import('../harness.mjs').Harness} h */
export default async function (h) {
  const { base, check, run, seedWorkflows, step, summary, worker, workflow } = h;

  /** Every run record of workflow `id` in `bf:runs`. */
  const runsOf = async (id) => ((await worker.evaluate(() => chrome.storage.local.get('bf:runs')))['bf:runs'] ?? []).filter((record) => record.workflowId === id);
  /**
   * Whether right-click menu item `id` exists. There is no contextMenus.getAll, and `update` on a missing
   * id does not fail in every Chromium, but creating a duplicate id always does (a probe that did get
   * created is removed again).
   */
  const menuItemExists = (id) =>
    worker.evaluate(
      (itemId) =>
        new Promise((resolve) => {
          chrome.contextMenus.create({ id: itemId, title: 'probe' }, () => {
            const duplicate = /duplicate/i.test(chrome.runtime.lastError?.message ?? '');
            if (duplicate) resolve(true);
            else chrome.contextMenus.remove(itemId, () => resolve(false));
          });
        }),
      id,
    );
  /** Polls `probe` every 250 ms until it returns something truthy (returned), or `ms` pass (returns undefined). */
  async function waitUntil(probe, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return undefined;
  }

  {
    console.log('Start: starting values, and as a called workflow (the caller\'s values win)');
    const callee = workflow('Start values', [
      { id: 'st', type: 'start', config: { inputs: [{ name: 'email', value: 'default@x.co' }, { name: 'plan', value: 'free' }] } },
      { id: 'l', type: 'log', config: { message: '{{email}}/{{plan}}' } },
    ]);
    const own = await run(callee);
    check('Start gives its values on Run', own.status === 'passed' && step(own, 'l')?.output?.email === 'default@x.co' && step(own, 'l')?.output?.plan === 'free', summary(own));

    const caller = workflow('Start caller', [
      { id: 'v', type: 'set-variable', config: { name: 'email', value: 'given@x.co' } },
      { id: 'c', type: 'run-workflow', config: { workflow: callee.id } },
    ]);
    await seedWorkflows([callee, caller]);
    const record = await run(caller);
    const child = (await runsOf(callee.id)).find((candidate) => candidate.parentRunId === record.id);
    const out = child && step(child, 'l')?.output;
    check('called workflow: caller value wins, the other default stays', record.status === 'passed' && out?.email === 'given@x.co' && out?.plan === 'free', JSON.stringify(out ?? child ?? record.error));
  }

  {
    console.log('Timer: in-run delay, Stop during a delay, repeating trigger');
    const delay = workflow('delay', [
      { id: 'a', type: 'log', config: { message: 'before' } },
      { id: 't', type: 'timer', config: { seconds: 3 } },
      { id: 'b', type: 'log', config: { message: 'after' } },
    ]);
    const started = Date.now();
    const record = await run(delay);
    const tookMs = Date.now() - started;
    check('a 3 s delay waits inside the run, then goes on', record.status === 'passed' && step(record, 'b')?.status === 'passed' && tookMs >= 2_800, `${tookMs} ms · ${summary(record)}`);
    check('the delay sets firedAt', typeof step(record, 't')?.output?.firedAt === 'string');

    // (A Timer with nothing before it would start the flow at once on Run; after a block it delays.)
    const long = workflow('stop during delay', [
      { id: 'a', type: 'log', config: { message: 'before' } },
      { id: 't', type: 'timer', config: { seconds: 30 } },
      { id: 'b', type: 'log', config: { message: 'should not run' } },
    ]);
    await h.editor.evaluate((w) => chrome.runtime.sendMessage({ type: 'bf:run-workflow', workflow: w }), long);
    const live = await waitUntil(async () => (await runsOf(long.id)).find((candidate) => candidate.status === 'running'), 10_000);
    const stopAt = Date.now();
    if (live) await h.editor.evaluate((runId) => chrome.runtime.sendMessage({ type: 'bf:stop-run', runId }), live.id);
    const ended = await waitUntil(async () => (await runsOf(long.id)).find((candidate) => candidate.status !== 'running'), 10_000);
    check('Stop ends a run that is waiting in a delay (within a few seconds)', ended?.status === 'cancelled' && !step(ended, 'b') && Date.now() - stopAt < 5_000, JSON.stringify(ended ?? live ?? 'no run'));

    const ticking = { ...workflow('every 2s', [
      { id: 't', type: 'timer', config: { seconds: 2, repeat: true } },
      { id: 'l', type: 'log', config: { message: 'tick {{tick}}' } },
    ]), enabled: true };
    await seedWorkflows([ticking]);
    const ticks = await waitUntil(async () => {
      const runs = (await runsOf(ticking.id)).filter((candidate) => candidate.trigger === 'timer' && candidate.status === 'passed');
      return runs.length >= 2 ? runs : undefined;
    }, 15_000);
    check('a repeating 2 s Timer starts runs on its own', Boolean(ticks), JSON.stringify((await runsOf(ticking.id)).map((r) => [r.trigger, r.status])));
    check('…counting ticks', ticks ? step(ticks[0], 't')?.output?.tick === 1 && step(ticks[1], 't')?.output?.tick === 2 : false, JSON.stringify(ticks?.map((r) => step(r, 't')?.output)));
    await seedWorkflows([]);
  }

  {
    console.log('Schedule: switching a workflow on creates an alarm for the next time');
    const now = new Date();
    const target = new Date(now.getTime() + 10 * 60_000);
    target.setSeconds(0, 0);
    const at = `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`;
    const scheduled = { ...workflow('scheduled', [
      { id: 's', type: 'schedule', config: { every: 'day', at, days: 'every day' } },
      { id: 'l', type: 'log', config: { message: 'scheduled run' } },
    ]), enabled: true };
    await seedWorkflows([scheduled]);
    const name = `bf::${scheduled.id}::s::next`;
    // The alarm's `when` is now + delay, so it can be a few ms off the planned minute.
    const alarm = await waitUntil(async () => (await worker.evaluate(() => chrome.alarms.getAll())).find((candidate) => candidate.name === name), 10_000);
    check(`alarm ${name} is set for ${at} today/tomorrow`, Math.abs((alarm?.scheduledTime ?? 0) - target.getTime()) < 2_000 && !alarm.periodInMinutes, JSON.stringify(alarm ?? (await worker.evaluate(() => chrome.alarms.getAll()))));
    await seedWorkflows([]);
    const cleared = await waitUntil(async () => !(await worker.evaluate(() => chrome.alarms.getAll())).some((candidate) => candidate.name === name), 10_000);
    check('switching it off clears the alarm', Boolean(cleared));
  }

  {
    console.log('Context Menu: the item exists; choosing it runs the flow on that tab');
    const menu = { ...workflow('menu', [
      { id: 'm', type: 'context-menu', config: { title: 'Save this product', contexts: 'all' } },
      { id: 'r', type: 'read-element', config: { selector: 'h1', url: '' } }, // the v1 key name: migrated on load (core/migrate.ts)
    ]), schemaVersion: 1, enabled: true };
    await seedWorkflows([menu]);
    const itemId = `bf-menu::${menu.id}::m`;
    const exists = await waitUntil(() => menuItemExists(itemId), 10_000);
    check('the right-click menu item was created', Boolean(exists));

    const page = await h.context.newPage();
    await page.goto(`${base}/meta.html`);
    const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id, `${base}/meta.html`);
    // The e2e build's stand-in for contextMenus.onClicked (background.ts, BF_E2E only).
    await h.editor.evaluate(
      ([id, url, tab]) => chrome.runtime.sendMessage({ type: 'bf:e2e-menu-click', menuItemId: id, info: { pageUrl: url, selectionText: 'Blue' }, tabId: tab }),
      [itemId, `${base}/meta.html`, tabId],
    );
    const clicked = await waitUntil(async () => (await runsOf(menu.id)).find((candidate) => candidate.status !== 'running'), 15_000);
    check('choosing the item ran the flow on the right-clicked tab', clicked?.trigger === 'event' && clicked.status === 'passed' && step(clicked, 'r')?.output?.value === 'Blue Mug', clicked ? summary(clicked) : 'no run');
    check('…with the selection in its data', step(clicked ?? { steps: [] }, 'm')?.output?.selection === 'Blue');
    await page.close();
    await seedWorkflows([]);
    const removed = await waitUntil(async () => !(await menuItemExists(itemId)), 10_000);
    check('switching it off removes the item', Boolean(removed));
  }

  {
    console.log('Watch Element: notices a change on a page that updates itself');
    const watch = { ...workflow('watch ticker', [
      { id: 'w', type: 'watch-element', config: { locator: '#price', url: `${base}/ticker.html`, intervalSeconds: 2, reload: false } },
      { id: 'l', type: 'log', config: { message: '{{previous}} → {{value}}' } },
    ]), enabled: true };
    await seedWorkflows([watch]);
    const changed = await waitUntil(async () => (await runsOf(watch.id)).find((candidate) => candidate.status === 'passed' && step(candidate, 'l')), 20_000);
    const out = changed && step(changed, 'w')?.output;
    check('a change started a run with the old and new value', Boolean(out) && Number(out.value) > Number(out.previous) && Number(out.previous) >= 100, JSON.stringify(out ?? (await runsOf(watch.id)).map(summary)));
    await seedWorkflows([]);
    // Close the watch tab so it stops ticking in the background.
    await worker.evaluate(async (url) => {
      for (const tab of await chrome.tabs.query({})) if (tab.url === url && tab.id !== undefined) await chrome.tabs.remove(tab.id);
    }, `${base}/ticker.html`);
  }

  {
    console.log('Navigate: goto, reload, back, forward on spa.html');
    const record = await run(workflow('navigate', [
      { id: 'open', type: 'open-url', config: { url: `${base}/spa.html`, active: false } },
      { id: 'goto', type: 'navigate', config: { action: 'goto', url: `${base}/spa/two` } },
      { id: 'reload', type: 'navigate', config: { action: 'reload' } },
      { id: 'here', type: 'assert', config: { subject: 'url', operator: 'contains', expected: '/spa/two' } },
      { id: 'back', type: 'navigate', config: { action: 'back' } },
      { id: 'fwd', type: 'navigate', config: { action: 'forward' } },
      { id: 'close', type: 'close-tab' },
    ]));
    const url = (id) => step(record, id)?.output?.url;
    check('goto and reload land on the page', record.status === 'passed' && url('goto') === `${base}/spa/two` && url('reload') === `${base}/spa/two`, summary(record));
    check('back and forward land on the previous and next page', url('back') === `${base}/spa.html` && url('fwd') === `${base}/spa/two`, JSON.stringify([url('back'), url('fwd'), step(record, 'back')?.error]));
  }

  {
    console.log('Press Key: Enter submits, Control+A selects');
    const record = await run(workflow('keys', [
      { id: 'open', type: 'open-url', config: { url: `${base}/keys.html`, active: false } },
      { id: 'type', type: 'fill', config: { locator: 'label=Search', value: 'blue mug' } },
      { id: 'all', type: 'press-key', config: { key: 'Control+A', locator: 'label=Search' } },
      { id: 'sel', type: 'wait-for', config: { mode: 'text', text: 'selected 8 of 8' }, step: { timeoutSeconds: 5, onError: 'continue' } },
      { id: 'read1', type: 'read-element', config: { locator: '#status', url: '' } },
      { id: 'enter', type: 'press-key', config: { key: 'Enter', locator: 'label=Search' } },
      { id: 'sub', type: 'wait-for', config: { mode: 'text', text: 'submitted: blue mug' }, step: { timeoutSeconds: 5, onError: 'continue' } },
      { id: 'read2', type: 'read-element', config: { locator: '#status', url: '' } },
      { id: 'close', type: 'close-tab' },
    ]));
    check('Control+A selected the whole field', step(record, 'sel')?.status === 'passed', String(step(record, 'read1')?.output?.value));
    check('Enter submitted the form', step(record, 'sub')?.status === 'passed', String(step(record, 'read2')?.output?.value));
  }

  {
    console.log('Page Info: title, meta, JSON-LD; localStorage, sessionStorage, cookies');
    const record = await run(workflow('page info', [
      { id: 'open', type: 'open-url', config: { url: `${base}/meta.html`, active: false } },
      { id: 'page', type: 'page-info', config: { area: 'page' } },
      { id: 'theme', type: 'page-info', config: { area: 'local', key: 'theme' } },
      { id: 'local', type: 'page-info', config: { area: 'local' } },
      { id: 'session', type: 'page-info', config: { area: 'session', key: 'visit' } },
      { id: 'cookies', type: 'page-info', config: { area: 'cookies' } },
      { id: 'close', type: 'close-tab' },
    ]));
    const page = step(record, 'page')?.output?.page;
    check('run passed', record.status === 'passed', summary(record));
    check('title, description, canonical, lang', page?.title === 'Fixture: Blue Mug | Shop' && page.description === 'A blue mug that holds 350 ml.' && page.canonical === `${base}/products/blue-mug` && page.lang === 'en-GB', JSON.stringify(page));
    check('meta tags and JSON-LD (bad JSON-LD skipped)', page?.meta?.['og:type'] === 'product' && page.jsonLd?.length === 1 && page.jsonLd[0].offers?.price === '12.50' && page.links === 2, JSON.stringify(page));
    check('localStorage: one key, and all keys', step(record, 'theme')?.output?.value === 'dark' && step(record, 'local')?.output?.value?.cart === '["mug"]' && Object.keys(step(record, 'local')?.output?.value ?? {}).length === 2, JSON.stringify([step(record, 'theme')?.output?.value, step(record, 'local')?.output?.value]));
    check('sessionStorage', step(record, 'session')?.output?.value === '1', JSON.stringify(step(record, 'session')?.output?.value));
    const cookies = step(record, 'cookies')?.output?.value;
    check('cookies', cookies?.currency === 'GBP' && cookies?.consent === 'yes', JSON.stringify(cookies));
  }

  {
    console.log('Stop: pass and fail outcomes');
    const pass = await run(workflow('stop pass', [
      { id: 's', type: 'stop', config: { outcome: 'pass', message: 'nothing to do' } },
      { id: 'l', type: 'log', config: { message: 'after' } },
    ]));
    check('pass: run passed, nothing after it ran', pass.status === 'passed' && step(pass, 's')?.status === 'passed' && !step(pass, 'l'), summary(pass));
    const fail = await run(workflow('stop fail', [
      { id: 'v', type: 'set-variable', config: { name: 'price', value: '120' } },
      { id: 's', type: 'stop', config: { outcome: 'fail', message: 'Price {{price}} too high' } },
    ]));
    check('fail: run failed with the message', fail.status === 'failed' && String(fail.error).endsWith('Price 120 too high'), `${fail.status}: ${fail.error}`);
  }

  {
    console.log('Repeat and Filter: small data flows');
    const record = await run(workflow('repeat filter', [
      { id: 'd', type: 'data-table', config: { text: 'name,price\nmug,12\nlamp,80\npen,3', into: 'items' } },
      { id: 'f', type: 'filter', config: { list: 'items', left: '{{item.price}}', operator: 'less', right: '50', into: 'cheap' } },
      { id: 'r', type: 'repeat', config: { times: 3 } },
      { id: 'each', type: 'log', config: { message: 'round {{iteration}}' } },
      { id: 'done', type: 'log', config: { message: '{{cheap}}' } },
    ], [['d', 'f'], ['f', 'r'], ['r', 'each', 'each'], ['r', 'done', 'done']]));
    const rounds = record.steps.filter((s) => s.nodeId === 'each').map((s) => s.output?.iteration);
    check('Repeat ran "each" 3 times, then "done"', JSON.stringify(rounds) === '[1,2,3]' && step(record, 'done')?.status === 'passed', summary(record));
    const cheap = step(record, 'f')?.output?.cheap;
    check('Filter kept the items under 50', Array.isArray(cheap) && cheap.map((item) => item.name).join() === 'mug,pen', JSON.stringify(cheap));
  }

  {
    console.log('Notify: a notification is created');
    await worker.evaluate(async () => {
      for (const id of Object.keys(await chrome.notifications.getAll())) await chrome.notifications.clear(id);
    });
    const record = await run(workflow('notify', [{ id: 'n', type: 'notify', config: { title: 'BlockFlow e2e', message: 'hello' } }]));
    const shown = await worker.evaluate(() => chrome.notifications.getAll());
    check('run passed with notified: true', record.status === 'passed' && step(record, 'n')?.output?.notified === true, summary(record));
    check('chrome.notifications has it', Object.keys(shown).length >= 1, JSON.stringify(shown));
    await worker.evaluate(async () => {
      for (const id of Object.keys(await chrome.notifications.getAll())) await chrome.notifications.clear(id);
    });
  }
}
