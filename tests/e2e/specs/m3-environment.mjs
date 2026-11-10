// M3: actual CDP environment overrides/reset and explicitly origin-filtered site-data deletion.
/** @param {import('../harness.mjs').Harness} h */
export default async function (h) {
  const { base, context, check, workflow, run, step, summary, worker } = h;
  console.log('M3: environment emulation and site-data cleanup');
  await context.grantPermissions(['geolocation'], { origin: base });
  const opened = [];
  const parsed = (record, id) => {
    try { return JSON.parse(step(record, id)?.output?.value ?? 'null'); } catch { return null; }
  };
  const readEnvironment = (tabId) => worker.evaluate(async (id) => {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: id }, func: () => ({ width: innerWidth, scale: devicePixelRatio, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, userAgent: navigator.userAgent, dark: matchMedia('(prefers-color-scheme: dark)').matches, reduce: matchMedia('(prefers-reduced-motion: reduce)').matches, online: navigator.onLine }) });
    return injection.result;
  }, tabId);
  try {
    const emulated = await run(workflow('M3 emulate device and location', [
      { id: 'open', type: 'open-url', config: { url: `${base}/geo.html`, active: false } },
      { id: 'baseline', type: 'read-element', config: { locator: '#state', url: '' } },
      { id: 'set', type: 'emulate', config: { device: 'iphone', timezone: 'Pacific/Auckland', locale: 'fr-FR', latitude: '23.8103', longitude: '90.4125', colorScheme: 'dark', reducedMotion: 'reduce' } },
      { id: 'reload', type: 'navigate', config: { action: 'reload' } },
      { id: 'read', type: 'click', config: { locator: '#read' } },
      { id: 'state', type: 'read-element', config: { locator: '#state', url: '' } },
      { id: 'locate', type: 'click', config: { locator: '#locate' } },
      { id: 'position', type: 'wait-for', config: { mode: 'text', text: '23.8103' } },
      { id: 'location', type: 'read-element', config: { locator: '#location', url: '' } },
    ]));
    const tabId = step(emulated, 'open')?.output?.tabId; opened.push(tabId);
    const state = parsed(emulated, 'state'); const baseline = parsed(emulated, 'baseline'); const location = parsed(emulated, 'location');
    check('Emulate: mobile viewport, pixel ratio and user agent', emulated.status === 'passed' && state?.width === 390 && state?.scale === 3 && /iPhone/.test(state?.userAgent ?? ''), `${JSON.stringify(state)} ${summary(emulated)}`);
    check('Emulate: locale, timezone and media preferences', state?.locale === 'fr-FR' && state?.timezone === 'Pacific/Auckland' && state?.dark === true && state?.reduce === true, JSON.stringify(state));
    check('Emulate: coordinates with site permission already granted', Math.abs(location?.latitude - 23.8103) < .0001 && Math.abs(location?.longitude - 90.4125) < .0001, JSON.stringify(location));
    // Playwright keeps its own light-scheme/viewport overrides on every page; our run-end reset clears
    // those too until the page reloads (then Playwright reapplies them). Overrides we left attached would
    // survive a reload, so compare after one.
    await worker.evaluate(async (id) => {
      await chrome.tabs.reload(id);
      for (let i = 0; i < 50 && (await chrome.tabs.get(id)).status !== 'complete'; i += 1) await new Promise((r) => setTimeout(r, 100));
    }, tabId);
    const reset = await readEnvironment(tabId);
    check('Emulate: run completion resets viewport, UA, timezone and media', reset.width === baseline?.width && reset.scale === baseline?.scale && reset.userAgent === baseline?.userAgent && reset.timezone === baseline?.timezone && reset.dark === baseline?.dark && reset.reduce === baseline?.reduce, `${JSON.stringify({ baseline, reset })}`);

    const offline = await run(workflow('M3 offline and explicit clear', [
      { id: 'open', type: 'open-url', config: { url: `${base}/geo.html`, active: false } },
      { id: 'offline', type: 'emulate', config: { offline: true } },
      { id: 'fetch', type: 'click', config: { locator: '#network' } },
      { id: 'wait', type: 'wait-for', config: { mode: 'text', locator: '#network-result', text: 'offline' } },
      { id: 'result', type: 'read-element', config: { locator: '#network-result', url: '' } },
      { id: 'clear', type: 'emulate', config: { action: 'clear' } },
      { id: 'fetch2', type: 'click', config: { locator: '#network' } },
      { id: 'wait2', type: 'wait-for', config: { mode: 'text', locator: '#network-result', text: 'online' } },
      { id: 'result2', type: 'read-element', config: { locator: '#network-result', url: '' } },
    ]));
    opened.push(step(offline, 'open')?.output?.tabId);
    check('Emulate: offline blocks network, explicit clear restores it', offline.status === 'passed' && step(offline, 'result')?.output?.value === 'offline' && step(offline, 'result2')?.output?.value === 'online', summary(offline));

    const failed = await run(workflow('M3 failed run resets environment', [
      { id: 'open', type: 'open-url', config: { url: `${base}/geo.html`, active: false } },
      { id: 'set', type: 'emulate', config: { width: 450, height: 700, timezone: 'Pacific/Auckland', offline: true } },
      { id: 'fail', type: 'assert', config: { subject: 'value', value: 'no', operator: 'equals', expected: 'yes' }, step: { screenshot: 'never' } },
    ]));
    const failedTab = step(failed, 'open')?.output?.tabId; opened.push(failedTab);
    const afterFailure = await readEnvironment(failedTab);
    check('Emulate: failure also restores online state and timezone', failed.status === 'failed' && afterFailure.online === true && afterFailure.timezone === baseline?.timezone, `${JSON.stringify(afterFailure)} ${summary(failed)}`);

    const cleared = await run(workflow('M3 clear only named site data', [
      { id: 'open', type: 'open-url', config: { url: `${base}/geo.html`, active: false } },
      { id: 'seed', type: 'click', config: { locator: '#seed' } },
      { id: 'ready', type: 'wait-for', config: { mode: 'text', text: 'saved' } },
      { id: 'clear', type: 'clear-site-data', config: { origins: base } },
      { id: 'reload', type: 'navigate', config: { action: 'reload' } },
      { id: 'inspect', type: 'click', config: { locator: '#storage' } },
      { id: 'checked', type: 'wait-for', config: { mode: 'text', text: 'database' } },
      { id: 'stored', type: 'read-element', config: { locator: '#stored', url: '' } },
    ]));
    opened.push(step(cleared, 'open')?.output?.tabId);
    const stored = parsed(cleared, 'stored');
    check('Clear Site Data: cookies, localStorage, IndexedDB and Cache Storage removed', cleared.status === 'passed' && stored?.local === null && stored?.cookie === false && stored?.cache === false && stored?.database === false, `${JSON.stringify(stored)} ${summary(cleared)}`);
    check('Clear Site Data: reports exact origins and preserves extension run data', JSON.stringify(step(cleared, 'clear')?.output?.clearedOrigins) === JSON.stringify([base]) && Boolean((await worker.evaluate(() => chrome.storage.local.get('bf:runs')))['bf:runs']?.length), summary(cleared));
  } finally {
    await context.clearPermissions();
    for (const tabId of opened.filter(Number.isInteger)) await worker.evaluate((id) => chrome.tabs.remove(id).catch(() => {}), tabId);
  }
}
