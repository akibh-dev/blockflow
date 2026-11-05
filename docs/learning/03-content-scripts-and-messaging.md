# Lesson 3: Content scripts and messaging

> **Verified:** loaded in Chromium 141; the content script answers `count-links`, highlights and clears on a real page.

Goal: reach into a web page. Count its links and highlight them from your popup.

You will learn: **content scripts**, the **isolated world**, `runtime.sendMessage` / `tabs.sendMessage`,
and `host_permissions`. This is the core of every page-automation extension, including BlockFlow's
element picker.

Finished version: [`examples/02-links/`](examples/02-links).

## The idea

The popup cannot touch the page's DOM. A **content script** is a JS file the browser injects into pages
you choose. It shares the page's DOM but has its **own JavaScript world**: it cannot see the page's
variables, and the page cannot see yours. Think of it as an iframe-like sandbox around the same HTML.

The popup and the content script talk through messages, like a client and a tiny API:

```text
popup.js ──tabs.sendMessage(tabId, {type:'count-links'})──▶ content.js
popup.js ◀──────────────────── sendResponse({count: 42}) ── content.js
```

## Step 1: manifest

```json file=02-links/manifest.json
{
  "manifest_version": 3,
  "name": "Link Counter",
  "version": "0.1.0",
  "action": { "default_popup": "popup.html" },
  "permissions": ["activeTab"],
  "content_scripts": [
    {
      "matches": ["http://*/*", "https://*/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

`content_scripts` tells the browser: on every http(s) page, inject `content.js` once the page is idle.
`matches` is a *match pattern*, a more limited glob than regex (`<all_urls>` and `*://*.example.com/*` are
other typical ones). Declaring this makes Chrome show "Read and change your data on all websites" when
installing, which is why you will later prefer narrower patterns or on-demand injection.

## Step 2: the content script

```js file=02-links/content.js
// Runs inside every web page. Its `window` is the page's, but its variables are private.
const OUTLINE = '3px solid #e11d48';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'count-links') {
    sendResponse({ count: document.links.length, title: document.title });
    return; // answered synchronously, nothing more to do
  }

  if (message?.type === 'highlight-links') {
    for (const link of document.links) link.style.outline = OUTLINE;
    sendResponse({ count: document.links.length });
    return;
  }

  if (message?.type === 'clear-highlight') {
    for (const link of document.links) link.style.outline = '';
    sendResponse({ ok: true });
    return;
  }
});
```

Rule worth memorising: a listener must `return true` if it will call `sendResponse` **later**
(asynchronously); otherwise the channel closes immediately. All of ours reply instantly.

## Step 3: popup

```html file=02-links/popup.html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font: 14px system-ui, sans-serif; width: 240px; padding: 12px; }
      #status { margin: 0 0 10px; min-height: 1.4em; }
      button { margin-right: 6px; }
    </style>
  </head>
  <body>
    <p id="status">Counting…</p>
    <button id="on">Highlight</button>
    <button id="off">Clear</button>
    <script src="popup.js"></script>
  </body>
</html>
```

```js file=02-links/popup.js
const status = document.getElementById('status');

async function send(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    // Nobody is listening: a chrome:// page, the Web Store, or a tab opened before the extension loaded.
    return null;
  }
}

async function main() {
  const reply = await send({ type: 'count-links' });
  status.textContent = reply
    ? `${reply.count} links on "${reply.title}"`
    : 'Cannot reach this page. Try an ordinary website and reload it once.';
}

document.getElementById('on').addEventListener('click', async () => {
  const reply = await send({ type: 'highlight-links' });
  if (reply) status.textContent = `Highlighted ${reply.count} links`;
});
document.getElementById('off').addEventListener('click', () => send({ type: 'clear-highlight' }));

main();
```

## Checkpoint

Load the folder, open any ordinary site (wikipedia works well), **reload that page once** (pages open
before the extension was loaded have no content script), click the button: you see a link count, and
Highlight draws red outlines.

## The other way to put code in a page: inject on demand

A permanent content script is wasteful if you only need code occasionally. The alternative, which
BlockFlow's picker uses, is injecting a function or file when the user asks:

```js
// needs "scripting" in permissions, plus activeTab or host_permissions
const [{ result }] = await chrome.scripting.executeScript({
  target: { tabId: tab.id },
  func: () => document.links.length, // serialised and run inside the page
});
```

The function is *copied* into the page, so it cannot use variables from your popup (closures do not
survive); pass data through the `args: [...]` option instead. The return value must be JSON-able.

Some pages can never be scripted, whatever your permissions: `chrome://` pages, the Web Store, and every
`chrome-extension://` page, **your own extension's pages included** (`executeScript` fails with "Cannot
access contents of url chrome-extension://…"). That is why BlockFlow's practice page,
`docs/manual-test/playground.html`, is served over http by `npm run playground` instead of being
shipped inside the extension: blocks have to inject the page agent to click and fill there.

## Exercises

1. Make *Highlight* toggle. Show the count of **external** links only (`link.hostname !== location.hostname`).
2. Add `{type:'list-links'}` returning the first 5 link texts; render them as a list in the popup.
3. Replace the declared `content_scripts` with `executeScript` on click. What permission do you need now,
   and what does the install prompt say instead?
4. (Think) What would break if two extensions each defined `const OUTLINE` in their content script on the
   same page? (Answer: nothing, thanks to isolated worlds. Why is that good?)

## In BlockFlow

- `src/dom/picker.ts` is a content script with a UI: a Shadow DOM overlay (so the page's CSS cannot touch
  it) that highlights the element under the mouse and reports its selector via a message.
- `src/entrypoints/picker.content.ts` is injected **on demand** (`registration: 'runtime'`), exactly the
  second approach above.
- `src/shared/messages.ts` defines the message types (`bf:start-pick`, `bf:picked`, ...) with a type guard.
  Typed messages are how you keep several parts honest.

Next: [Lesson 4: Background, storage, alarms](04-background-storage-alarms.md)
