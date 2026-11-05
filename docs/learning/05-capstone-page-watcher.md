# Lesson 5: Capstone, Page Watcher

> **Verified:** loaded in Chromium 141 against a local server: baseline, repeated change detection at 0.1 min,
> one reused watch tab, badge, readable error for a wrong selector, Stop clears the alarm.

Goal: a complete extension, written by you, that uses everything so far. It watches one element on a web
page and tells you when it changes. It is a small version of BlockFlow's **Watch Element** block.

Finished version: [`examples/04-page-watcher/`](examples/04-page-watcher). Try to write each file yourself
first, peek only when stuck.

## What it does

1. You enter a **page URL**, a **CSS selector** and **how often** to check.
2. A background alarm periodically opens that page in its own background tab, reads the element, and
   compares it with the last value saved in storage.
3. If it changed, the badge shows `!` and the change is added to a history list in the popup.

Parts (map them to lesson 1): popup (form + history) · service worker (alarm, check, compare) · injected
function (read the element) · storage (settings, last value, history).

## Design before code

Write this down before typing, the way you would plan a feature:

| Question | Decision |
| --- | --- |
| Who starts the watching? | The popup only *saves settings*. The worker reacts to `storage.onChanged`, so popup and worker stay decoupled (BlockFlow's editor ⇄ background works the same way). |
| What survives the worker dying? | Settings, last value, history, the watch tab's id: all in `chrome.storage.local`. |
| How do we read the page? | Load the URL in our **own background tab** (never touch the user's tabs), wait until loaded, run a function in it with `scripting.executeScript`. |
| Pages that render late (SPAs)? | Retry a few times if the element is not there yet. |
| First read? | It is the **baseline**, not a change. |

## Step 1: manifest

```json file=04-page-watcher/manifest.json
{
  "manifest_version": 3,
  "name": "Page Watcher",
  "version": "0.1.0",
  "description": "Watches one element on a page and tells you when it changes.",
  "action": { "default_popup": "popup.html" },
  "background": { "service_worker": "background.js" },
  "permissions": ["alarms", "storage", "tabs", "scripting"],
  "host_permissions": ["<all_urls>"]
}
```

Why each permission: `alarms` (schedule), `storage` (remember), `tabs` (open/navigate our watch tab),
`scripting` (run code in it), `host_permissions` (be allowed to script *that* site). Try deleting
`host_permissions` and read the error; it is a good one to recognise.

## Step 2: the worker

```js file=04-page-watcher/background.js
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
```

Things worth noticing:

- `applySettings` is called both when the user saves and at every worker start, and is safe to call
  repeatedly. Designing handlers to be **idempotent** is how you survive a worker that restarts at random.
- `setTimeout` appears (`sleep`), but only for a second or two *within one handler*, never to schedule
  work for later. That distinction is the rule in BlockFlow's `CLAUDE.md`.
- `check()` catches its own errors and writes them to storage, so the popup can show them.
  Silent failures in background code are the number one debugging misery.

## Step 3: the popup

```html file=04-page-watcher/popup.html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font: 13px system-ui, sans-serif; width: 340px; padding: 12px; }
      label { display: block; margin: 8px 0 2px; font-weight: 600; }
      input { width: 100%; box-sizing: border-box; padding: 4px 6px; }
      .row { display: flex; gap: 6px; margin-top: 10px; }
      .muted { color: #666; font-size: 12px; margin-top: 4px; }
      .error { color: #b91c1c; }
      ul { padding-left: 16px; margin: 6px 0 0; }
      li { margin-bottom: 4px; word-break: break-word; }
    </style>
  </head>
  <body>
    <label for="url">Page URL</label>
    <input id="url" type="url" placeholder="https://example.com/product" />

    <label for="selector">CSS selector</label>
    <input id="selector" placeholder="#price" />
    <div class="muted">Tip: right click the element → Inspect → right click the node → Copy → Copy selector.</div>

    <label for="minutes">Check every (minutes)</label>
    <input id="minutes" type="number" min="0.1" step="0.1" value="1" />
    <div class="muted">Published extensions: alarms cannot go below 0.5 minutes. Unpacked, anything works.</div>

    <div class="row">
      <button id="start">Start watching</button>
      <button id="stop">Stop</button>
    </div>

    <div id="status" class="muted"></div>
    <ul id="history"></ul>
    <script src="popup.js"></script>
  </body>
</html>
```

```js file=04-page-watcher/popup.js
const $ = (id) => document.getElementById(id);

async function render() {
  const { watch, status, history = [] } = await chrome.storage.local.get(['watch', 'status', 'history']);

  // Fill the form only once, so rewriting storage never overwrites what you are typing.
  if (watch && !$('url').dataset.filled) {
    $('url').value = watch.url;
    $('selector').value = watch.selector;
    $('minutes').value = watch.minutes;
    $('url').dataset.filled = '1';
  }

  const state = watch?.enabled ? 'Watching' : 'Stopped';
  if (status?.error) {
    $('status').textContent = `${state}. Last check failed: ${status.error}`;
    $('status').className = 'muted error';
  } else {
    const when = status?.at ? new Date(status.at).toLocaleTimeString() : 'never';
    $('status').textContent = `${state}. Last check ${when}${status?.value !== undefined ? `, value: "${status.value}"` : ''}`;
    $('status').className = 'muted';
  }

  const list = $('history');
  list.replaceChildren(
    ...history.map((item) => {
      const li = document.createElement('li');
      const time = new Date(item.at).toLocaleTimeString();
      li.textContent =
        item.kind === 'baseline' ? `${time}  started at "${item.to}"` : `${time}  "${item.from}" → "${item.to}"`;
      return li;
    }),
  );
}

$('start').addEventListener('click', async () => {
  await chrome.storage.local.set({
    watch: { url: $('url').value.trim(), selector: $('selector').value.trim(), minutes: Number($('minutes').value), enabled: true },
  });
});

$('stop').addEventListener('click', async () => {
  const { watch } = await chrome.storage.local.get('watch');
  if (watch) await chrome.storage.local.set({ watch: { ...watch, enabled: false } });
});

chrome.storage.onChanged.addListener(render);
chrome.action.setBadgeText({ text: '' }); // opening the popup counts as "seen"
render();
```

(Known gap, on purpose: if you change the URL or selector and press Start again, the new value is compared
with the old baseline instead of starting fresh. Fixing it properly is exercise 3.)

## Step 4: try it

You need a page that changes. Use the clock page from this repo, `docs/manual-test/clock.html`: open it in
a tab, copy its address, use selector `#now`, every 0.1 minutes. (Open it from disk with a `file://` address and enable "Allow access to file URLs" on the extension card, or serve the folder with `npx serve docs/manual-test`.)

## Checkpoint

- Start watching: "started at …" appears in history within seconds; a background tab opens and is reused
  (check there is only ever **one**).
- A few checks later, "changed" entries appear and the toolbar badge shows `!`.
- Give a wrong selector: the popup status says `Nothing on the page matches`.
- Stop: no more tab loads (watch the server log or the tab's reload spinner).
- Let the worker die (inspect it, click Stop on the service worker) and see checks continue.

## Exercises

1. **Notifications.** Add the `"notifications"` permission and call `chrome.notifications.create` when a
   change is found. Needs an `iconUrl`; make a 48px PNG.
2. **Compare differently.** Add a checkbox "ignore digits" that normalises numbers before comparing.
3. **Fix the ordering bug** noted above: make the worker, not the popup, forget `last` when `url` or
   `selector` changes (compare `changes.watch.oldValue` and `newValue` in the `onChanged` handler).
4. **Reload vs re-navigate.** Some pages update themselves and must *not* be reloaded. Add a "reload
   before each check" option, like BlockFlow's Watch Element has.
5. **Two watchers.** Store an array of watches and use one alarm per watch (alarm name = watch id). This
   is the step from "an extension" to "a platform", and BlockFlow's `timerKey.ts` is the same trick.

## What you just built vs BlockFlow

| This capstone | BlockFlow |
| --- | --- |
| One hard-coded watch | Any number of Watch Element *blocks* in any flow |
| Reports to a history list | Passes `{value, previous, url, changedAt}` to the next block (Open Tab, Notify, ...) |
| Comparison inline | `src/core/blocks/watchElement.ts` with a baseline signature (url+selector) |
| Poll tab by sleeping/polling | `src/browser/pageReader.ts`, same idea, plus a per-URL tab registry |
| Alarms only | `HybridScheduler` for sub-30s |

Next: [Lesson 6: WXT + React + TypeScript](06-wxt-react-typescript.md)
