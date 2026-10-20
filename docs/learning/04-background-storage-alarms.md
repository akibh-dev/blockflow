# Lesson 4: Background worker, storage and alarms

> **Verified:** loaded in Chromium 141. The count rose at 30s; with the service worker force-stopped, the next alarm
> restarted it (`starts` went 1 → 2) and the count kept growing. Unpacked alarms of 0.1 minutes (6s) also fire.

Goal: code that keeps running "in the background" even though the browser keeps killing it. This is the
single most important lesson for automation extensions.

You will learn: the service worker lifecycle, `chrome.storage`, `chrome.alarms`, the badge, and why
BlockFlow stores *everything* outside memory.

Finished version: [`examples/03-ticker/`](examples/03-ticker).

## The service worker, honestly

The `background.service_worker` file is not a server that stays up. The browser:

1. **starts** it when an event it listens for happens (alarm, message, click, install...),
2. runs your handlers,
3. **stops it** after roughly 30 seconds with nothing to do, and throws away all variables and timers.

So this is a bug that looks fine for the first minute:

```js
let count = 0;
setInterval(() => { count++; }, 1000); // dies when the worker is stopped; count resets to 0
```

The cure is three habits:

| Habit | Tool |
| --- | --- |
| Remember things in storage, not variables | `chrome.storage.local` |
| Do things later with alarms, not timers | `chrome.alarms` |
| Register event listeners **at the top level**, synchronously | so a restarted worker is wired up before its event is delivered |

(Top-level matters: if you register a listener inside an `await` or a callback, the event that woke the
worker can arrive before your listener exists, and is lost.)

## Step 1: manifest

```json file=03-ticker/manifest.json
{
  "manifest_version": 3,
  "name": "Ticker",
  "version": "0.1.0",
  "description": "Counts every 30 seconds, even though the worker keeps being stopped.",
  "action": { "default_popup": "popup.html" },
  "background": { "service_worker": "background.js" },
  "permissions": ["alarms", "storage"]
}
```

## Step 2: the worker

```js file=03-ticker/background.js
const ALARM = 'tick';

// Alarms can be forgotten (browser restart, update), so make sure it exists every time the worker starts.
async function ensureAlarm() {
  if (!(await chrome.alarms.get(ALARM))) {
    // 0.5 minutes = 30 seconds, the smallest period a published extension may use.
    await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  }
}

// Top-level, synchronous listener registration (see "three habits").
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  // Never keep the count in a variable: read it from storage, change it, write it back.
  const { count = 0 } = await chrome.storage.local.get('count');
  await chrome.storage.local.set({ count: count + 1, lastTickAt: Date.now() });
  await chrome.action.setBadgeText({ text: String(count + 1) });
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ count: 0 });
  await ensureAlarm();
});

// Runs every time the worker starts. Count how often that is, to SEE the lifecycle.
(async () => {
  const { starts = 0 } = await chrome.storage.local.get('starts');
  await chrome.storage.local.set({ starts: starts + 1 });
  await ensureAlarm();
})();
```

`chrome.storage.local` is a small async key/value store (about 10 MB, more with `unlimitedStorage`) shared
by every part of your extension. It is `localStorage` that works in workers, is async, stores objects, and
survives the worker being stopped. (`chrome.storage.session` is the same but cleared when the browser
closes; `chrome.storage.sync` roams with the user's account but is small.)

## Step 3: a popup that reads storage live

```html file=03-ticker/popup.html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font: 14px system-ui, sans-serif; width: 220px; padding: 12px; }
      .big { font-size: 32px; font-weight: 600; }
      .muted { color: #666; font-size: 12px; }
    </style>
  </head>
  <body>
    <div class="big" id="count">0</div>
    <div class="muted" id="last">no tick yet</div>
    <div class="muted" id="starts"></div>
    <button id="reset">Reset</button>
    <script src="popup.js"></script>
  </body>
</html>
```

```js file=03-ticker/popup.js
async function render() {
  const { count = 0, lastTickAt, starts = 0 } = await chrome.storage.local.get(['count', 'lastTickAt', 'starts']);
  document.getElementById('count').textContent = String(count);
  document.getElementById('last').textContent = lastTickAt
    ? `last tick ${Math.round((Date.now() - lastTickAt) / 1000)}s ago`
    : 'no tick yet (wait up to 30s)';
  document.getElementById('starts').textContent = `worker has started ${starts} time(s)`;
}

// Storage is the shared "database": when the worker writes, every open popup hears about it.
chrome.storage.onChanged.addListener(render);

document.getElementById('reset').addEventListener('click', async () => {
  await chrome.storage.local.set({ count: 0 });
  await chrome.action.setBadgeText({ text: '' });
});

render();
```

## Checkpoint

1. Load it. Wait a minute. The badge counts up every 30 seconds and the popup shows it.
2. On `chrome://extensions`, click the **service worker** link on the card to open its DevTools; later the
   link will say "(inactive)": the worker was stopped. Yet the badge keeps counting. Open the popup: "worker
   has started N time(s)" with N greater than 1. The count survived because it lives in storage.
3. Stop it by hand: DevTools → Application → Service workers → **Stop**. The next alarm wakes it again.

## Alarm facts you need

- Published extensions: minimum period **30 seconds**. Unpacked extensions are exempt (BlockFlow's test
  run used 5-second timers this way). Alarms can fire late, do not wake a sleeping laptop, and can be lost
  on restart, hence `ensureAlarm()` on every start.
- You can have many alarms; each has a **name**, which is how BlockFlow encodes
  `workflow::block::timer` into one string.
- `periodInMinutes` repeats; `delayInMinutes` / `when` give the first firing; a one-shot has neither period.

## "But I want a 5 second timer"

Alarms cannot do it (published limit), and a plain `setInterval` dies with the worker. BlockFlow's answer
is the hybrid scheduler in `src/browser/hybridScheduler.ts`: short timers run as in-memory `setTimeout`s,
and while any is armed a cheap `chrome.runtime.getPlatformInfo()` call every 20 seconds counts as activity
and stops the worker idling out. An alarm still exists as a 30-second heartbeat that wakes a worker that
died anyway, and re-arms the timers from storage. Read the file once you finish lesson 5; it is about 250
lines and fully unit-tested with a fake clock.

Trade-off, stated honestly: Chrome discourages keeping workers alive artificially, and it costs battery.
We accept that for a feature whose whole point is short timers, and it is only active while such a workflow
is enabled. It is documented in the project README.

## Exercises

1. Make the badge show the number of ticks *since the browser started* (hint: `chrome.storage.session`).
2. Add a second alarm, `'minute'`, with period 1, which stores `lastMinuteAt`. Give each alarm its own branch.
3. Break it on purpose: replace the alarm with `setInterval(…, 30000)` and watch the count stall once the
   worker is stopped. Then fix it again. You now own this lesson.
4. Make `onInstalled` not reset the count when the reason is `'update'` (the handler receives `details.reason`).

## In BlockFlow

- Open `src/entrypoints/background.ts`: every listener is registered at the top, synchronously; there are
  no module-level variables holding workflow state; `scheduler.restoreAll()` runs at each worker start.
- `src/core/timerKey.ts` is the alarm-name encoding; `src/browser/stores.ts` is the storage wrapper.

Next: [Lesson 5: Capstone, Page Watcher](05-capstone-page-watcher.md)
