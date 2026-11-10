# Lesson 7: BlockFlow code tour

Goal: read the real project with the vocabulary you now have, then extend it by yourself.

Read in this order. Each stop says what to look for and what to try. Budget one evening.

## 0. Setup

```bash
npm install && npm run check     # typecheck + tests + docs in sync
npm run dev                      # Chrome with hot reload
```

Then use the extension once: the "Try it end to end" section of the root `README.md`.

This tour picks the files worth reading; the internals wiki (`docs/wiki/Home.md`) explains every
file, for when you want the rest.

## 1. The product in one picture

A **workflow** is blocks (nodes) joined by connections (edges). A block's **output payload** becomes the
next block's **input**. A block with nothing feeding it is a **root** and starts the flow itself (a Timer
ticking, a Watch Element polling). Open `docs/ARCHITECTURE.md` for the diagram.

## 2. A block, the smallest unit: `src/core/blocks/timer.ts`

Find: `defaultConfig`, `fields` (the form the editor renders), `outputs` (documentation for wiring),
`start` (root behaviour), `run` (when fed), `onTimer` (when its timer fires).

Notice what it does **not** do: no `setInterval`, no variables for the tick count. `ctx.timers.set` and
`ctx.state` are the lesson 4 rules turned into an API. Then read `openUrl.ts` (the simplest block) and
`watchElement.ts` (the most realistic).

Try: change the Timer's `summary()` text, see it update on the block in the editor. You did not touch the
editor, because the editor renders whatever the registry contains.

## 3. The engine: `src/core/engine.ts`

`WorkflowRunner` wires blocks together. Find `start`, `runOnce` (the Run button), `handleTimer`,
`emitFrom` (passes a payload to every connection of one output) and `runStep` (one block as one step:
timeout, retries, "on error", then pass the result on). Read `tests/core/engine.test.ts` and
`tests/core/runs.test.ts` next to it; the tests are the specification.

Two ideas to notice. **Ports**: If returns `routeTo('true', input)` instead of a payload, and the engine
only follows edges whose `sourcePort` is `true` (`src/core/ports.ts`). **Cross-cutting rules live in one
place**: no block implements retries or timeouts; the engine wraps every block the same way, like
middleware in an Express or Next.js app.

Key idea: **the engine never talks to the browser.** It talks to `Host` (`src/core/types.ts`):
`tabs.open`, `page.readElement`, `http.fetch`, `notify`, `scheduler`, `state`, `sleep`, `now`. In tests that is `tests/helpers/fakeHost.ts`;
in the extension it is `src/browser/host.ts`. This is dependency inversion, and it is what let us test the
whole engine without a browser.

Try: add `console.log` to `run` of Open Tab (`openUrl.ts`) and run the Timer test. Remove it.

## 4. Templating: `src/core/template.ts`

`{{tick}}`, `{{$json.x}}`, `{{rows[0]}}`. Small, pure, heavily tested; a good "how would I write this"
exercise: read the tests first and try to implement `render` yourself before reading it.

## 5. The browser layer: `src/browser/`

| File | What it is | Lesson |
| --- | --- | --- |
| `hybridScheduler.ts` | timers: alarms + in-memory + keep-alive | 4 |
| `scheduler.ts` | plugs the real `browser.alarms`/storage into it | 4 |
| `pageReader.ts`, `tabs.ts` | Watch Element's engine: own tab, reload, read | 5 |
| `picking.ts` | start/finish the element picker | 3 |
| `stores.ts` | storage wrappers | 4 |
| `pageDriver.ts`, `navigation.ts` | page agent calls, waiting for load / URL / network idle | 3, 5 |
| `htmlParse.ts` | runs the agent on fetched HTML (Chrome: through the offscreen document) | 10 below |
| `blobStore.ts` | IndexedDB: screenshots and datasets | 9 below |
| `prompts.ts` | Manual Step: notification buttons + editor banner | 4 |
| `recording.ts`, `ownTabs.ts` | the recorder's tab; tabs BlockFlow opened | 11 below |
| `cdp.ts`, `popups.ts` | real input through the debugger; popups of a run's tab | 12 below |
| `cdpSessions.ts`, `m3Host.ts` | one debugger session per run; the run's network/environment features and their cleanup | 9 below |
| `routes.ts`, `environment.ts`, `telemetry.ts` | Route (CDP `Fetch` + browser rules), Emulate and Clear Site Data, HAR and console capture | 9 below |
| `bridge.ts`, `bridgeHandlers.ts`, `suites.ts` | outside control: the native port and the JSON-RPC methods the MCP server and CLI call; suites | lesson 9 |
| `host.ts` | assembles the `Host` | 6 |

Read `hybridScheduler.ts` with its test file `tests/browser/hybridScheduler.test.ts` open. The test uses a
fake clock; advancing time by hand is how you test timing code without waiting.

## 6. The worker: `src/entrypoints/background.ts`

Under 300 lines. Check against lesson 4: top-level synchronous listeners ✔, no state in variables ✔,
`restoreAll()` at each start ✔, storage as the bus between editor and worker ✔ (`storage.onChanged` +
`diffWorkflows`).

## 7. The element picker: `src/dom/` + `src/entrypoints/picker.content.ts`

`selector.ts` decides *which* selector to propose (prefers stable ids, `data-testid`, avoids generated
class names like `css-1x2y3`). `picker.ts` is the overlay UI in Shadow DOM. The picker is a content script
(lesson 3) that talks to the worker by messages (`src/shared/messages.ts`). It is injected into every frame
of the tab (`allFrames: true`); a frame works out which `<iframe>` it is with `src/dom/framePath.ts`
(`window.frameElement` when the parent is same-origin, a `postMessage` question when it is not), and the
frames' pickers talk to each other through the worker.

## 8. The page agent: clicking and filling like Playwright

Page blocks (Click, Fill, Fill Form, Wait For…) never touch a page themselves. They call
`ctx.host.page.act(tabId, request, timeoutMs)` with a plain request such as
`{ op: 'click', locator: 'role=button[name="Save"]' }` (`src/core/page.ts`). The trip:

1. `src/browser/pageDriver.ts` injects `src/entrypoints/agent.content.ts` into the tab (once per page load:
   a navigation wipes it) and calls it with `scripting.executeScript` (lesson 3).
2. `src/dom/agent.ts` finds the element with `src/dom/locator.ts` (CSS, `text=`, `role=`, `label=`…),
   waits until it is visible, enabled, not moving and not covered, then dispatches the events a real user
   would cause. It answers `done`, `error`, or `pending` + the reason, with an error code such as
   `locator.strict` (`src/core/errors.ts`): like an API returning `{ error: { code, message } }` instead of
   only a message, so a program (or a model) can react without parsing English.
3. The driver asks again until the timeout. Short calls survive navigations and keep the worker awake.
   It then throws a `CodedError`, and the engine copies the code onto the step record (`StepRecord.code`).

The same agent also answers `{ op: 'snapshot' }` (`src/dom/snapshot.ts`): an outline of the page's
accessibility tree with a locator per element, the text a model needs to write steps. The editor's
**📸 Snapshot page** button asks the background for it (`bf:snapshot-page`) and copies it with
`navigator.clipboard.writeText`. One extension detail: the clipboard only works in a focused page, so the
background switches back to the editor tab before it answers (`snapshotForEditor` in
`src/browser/picking.ts`).

Two web-dev ideas you already know show up here. **Controlled inputs**: React ignores `input.value = x`
from its own JavaScript world, so the agent sets the value through the prototype's setter and fires `input`.
(From an extension's isolated world even a plain assignment works, because React's wrapper lives in the
page's world; lesson 3.) **Synthetic events have no default action** for keys: pressing Enter with
`dispatchEvent` does not submit a form, so the agent calls `form.requestSubmit()` itself.

Try: run `npm run e2e` and watch the browser fill the fixture forms (`tests/fixtures/site/`). Then read
`tests/dom/agent.test.ts`: it renders a real React form in jsdom and fills it through the agent.

## 9. Testing features: what an engine adds around blocks

Read `src/core/blocks/assert.ts`: it is small because the engine does the rest. Compare with what you
know from Jest/Playwright:

| You know | In BlockFlow |
| --- | --- |
| `expect(locator).toHaveText()` retrying | Assert on the page retries until the step timeout |
| `expect.soft()` | Assert with **soft**: `ctx.softFail()` |
| a shared `login()` helper | Run Workflow (`ctx.callWorkflow`), a child `WorkflowRunner` |
| CI secrets / `.env` | Secrets: `{{secret.x}}`, masked by `maskPayload` before anything is stored |
| JUnit reporter | `src/core/report.ts`, pure functions tested in `tests/core/report.test.ts` |

The screenshot store (`src/browser/blobStore.ts`) is plain IndexedDB, the same API you would use in a
web app: extension pages and the worker share it because they share the `chrome-extension://` origin.

### Run resources: a connection pool around a request

In a Next.js app, you would not close a shared database connection after every query if another request
still uses it. The debugger API has the same ownership problem: real input, a screenshot and a network
listener can all need the same tab. Read `src/browser/cdpSessions.ts` with
`tests/browser/cdpSessions.test.ts` open. One run retains one reference per tab; the last owner detaches.
An action outside a run holds a temporary reference. Attach and detach are serialised so a finishing
action cannot close the next action's session.

Follow the boundary: `inRun` calls optional `Host.forRun(runId)`, blocks receive that scoped Host,
and `finishRun(runId)` is awaited before the final record is published. The browser implementation
adds run ids to CDP operations; the core engine knows only resource lifecycle, not browser APIs.
Cancellation, a thrown block and a timeout all reach cleanup. Child runs have separate ownership.

The extension-specific catch is optional permissions. The background registers permission and tab
listeners synchronously, even if `browser.debugger` is not available yet. After a grant it can install
the debugger listeners. Losing a tab, permission or debugging session invalidates its connection;
late callbacks are rejected instead of silently reattaching. API detach does not always emit an event,
so the transport also recognises "not attached" errors. Do not interpret "already attached" as ownership.

Checkpoint: run `npm test -- tests/browser/cdpSessions.test.ts tests/browser/cdp.test.ts tests/core/runResources.test.ts`,
then `BF_HEADLESS=1 npm run e2e -- m3-sessions`. The browser scenario checks attachment between steps
and release after success, failure and Stop. JSON reports show `usedDebugger: true` for acquisitions.
Exercise: trace the two-runs/one-tab unit test and predict exactly which run causes the detach.

### Network and environment: middleware you install on someone else's tab

M3 builds on that one session per run. Read `src/browser/m3Host.ts` first: `createRunHost` makes one
set of features per run (routes, environment, telemetry) that share the run's CDP lease, and its
`finishRun` calls every feature's cleanup before releasing the debugger, on success, failure and Stop.

| You know | In BlockFlow (`src/browser/`) |
| --- | --- |
| MSW / Playwright `page.route()` mocking `fetch` | `routes.ts`: CDP `Fetch.enable` pauses each request, `Fetch.requestPaused` picks the newest matching rule, then `fulfillRequest` / `failRequest` / `continueRequest` |
| Next.js middleware that blocks or redirects | the same file, `declarativeNetRequest` **session rules** scoped to one tab id: no debugger bar, works on Firefox, but only abort and redirect |
| Responsive mode / `page.emulate()` in DevTools | `environment.ts`: `Emulation.setDeviceMetricsOverride`, `setTimezoneOverride`, `setEmulatedMedia`, `Network.emulateNetworkConditions` |
| Sentry breadcrumbs for `console.error` | `telemetry.ts`: `Runtime.consoleAPICalled` / `exceptionThrown`, bounded per step and masked before storage |
| Clearing cookies between Cypress tests | `environment.ts` `clearSiteData`: `browsingData.remove({ origins })`, never an unfiltered remove |

The extension-specific lessons:

- **Overrides belong to the tab, not to your code.** A web app's state dies with the page. An emulation
  or route rule stays on the user's real tab until something removes it, so each feature remembers what it
  changed and resets only that. `m3Host.ts` also *claims* the tab: a second run that tries to emulate the
  same tab fails instead of silently fighting the first.
- **Session rules outlive your worker.** DNR session rules survive a service-worker restart, but the run
  that owned them does not. BlockFlow uses a reserved id range and `initialiseRoutes()` (called at the top
  of `background.ts`) deletes leftovers at start-up. Same idea as cleaning orphaned jobs on boot.
- **Someone else may be emulating too.** Playwright puts its own light colour scheme and viewport on every
  page. Our reset at run end clears those as well, until the page reloads. That is why
  `tests/e2e/specs/m3-environment.mjs` reloads before comparing. In a normal browser nothing else emulates.
- **Ask for the narrowest permission.** Blocking and redirecting needs `declarativeNetRequest`, mocking needs
  `debugger`. Route's `permissions()` picks one from the rules, so a block-only workflow never shows the
  "debugging" bar. Firefox's `browsingData` cannot filter every data type by origin, so BlockFlow refuses
  there rather than deleting other sites' data.

Checkpoint: `npm test -- tests/browser/routes.test.ts tests/browser/environment.test.ts tests/browser/m3Host.test.ts`,
then `BF_HEADLESS=1 npm run e2e -- m3-route m3-environment m3-telemetry`. In the editor, a Route block with
only `abort` rules asks for `declarativeNetRequest`; add a `fulfill` rule and it asks for `debugger` instead.
Exercise: in `m3-route.html`'s spec, add a rule with `delayMs: 2000` and assert the page shows a loading
state first. Then break `finish()` in `routes.ts` (skip `Fetch.disable`) and see which test catches it.

## 10. Data features: an interpreter, an offscreen page, IndexedDB

- `src/core/expression.ts` is a tiny language: tokenizer → parser → evaluator, ~400 lines. Extensions
  may not use `eval` (MV3 content security policy), which is also why template engines like Handlebars'
  precompiled-at-runtime mode do not work in extensions. Read the tests first
  (`tests/core/expression.test.ts`).
- `src/entrypoints/offscreen/`: Chrome's background is a service worker with no `document`, like a web
  worker. To use `DOMParser` it opens an invisible extension page and messages it. Same idea as moving
  DOM work out of a Web Worker back to the main thread.
- A surprise worth remembering: values returned from `scripting.executeScript` lose their object key
  order in Chrome. See `tableToObjects` in `src/core/blocks/extractList.ts`.

## 11. Events from the browser, and a recorder

`background.ts` now listens to `webNavigation` (page loads and `history.pushState` route changes, the
SPA events you know from Next.js routing) and to `contextMenus`. Notice they are registered at the top
of `defineBackground`, synchronously: an event that wakes the worker is only delivered to listeners that
exist right away (lesson 4).

The recorder (`src/dom/recorder.ts`) is event delegation, like a React synthetic event system: one
capture-phase listener per event type on `window`, deciding what each event means. Read its test
(`tests/dom/recorder.test.ts`) and then `src/core/recording.ts`, which turns the raw steps into blocks.

## 12. Where an extension meets its limits

- `src/browser/cdp.ts`: the same protocol Playwright and Puppeteer use, but reached through the
  `debugger` extension API. Compare an untrusted `dispatchEvent` click with a debugger click on
  `tests/fixtures/site/trusted.html`.
- Frames: `FrameBoundaryError` in `src/dom/locator.ts` and how `pageDriver.ts` continues in another frame
  is the extension version of the same-origin policy you know from `postMessage` and iframes.
- `src/core/playwright.ts` writes code from data: a small compiler. `npm run e2e` runs its output.
- `src/core/script.ts` is a compiler in the other direction: a list of steps (`{ "click": "text=Save" }`)
  becomes nodes and edges, and `decompile` turns a tree-shaped graph back into steps, checking itself by
  compiling the result again. `src/core/layout.ts` then places the blocks (layered layout, the same idea
  as Graphviz's `dot`). Plain functions over JSON, like a reducer: no extension APIs at all.

## 13. The editor: `src/entrypoints/editor/`

An ordinary React app (React Flow for the canvas). The interesting file is `flow/convert.ts`: it converts
between the saved `Workflow` and React Flow's nodes/edges. Everything else is UI. If you know React you
can already read this directory.

Importing a file is the one place where outside data enters the extension, so it is checked like an API
request body: think of `zod`'s `safeParse` returning issues with a `path`. `src/core/check.ts` walks the raw
JSON and returns `Issue`s (`src/core/issues.ts`) with a stable `code`, a JSON Pointer `path` into the file
and a "Did you mean …?" `hint` (`src/core/suggest.ts`, an edit distance). `parseImport` in `library.ts`
refuses the file on any error, and the editor lists the issues in a dialog (`issuesDialog` in
`components/Dialogs.tsx`). The extension-specific twist: the same rules must run in the editor, the
importer and (later) a script compiler, all without the DOM, so they live in `src/core` and blocks
declare their own cross-field rules in `validate(config)`. Try it: import a copy of
`docs/guide/examples/login-test.blockflow.json` with `"locator"` misspelled and read the dialog.

## Project exercises (pick any, in rising difficulty)

1. **Delay-free logger block**: already built (`log.ts`). Read it, then write a **Counter** block that
   adds `count` (kept in `ctx.state`) to the payload and passes it on. Steps: `src/core/blocks/counter.ts`
   → register in `index.ts` → a test using `fakeHost.ts`. The editor needs no change.
2. **Notification block** (already built in `notify.ts`: read it, then add a different Host method, e.g. clipboard). Needs the `notifications` permission and a new `Host` method (`notify`). Touch
   `types.ts`, `fakeHost.ts`, `host.ts`, `wxt.config.ts`. This is how you extend the Host.
3. **IF block** with two outputs: already built (`ifBlock.ts`, `ports.ts`). Read how `routeTo` and
   `edgePort` work. Switch (one output per case) is built too (`switchBlock.ts`): its `ports` is a
   function of the settings. Read how the editor keeps connections when a case is renamed
   (`followPortChanges` in `flow/convert.ts`), then try a block whose outputs come from a number setting.
4. **Hover-and-read block** using the page agent: add an op to `src/core/page.ts`, handle it in
   `src/dom/agent.ts` (test it in `tests/dom/agent.test.ts` first), then a block that calls it.
5. **Cron-ish Timer** ("every day at 09:00"): already built as Schedule (`scheduleBlock.ts`,
   `src/core/schedule.ts`). Read how it plans one one-shot timer at a time, then add a "last day of the
   month" option with tests.
6. **Import/export workflows** as JSON: already built (`library.ts`). Compare it with how you would have done it.

Rule for all of them (from `CLAUDE.md`): `src/core` stays free of browser APIs; payloads stay
JSON-serialisable; tests first for engine and block changes.

Next: [Lesson 8: Testing, debugging, publishing](08-testing-debugging-publishing.md)
