# Lesson 2: Hello extension

> **Verified:** the extension loads in Chromium 141 and `popup.js` runs without errors. The toolbar click itself cannot be
> scripted, so the `activeTab` title/address display was checked by reading the code, not by clicking. Report any mismatch.

Goal: the smallest useful extension, built by hand. A toolbar button that opens a popup showing the title
and address of the page you are on.

You will learn: `manifest.json`, popups, `permissions`, and the load → edit → reload loop.

## Step 1: the folder

Make a new empty folder anywhere, e.g. `hello/`. Everything below goes in it. (The finished version is in
[`examples/01-hello/`](examples/01-hello).)

## Step 2: `manifest.json`

This file is to an extension what `package.json` plus `next.config.js` is to a Next.js app.

```json file=01-hello/manifest.json
{
  "manifest_version": 3,
  "name": "Hello Learner",
  "version": "0.1.0",
  "description": "Shows the title and address of the current page.",
  "action": {
    "default_title": "Hello",
    "default_popup": "popup.html"
  },
  "permissions": ["activeTab"]
}
```

Line by line:

- `manifest_version: 3`: always 3 now.
- `action`: the toolbar button. `default_popup` is the HTML file shown when it is clicked.
- `permissions: ["activeTab"]`: when the user clicks your button, you get temporary access to *that* tab,
  including its `url` and `title`, without asking for broad permissions. Remove this line later and see what
  breaks; that is the best way to learn what it does.

## Step 3: the popup page

```html file=01-hello/popup.html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Hello</title>
    <style>
      body { font: 14px system-ui, sans-serif; width: 280px; padding: 12px; }
      h1 { font-size: 15px; margin: 0 0 8px; }
      #url { color: #555; word-break: break-all; }
      button { margin-top: 10px; }
    </style>
  </head>
  <body>
    <h1 id="title">Loading…</h1>
    <div id="url"></div>
    <button id="copy">Copy address</button>
    <!-- Must be a separate file: Manifest V3 forbids inline <script> blocks. -->
    <script src="popup.js"></script>
  </body>
</html>
```

```js file=01-hello/popup.js
// This runs in the popup, a normal page that happens to have the chrome.* APIs.
async function main() {
  // "the tab I was opened from": active tab of the current window.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  document.getElementById('title').textContent = tab?.title ?? '(no title)';
  document.getElementById('url').textContent = tab?.url ?? '(no address; maybe a browser page)';

  document.getElementById('copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(tab?.url ?? '');
    document.getElementById('copy').textContent = 'Copied!';
  });
}

main();
```

Notes for a React person:

- There is no framework here, just the DOM. That is on purpose: you should see what React is hiding. In
  lesson 6 the popup becomes React.
- The popup is destroyed every time it closes, so it cannot keep anything in variables between openings.
  It would use `chrome.storage` for that (lesson 4).

## Step 4: load it

1. `chrome.extensions` → Developer mode on → **Load unpacked** → pick your folder.
2. Pin the extension (puzzle-piece icon) and click it on any ordinary website.

## Checkpoint

You should see the page's title, its address, and the Copy button working.

Common problems:

| Symptom | Cause |
| --- | --- |
| "Manifest file is missing or unreadable" | You picked the wrong folder, or JSON has a trailing comma |
| Popup is blank, nothing happens | Open the popup, right click → **Inspect**, read the console |
| `(no address; maybe a browser page)` | On `chrome://` pages and the Web Store extensions get no access, by design |
| Address is empty on normal pages | `activeTab` missing from `permissions` |

## Exercises

1. Show the page's hostname only (hint: `new URL(tab.url).hostname`).
2. Add a second button that opens `https://example.com` in a new tab with `chrome.tabs.create({ url })`.
   Does that need a new permission? (Try it first; the answer teaches you what `tabs` is for.)
3. Change `default_title`, reload with ↻, hover the toolbar button.

## In BlockFlow

`wxt.config.ts` generates the manifest for you; the popup-less design opens an editor tab on click
(`browser.action.onClicked` in `src/entrypoints/background.ts`). When you build, look at the generated
`.output/chrome-mv3/manifest.json` and compare with what you just wrote.

Next: [Lesson 3: Content scripts and messaging](03-content-scripts-and-messaging.md)
