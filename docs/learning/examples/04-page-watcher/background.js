const ALARM = 'check';
const HISTORY_LIMIT = 20;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const get = (keys) => chrome.storage.local.get(keys);

// ---- wiring: top-level, synchronous ---------------------------------------------------------

// The popup saves settings; we react. No direct popup → worker calls needed.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.watch) {
    applySettings(changes.watch.newValue).catch(report);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) check().catch(report);
});

// Alarms can be lost (restart, update): re-create from the saved settings on every worker start.
(async () => {
  const { watch } = await get('watch');
  await applySettings(watch, { checkNow: false });
})().catch(report);

// ---- settings → alarm ---------------------------------------------------------------------------

async function applySettings(watch, { checkNow = true } = {}) {
  const existing = await chrome.alarms.get(ALARM);
  if (!watch?.enabled) {
    if (existing) await chrome.alarms.clear(ALARM);
    return;
  }
  const period = Number(watch.minutes);
  // Re-create only when needed, so a worker restart does not push the next check further away.
  if (!existing || existing.periodInMinutes !== period || checkNow) {
    await chrome.alarms.create(ALARM, { delayInMinutes: period, periodInMinutes: period });
  }
  if (checkNow) await check(); // first read right away: it becomes the baseline
}

// ---- one check ----------------------------------------------------------------------------------

let checking = false; // only a guard against overlapping checks; losing it when the worker dies is harmless

async function check() {
  if (checking) return;
  checking = true;
  try {
    const { watch } = await get('watch');
    if (!watch?.enabled) return;

    const tabId = await openWatchTab(watch.url);
    const value = await readElement(tabId, watch.selector);
    await recordResult(value);
  } catch (error) {
    await chrome.storage.local.set({ status: { at: Date.now(), error: String(error?.message ?? error) } });
  } finally {
    checking = false;
  }
}

/** Reuses one background tab of our own (id kept in storage) and navigates it to the URL. */
async function openWatchTab(url) {
  const { watchTabId } = await get('watchTabId');
  let tabId;
  if (watchTabId !== undefined) {
    try {
      tabId = (await chrome.tabs.update(watchTabId, { url })).id; // same URL = a fresh load
    } catch {
      tabId = undefined; // the user closed it
    }
  }
  if (tabId === undefined) {
    tabId = (await chrome.tabs.create({ url, active: false })).id;
    await chrome.storage.local.set({ watchTabId: tabId });
  }
  await waitForLoad(tabId);
  return tabId;
}

async function waitForLoad(tabId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  await sleep(150); // let the navigation actually begin, otherwise we may see the OLD page as "complete"
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await sleep(250);
  }
  throw new Error('The page did not finish loading');
}

/** Runs a function INSIDE the page. It is copied there, so it can only use what we pass in `args`. */
async function readElement(tabId, selector, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [selector],
      func: (sel) => {
        const el = document.querySelector(sel);
        return el ? el.textContent.trim() : null;
      },
    });
    if (result !== null) return result;
    await sleep(1000); // single-page apps render late: try again
  }
  throw new Error(`Nothing on the page matches "${selector}"`);
}

// ---- compare, remember, tell the user -------------------------------------------------------------

async function recordResult(value) {
  const { last, history = [] } = await get(['last', 'history']);
  const at = Date.now();
  const entry =
    last === undefined
      ? { at, kind: 'baseline', to: value }
      : last !== value
        ? { at, kind: 'changed', from: last, to: value }
        : null;

  const update = { last: value, status: { at, value } };
  if (entry) update.history = [entry, ...history].slice(0, HISTORY_LIMIT);
  await chrome.storage.local.set(update);

  if (entry?.kind === 'changed') await chrome.action.setBadgeText({ text: '!' });
}

function report(error) {
  console.error('[Page Watcher]', error);
}
