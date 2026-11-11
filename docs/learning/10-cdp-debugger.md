# Lesson 10: Driving a page with the Chrome DevTools Protocol

Goal: a popup with two buttons that click a button on a web page, once the way a script does and once the way
a real mouse does, and show the page's own report of which one it received.
You will learn: the `debugger` permission, `chrome.debugger.attach` / `sendCommand`, the protocol's shape
(methods, domains), `Runtime.evaluate`, `Input.dispatchMouseEvent`, and why `isTrusted` matters.
Finished version: [examples/06-cdp-click](examples/06-cdp-click)

## The problem, in web-dev terms

In lesson 3 a content script clicked a button with `element.click()` or `dispatchEvent`. The page cannot tell
who did it, except for one thing: `event.isTrusted`. Events made by JavaScript are `isTrusted: false`; events
from a real mouse or keyboard are `true`. Sites that check it (some payment forms, anti-bot code, `<input
type=file>` pickers, drag libraries) ignore the fake ones.

Playwright and Puppeteer get real input by speaking the **Chrome DevTools Protocol (CDP)** to the browser: the
same protocol the DevTools window uses. A browser extension can speak it too, through `chrome.debugger`.

| You know | CDP version |
| --- | --- |
| DevTools → Elements → "Break on…" | a *session* attached to one tab |
| `fetch('/api/x', {method: 'POST', body})` | `sendCommand(target, 'Domain.method', params)`: JSON in, JSON out |
| `document.querySelector(...)` in the DevTools console | `Runtime.evaluate` with an expression string |
| a user moving the mouse | `Input.dispatchMouseEvent` (pressed, then released) |

The protocol is split in **domains** (`Runtime`, `Input`, `Page`, `Network`, `Emulation`, `Fetch`…). The full
list is at <https://chromedevtools.github.io/devtools-protocol/>.

## The catch: the permission and the yellow bar

`chrome.debugger` needs the `debugger` permission, which Chrome shows as a strong warning at install. While a
tab is attached Chrome shows a bar: "BlockFlow started debugging this browser". That bar is the price of real
input, so good extensions attach only while needed and detach straight after. Firefox and Safari have no
`chrome.debugger`; this lesson is Chromium only.

## Step 1: the extension

```json file=06-cdp-click/manifest.json
{
  "manifest_version": 3,
  "name": "CDP click",
  "version": "1.0",
  "permissions": ["debugger"],
  "action": { "default_popup": "popup.html" }
}
```

```html file=06-cdp-click/popup.html
<!doctype html>
<html>
  <body style="width: 300px; font-family: sans-serif">
    <p>Clicks <code>#target</code> on the current tab.</p>
    <button id="trusted">Real click (debugger)</button>
    <button id="synthetic">Synthetic click (dispatchEvent)</button>
    <pre id="out"></pre>
    <script src="popup.js"></script>
  </body>
</html>
```

The popup does everything; there is no background script. Read it top to bottom once, then type it.

```js file=06-cdp-click/popup.js
const out = document.getElementById('out');

/** The tab to act on. `popup.html?tabId=7` (used by tests, where the popup is a normal tab) wins. */
async function targetTab() {
  const wanted = Number(new URLSearchParams(location.search).get('tabId'));
  if (wanted) return wanted;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab.id;
}

/**
 * Attach the debugger, run `work(send)`, and always detach (the yellow bar goes away).
 * `send('Domain.method', params)` resolves with the protocol's `result`.
 */
async function withDebugger(tabId, work) {
  await chrome.debugger.attach({ tabId }, '1.3'); // 1.3 = protocol version
  try {
    return await work((method, params) => chrome.debugger.sendCommand({ tabId }, method, params));
  } finally {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

/** Runs an expression in the page and returns its value (`returnByValue` = JSON, not an object handle). */
async function evaluate(send, expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true });
  // `text` is just "Uncaught"; the exception object's description has the real message.
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

async function realClick(send) {
  // Where is the button? The page knows; CDP's mouse needs viewport coordinates.
  const point = await evaluate(
    send,
    `(() => { const r = document.querySelector('#target').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  // A click is two events. Both carry the button and the click count.
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }
}

async function syntheticClick(send) {
  // The lesson-3 way, run inside the page: one fake event.
  await evaluate(send, `document.querySelector('#target').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
}

async function run(click) {
  out.textContent = '…';
  try {
    const tabId = await targetTab();
    out.textContent = await withDebugger(tabId, async (send) => {
      await click(send);
      // Ask the page what it saw.
      return evaluate(send, `document.querySelector('#result')?.textContent ?? 'no #result on this page'`);
    });
  } catch (error) {
    out.textContent = `Error: ${error.message}`;
  }
}

document.getElementById('trusted').addEventListener('click', () => run(realClick));
document.getElementById('synthetic').addEventListener('click', () => run(syntheticClick));
```

## Step 2: a page to click

Save this as `page/index.html` (any folder) and serve it: `python3 -m http.server 8000` inside that folder.
(Debugger access to `file://` pages needs "Allow access to file URLs"; a local server avoids that.)

```html file=06-cdp-click/page/index.html
<!doctype html>
<html>
  <body style="font-family: sans-serif">
    <h1>CDP click target</h1>
    <button id="target" style="padding: 12px 24px; font-size: 18px">Click me</button>
    <p id="result">not clicked yet</p>
    <script>
      // The page's own report: who sent this event?
      document.getElementById('target').addEventListener('click', (event) => {
        document.getElementById('result').textContent = `isTrusted: ${event.isTrusted}`;
      });
    </script>
  </body>
</html>
```

## Checkpoint

> **Verified** 2026-11-11 in Chromium 156 on Linux (headless, the popup opened as a tab with `?tabId=`): the real click
> reports `isTrusted: true`, the synthetic one `isTrusted: false`, and the error row below appears with the popup
> as the target. The yellow bar and the real toolbar popup were not observed (headless).

Load the folder unpacked (lesson 2), open <http://localhost:8000/>, click the extension icon.

- **Real click (debugger)** → `isTrusted: true`. The yellow bar flashed while it ran.
- **Synthetic click (dispatchEvent)** → `isTrusted: false`.

| You see | Why |
| --- | --- |
| `Error: Cannot access a chrome:// URL` | the active tab is a browser page; open the test page first |
| `Error: Another debugger is already attached to the tab` | DevTools is open on that tab (or another extension attached); close DevTools |
| `Error: TypeError: Cannot read properties of null (reading 'getBoundingClientRect')` | the page has no `#target`; open the test page |
| the bar stays | `detach` did not run: the `finally` is what guarantees it |
| nothing happens, no error | the popup closed (Chrome closes it when focus moves); keep it open until it answers |

## Exercises

1. Add a third button that types into an input with `Input.insertText` (look the method up in the protocol docs).
2. Make `realClick` accept a CSS selector from a text box instead of the fixed `#target`.
3. Use `Page.captureScreenshot` (`format: 'png'`) and show the result in an `<img>` (`data:image/png;base64,…`).
   This is how BlockFlow takes full-page screenshots of a tab that is not showing.
4. Harder: attach, call `Network.enable`, listen with `chrome.debugger.onEvent` for `Network.responseReceived`,
   reload the tab with `Page.reload` and list the URLs. You have built a tiny HAR recorder.

## In BlockFlow

- `src/browser/cdp.ts`: `mouseClick`, `typeInto`, `pressKey`, `insertText`: the same `Input.dispatch…` calls, with
  scrolling into view, modifiers and click counts; the Click block's "Use real mouse and keyboard" setting uses them.
- `src/browser/cdpSessions.ts`: the part this lesson skips. One attachment per tab **per run**, shared by every
  step and released when the run ends, because attaching and detaching around every step would flash the bar and
  race with other steps. It also rejects commands after the run closed and recognises "not attached" errors
  (an API detach sends no event).
- `src/browser/routes.ts` (`Fetch` domain, mock requests), `environment.ts` (`Emulation` domain),
  `telemetry.ts` (`Network` and `Runtime` events), `screenshots.ts` (`Page.captureScreenshot`): the rest of
  the protocol in use. The wiki's [Browser Host](../wiki/Browser-Host.md) page lists each.
- `optional_permissions`: BlockFlow does not ask for `debugger` at install. `PermissionNote.tsx` asks when a
  block that needs it is configured (lesson 7, section 12).

Back to the [index](README.md).
