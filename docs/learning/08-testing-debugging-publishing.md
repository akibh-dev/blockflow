# Lesson 8: Testing, debugging, publishing

## Debugging: the right console for the right part

| Part | Open DevTools via |
| --- | --- |
| Popup | Right click the popup → Inspect (closing the popup closes DevTools; use `popup.html` in a tab to keep it) |
| Worker | `chrome://extensions` → your extension → "service worker" link |
| Content script | The *page's* DevTools → Console, change the context dropdown from "top" to your extension |
| Editor / options page | Normal DevTools in that tab |
| Storage | Worker DevTools → Application → Storage → Extension storage; or `await chrome.storage.local.get(null)` in any console |
| Alarms | In the worker console: `await chrome.alarms.getAll()` |

Checklist when something silently fails:

1. Is the manifest permission there? (`undefined is not a function` on `chrome.something`.)
2. Wrong console? (Log lives elsewhere.)
3. Did you reload the extension *and* the page (content scripts are injected at page load)?
4. Is a promise rejecting unseen? Add `.catch(console.error)` to fire-and-forget calls (BlockFlow's
   `report()` helper in `background.ts`).
5. Was the worker restarted and a variable lost? (Lesson 4.)

## Testing, three layers

| Layer | Tool | BlockFlow example | What it proves |
| --- | --- | --- | --- |
| Pure logic | Vitest in Node | `tests/core/*` | Engine, templating, validation |
| DOM code | Vitest + jsdom (or real Chromium) | `tests/dom/*` | Selector generation, picker |
| Real browser | Load the unpacked build and drive it (Playwright, `--load-extension`) | see below | The wiring, which the other two cannot see |

**Make code testable by separating it from the browser.** BlockFlow's `Host` interface and the
`HybridScheduler`'s ports (alarms/store/clock/ping) exist for this. If the logic imports `chrome.*`
directly, you can only test it in a browser.

### Driving a real extension from a script (Playwright sketch)

```js
const context = await chromium.launchPersistentContext(tmpProfileDir, {
  headless: false,                       // extensions need a full browser...
  args: ['--headless=new',               // ...but this new headless mode runs them
         `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
const [worker] = context.serviceWorkers();   // or await context.waitForEvent('serviceworker')
await worker.evaluate(() => chrome.storage.local.set({ ... }));   // run code inside the extension
```

That is how BlockFlow's scheduler and picker and this course's example extensions were checked: a local
HTTP server that counts hits, the extension loaded unpacked, assertions on the hits and on storage.
Two gotchas learned the hard way: an extension **without** a background worker has no worker to read its id
from (derive it from the folder path or open `chrome://extensions`), and the toolbar popup itself cannot be
clicked from a script (open `popup.html` as a tab instead; note `activeTab` does not apply there).

## Cross-browser

- **Firefox:** MV3 background is an *event page*; host permissions are opt-in by the user; add
  `browser_specific_settings.gecko.id` (WXT config does). Test with `npm run dev:firefox`.
- **Safari:** build, then convert with `xcrun safari-web-extension-converter`; needs Xcode and an Apple
  developer account to distribute. Expect some API gaps. BlockFlow's Safari status is "untested".

## Publishing

1. Tighten permissions: ask only for what you use; prefer `optional_host_permissions` + runtime request;
   write a plain-language **privacy policy** (stores require it when you handle web content).
2. Icons (16/32/48/128 px), screenshots, a clear single purpose.
3. `npm run zip` (WXT) → upload to the Chrome Web Store dashboard (one-time $5 fee), AMO for Firefox, App
   Store Connect for Safari. Review takes days; broad host permissions slow it down and invite questions.
4. Versioning: bump `version` for every upload; keep a changelog.

## What to learn after this

- `chrome.declarativeNetRequest` (block/redirect requests, uBlock-style).
- Side panel API, context menus, commands (keyboard shortcuts).
- Offscreen documents (a DOM in MV3 for things like parsing HTML or playing audio).
- `chrome.identity` for OAuth with a backend (your SaaS skills apply directly).

Back to the [index](README.md).
