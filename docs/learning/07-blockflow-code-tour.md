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
(lesson 3) that talks to the worker by messages (`src/shared/messages.ts`).

## 8. The page agent: clicking and filling like Playwright

Page blocks (Click, Fill, Fill Form, Wait For…) never touch a page themselves. They call
`ctx.host.page.act(tabId, request, timeoutMs)` with a plain request such as
`{ op: 'click', locator: 'role=button[name="Save"]' }` (`src/core/page.ts`). The trip:

1. `src/browser/pageDriver.ts` injects `src/entrypoints/agent.content.ts` into the tab (once per page load:
   a navigation wipes it) and calls it with `scripting.executeScript` (lesson 3).
2. `src/dom/agent.ts` finds the element with `src/dom/locator.ts` (CSS, `text=`, `role=`, `label=`…),
   waits until it is visible, enabled, not moving and not covered, then dispatches the events a real user
   would cause. It answers `done`, `error`, or `pending` + the reason.
3. The driver asks again until the timeout. Short calls survive navigations and keep the worker awake.

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

## 13. The editor: `src/entrypoints/editor/`

An ordinary React app (React Flow for the canvas). The interesting file is `flow/convert.ts`: it converts
between the saved `Workflow` and React Flow's nodes/edges. Everything else is UI. If you know React you
can already read this directory.

## Project exercises (pick any, in rising difficulty)

1. **Delay-free logger block**: already built (`log.ts`). Read it, then write a **Counter** block that
   adds `count` (kept in `ctx.state`) to the payload and passes it on. Steps: `src/core/blocks/counter.ts`
   → register in `index.ts` → a test using `fakeHost.ts`. The editor needs no change.
2. **Notification block** (already built in `notify.ts`: read it, then add a different Host method, e.g. clipboard). Needs the `notifications` permission and a new `Host` method (`notify`). Touch
   `types.ts`, `fakeHost.ts`, `host.ts`, `wxt.config.ts`. This is how you extend the Host.
3. **IF block** with two outputs: already built (`ifBlock.ts`, `ports.ts`). Read how `routeTo` and
   `edgePort` work, then write a **Switch** block with one output per case.
4. **Hover-and-read block** using the page agent: add an op to `src/core/page.ts`, handle it in
   `src/dom/agent.ts` (test it in `tests/dom/agent.test.ts` first), then a block that calls it.
5. **Cron-ish Timer** ("every day at 09:00"): already built as Schedule (`scheduleBlock.ts`,
   `src/core/schedule.ts`). Read how it plans one one-shot timer at a time, then add a "last day of the
   month" option with tests.
6. **Import/export workflows** as JSON: already built (`library.ts`). Compare it with how you would have done it.

Rule for all of them (from `CLAUDE.md`): `src/core` stays free of browser APIs; payloads stay
JSON-serialisable; tests first for engine and block changes.

Next: [Lesson 8: Testing, debugging, publishing](08-testing-debugging-publishing.md)
