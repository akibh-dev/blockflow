# Testing

How BlockFlow is tested: the Vitest unit suites (engine, blocks, page agent, editor model), the fake host they
share, the Playwright-driven end-to-end run against a real browser, and CI. Read this before adding a test or
when a test fails and you need to know what it exercises. The reasoning behind the layers is in
[ARCHITECTURE.md, Testing strategy](../ARCHITECTURE.md#testing-strategy); this page is the reference.

**Source:** [vitest.config.ts](../../vitest.config.ts) · [tests/helpers/fakeHost.ts](../../tests/helpers/fakeHost.ts) ·
[tests/e2e/run.mjs](../../tests/e2e/run.mjs) · [tests/e2e/harness.mjs](../../tests/e2e/harness.mjs) · [tests/e2e/specs/](../../tests/e2e/specs) · [tests/e2e/server.mjs](../../tests/e2e/server.mjs) ·
[tests/fixtures/site/](../../tests/fixtures/site) · [docs/manual-test/clock.html](../manual-test/clock.html) ·
[.github/workflows/ci.yml](../../.github/workflows/ci.yml)

## Commands

| Command | What runs |
| --- | --- |
| `npm test` | `vitest run`: every `tests/**/*.test.ts` once (29 files, about 330 tests, a few seconds) |
| `npm run test:coverage` | The same with `--coverage` (`@vitest/coverage-v8`): text summary plus `coverage/index.html` and `coverage/coverage-summary.json`, for `src/**`. No threshold |
| `npm run test:watch` | `vitest` in watch mode |
| `npx vitest run tests/core/engine.test.ts` | One file; add `-t "name"` to filter by test name |
| `npm run check` | typecheck + tests + `learn:check` + `guide:check` (+ `wiki:check`), see [Tooling and Scripts](Tooling-and-Scripts.md) |
| `npm run e2e` | `BF_E2E=1 wxt build` then `node tests/e2e/run.mjs` (real browser, see [below](#end-to-end-tests-testse2e)) |
| `npm run e2e -- blocks-coverage` | Only the named spec(s) of `tests/e2e/specs/` (file names without `.mjs`); `npm run e2e:run -- <name>` skips the build |

## Layout

| Folder | Environment | Tests |
| --- | --- | --- |
| `tests/core/` | node | Engine, blocks and pure `src/core` modules, through `FakeHost` |
| `tests/browser/` | node | `src/browser/hybridScheduler.ts` with an injected fake clock, alarms and store |
| `tests/dom/` | jsdom (per-file docblock) | `src/dom/*`: page agent, locators, selectors, picker, recorder |
| `tests/editor/` | node | Pure editor model (`flow/convert.ts`), no React rendering |
| `tests/helpers/` | n/a | `fakeHost.ts`: `FakeHost`, `harness()`, `flow()` |
| `tests/e2e/` | Node script, not Vitest | Real browser run via `playwright-core`: `run.mjs` (entry), `harness.mjs` (shared helpers), `specs/*.mjs` (one file per area) |
| `tests/fixtures/site/` | n/a | HTML pages served to the e2e run |

### Environments

[vitest.config.ts](../../vitest.config.ts) includes `tests/**/*.test.ts` and sets `environment: 'node'` for
everything. `src/core` has no DOM or browser API (see [Core Engine](Core-Engine.md)), so Node is enough.
Files that need a DOM opt in with a docblock on their first line:

```ts
// @vitest-environment jsdom
```

All five `tests/dom/*.test.ts` files do this. No other setup file, globals or path aliases exist: tests
import from `vitest` and use relative paths (`../../src/core/...`), as the codebase rule requires.

jsdom is not a browser. If a `tests/dom` test fails, suspect jsdom gaps (selector engine, `composedPath`,
layout: everything has a zero-size box) before suspecting the code. The DOM tests were originally written
against real Chromium.

## What each test file covers

| File | Covers |
| --- | --- |
| [core/engine.test.ts](../../tests/core/engine.test.ts) | Timer as a start block (one-shot, repeating, `{{tick}}`), Open URL, Watch Element as a start block, composing blocks in any order, lifecycle (start/stop, a fresh runner continuing after a "worker restart") |
| [core/runs.test.ts](../../tests/core/runs.test.ts) | If true/false ports, `runOnce` (Run button), step settings (timeout, retries, `onError`, disabled), runs from schedules, conditions, run records |
| [core/blocks.test.ts](../../tests/core/blocks.test.ts) | Set Variable → If → Notify, HTTP Request, Read Element → If → Notify state tracking |
| [core/pageBlocks.test.ts](../../tests/core/pageBlocks.test.ts) | Open Tab and the run's session tab, page actions send the right `AgentRequest`s, Wait For, Read Element on the run's tab, `urlMatches` |
| [core/advanced.test.ts](../../tests/core/advanced.test.ts) | Upload File, Wait for Popup, Dialogs, Run Script, Wait For response |
| [core/dataBlocks.test.ts](../../tests/core/dataBlocks.test.ts) | Extract List / Table, For Each, Repeat, Filter, Transform, Data Table, Paginate, datasets and downloads |
| [core/testing.test.ts](../../tests/core/testing.test.ts) | Assert, screenshots, Run Workflow (sub-workflows), secrets, Manual Step, Stop, Log |
| [core/triggers.test.ts](../../tests/core/triggers.test.ts) | Schedule, Start block, Page Visited / Context Menu triggers |
| [core/moreBlocks.test.ts](../../tests/core/moreBlocks.test.ts) | Scroll (top/bottom/element; "until nothing more loads" with its height check and `maxScrolls`), Page Info (page, local, session, cookies), Page Snapshot (request and outputs), Context Menu (config → menu item, item id parsing, click → payload, a click starting the flow), Page Visited start log, Navigate back/forward/reload, Press Key, Stop, Notify, Repeat |
| [core/config.test.ts](../../tests/core/config.test.ts) | `withDefaults`, `resolveConfig`, `validateConfig` |
| [core/validate.test.ts](../../tests/core/validate.test.ts) | `validateWorkflow` |
| [core/workflow.test.ts](../../tests/core/workflow.test.ts) | `diffWorkflows`, `rootSignature`, `createWorkflow`, sample workflows, timer keys, `uid` |
| [core/library.test.ts](../../tests/core/library.test.ts) | `uniqueName`, clone / duplicate, export / import (refusals carry `issues`) |
| [core/migrate.test.ts](../../tests/core/migrate.test.ts) | v1 → v2 key renames (`selector`/`next` → `locator`), no-op on current workflows, old keys accepted on import |
| [core/evals.test.ts](../../tests/core/evals.test.ts) | The authoring eval set ([tests/evals/tasks.json](../../tests/evals/tasks.json)) is well formed: ten tasks, known check kinds and block types, fixture pages that exist; each reference solution (`tests/evals/solutions`) imports with no issues |
| [core/check.test.ts](../../tests/core/check.test.ts) | `checkFile`: one fixture per issue code (level and JSON path), did-you-mean hints, the blocks' `validate` hooks (import and editor), `parseImport` with errors / warnings, `editDistance` / `closest` |
| [core/expression.test.ts](../../tests/core/expression.test.ts) | Expression language and templates with expressions |
| [core/template.test.ts](../../tests/core/template.test.ts) | `render`, `hasTemplate`, `getPath` |
| [core/csv.test.ts](../../tests/core/csv.test.ts) | CSV parse / write |
| [core/url.test.ts](../../tests/core/url.test.ts) | `normalizeHttpUrl` |
| [core/report.test.ts](../../tests/core/report.test.ts) | JUnit / HTML report generation from run records |
| [core/errors.test.ts](../../tests/core/errors.test.ts) | `errorDetails`, every error code documented (and listed in the usage guide and Troubleshooting), step records with `code` / `locator` / `url` / `matches` / `sourceId` (page errors, soft and hard Assert, HTTP status, missing tab, step timeout, uncoded errors, secrets masked), the versioned JSON report |
| [core/recordingSchedule.test.ts](../../tests/core/recordingSchedule.test.ts) | Schedule parsing, recorded actions → blocks |
| [core/playwright.test.ts](../../tests/core/playwright.test.ts) | Locators and whole workflows → Playwright test source |
| [core/guideExamples.test.ts](../../tests/core/guideExamples.test.ts) | Every `docs/guide/examples/*.blockflow.json`, and every complete JSON example in `docs/guide/README.md`, imports with `parseImport` with no issues at all (strict check) and no editor validation errors |
| [core/script.test.ts](../../tests/core/script.test.ts) | Script format: aliases, shorthands, If rejoin, loop and error branches, ids, issue codes and JSON Pointer paths, several scripts per file, `parseImport` of scripts, `decompile` (and when it returns null) |
| [core/layout.test.ts](../../tests/core/layout.test.ts) | Auto-layout: chains in one row, If and loop port order, joins, several starts, cycles, no overlaps on a random DAG |
| [browser/hybridScheduler.test.ts](../../tests/browser/hybridScheduler.test.ts) | Timers ≥ 30 s (alarms), < 30 s (in-memory + keep-alive), clearing, worker restart, end to end with the engine. Uses local `FakeClock`, `FakeAlarms`, `MemoryTimerStore`. See [Scheduling and Timers](Scheduling-and-Timers.md) |
| [dom/agent.test.ts](../../tests/dom/agent.test.ts) | Page agent ops: click, fill/type, select/check/press, read/wait/detect-form, scraping, frames, upload and locate. See [Page Agent](Page-Agent.md) |
| [dom/snapshot.test.ts](../../tests/dom/snapshot.test.ts) | The `snapshot` op: roles, names, flags and working locators, hidden elements skipped, shadow roots (slots), same-origin and cross-origin frames, the line cap, a part of the page, speed on 100 identical rows; error codes of agent answers (strict with `matches`, waits, wrong element type, invalid locator) |
| [dom/locator.test.ts](../../tests/dom/locator.test.ts) | `parseLocator`, `resolveLocator`, ARIA name/role, `locatorCandidates`. See [Locators](Locators.md) |
| [dom/selector.test.ts](../../tests/dom/selector.test.ts) | `cssEscape`, stable id/class heuristics, `generateSelector` (incl. a property test: every element gets a selector matching only itself), `ElementNavigator`, `sampleText` |
| [dom/picker.test.ts](../../tests/dom/picker.test.ts) | Element picker overlay. See [Picker and Recorder](Picker-and-Recorder.md) |
| [dom/recorder.test.ts](../../tests/dom/recorder.test.ts) | Recorder captures user actions in a page |
| [editor/convert.test.ts](../../tests/editor/convert.test.ts) | Workflow ⇄ React Flow canvas conversion, ports and step settings. See [Editor](Editor.md) |

## fakeHost.ts

[tests/helpers/fakeHost.ts](../../tests/helpers/fakeHost.ts) implements the whole `Host` interface
(`src/core/types.ts`, see [Core Engine](Core-Engine.md) and [Browser Host](Browser-Host.md)) in memory. Every
capability **records** what it was asked in a public array and **answers** through a replaceable property.

### Exports

| Export | Kind | Purpose |
| --- | --- | --- |
| `FakeScheduler` | class (`Scheduler`) | Timers in a `Map` (`timers`). Nothing fires on its own. `take(key)` deletes one-shot timers, keeps periodic ones. `keysNamed(name)` finds keys whose timer name (the part after the third `::`) starts with `name` |
| `MemoryState` | class (`StateStore`) | `Map` in `data` |
| `PageReader` | type | `(options: ReadElementOptions) => Promise<ReadElementResult>` |
| `FakeHost` | class (`Host`) | The fake host, below |
| `Harness` | interface | What `harness()` returns |
| `harness(workflow, host?, maxSteps?)` | function | Builds a `WorkflowRunner` with `createDefaultRegistry()`, collecting logs and runs |
| `flow(nodes, edges)` | function | Compact workflow builder |

### FakeHost: what to replace (inputs)

| Property | Default | Answers |
| --- | --- | --- |
| `pageReader` | `{ found: true, text: '' }` | `page.readElement` (Watch Element, Read Element) |
| `pageTexts(...texts)` | method | Sets `pageReader` to return the texts one per read, repeating the last |
| `agent(tabId, request)` | `{}` | `page.act`: the page agent's reply. Throw to simulate a failure |
| `httpHandler(options)` | `200`, empty body | `http.fetch` |
| `htmlAgent(html, baseUrl, request)` | `{}` | `html.act` (scraping fetched HTML, no tab) |
| `scriptResult` | `null` | `page.runScript` return value |
| `shownDialogs` | `[]` | What `page.dialogs` reports as shown |
| `promptAnswer` | `true` | `prompt.ask` (Manual Step: continue or not) |
| `currentTab` | `null` | `tabs.current()` (Run on Page Visited / Context Menu) |
| `popups` | `[]` | Push `{ openerTabId, tabId, url }` for `tabs.waitForPopup` to consume |
| `responses` | `[]` | Push `{ tabId, url, status }` for `tabs.waitForResponse` |
| `savedWorkflows` | empty `Map` | `workflows.get(id)` (Run Workflow) |
| `secretValues` | `{}` | `secrets.all()` |
| `datasetRows` | empty `Map` | `datasets.read` / `write` (append or replace) |
| `tabUrls` | empty `Map` | Open tabs (id → URL). Pre-seed to simulate an existing tab |

### FakeHost: what to assert on (records)

| Property | Filled by |
| --- | --- |
| `opened` | `tabs.open` options (new tab ids start at 100; `reuseTabId` reuses an open tab) |
| `navigations`, `loads` | `tabs.navigate`, `tabs.waitForLoad` and `open` with a `waitUntil` |
| `actions` | `page.act`: `{ tabId, request, timeoutMs }` |
| `realInputs` | `page.act`: whether `realInput` was requested, in order |
| `reads` | `page.readElement` options |
| `requests` | `http.fetch` options |
| `notifications` | `notify` |
| `dialogSettings`, `scripts` | `page.dialogs`, `page.runScript` |
| `screenshotsTaken` | `screenshots.capture` (returns `shot-1`, `shot-2`, …) |
| `downloaded` | `downloads.save` |
| `prompts` | `prompt.ask` messages |
| `sleeps` | Every `host.sleep(ms)` (timeouts, retry backoff, Assert polling) |
| `scheduler.timers`, `state.data` | Pending timers and block state |

Behaviour worth knowing:

- `page.act` and `tabs.navigate` throw `The tab was closed` if the tab id is not in `tabUrls`.
- `tabs.waitForPopup`, `waitForResponse`, `waitForUrl` throw timeout-style errors immediately when nothing
  matches, so tests of the error path need no waiting.
- **Two kinds of time.** `now()` is a fake wall clock starting at `2026-01-01T00:00:00.000Z`, moved only by
  `advance(ms)`. `sleep(ms)` is virtual: sleeps resolve in order of their due time, one per macrotask, without
  real waiting (a 250 ms poll resolves before a 10 s timeout). `advance` does not fire timers.
- `http.download(url)` returns a fake PNG named after the URL's last segment.

### harness() and flow()

```ts
import { flow, harness } from '../helpers/fakeHost';

const h = harness(
  flow(
    [
      { id: 't', type: 'timer', config: { seconds: 10, repeat: true } },
      { id: 'o', type: 'open-url', config: { url: 'https://example.com/{{tick}}' } },
    ],
    [['t', 'o']], // [from, to] or [from, to, port], e.g. ['if', 'x', 'true']
  ),
);
await h.runner.start();
await h.fire('tick');                       // runs runner.handleTimer for the first timer named "tick…"
expect(h.host.opened[0].url).toBe('https://example.com/1');
```

| `Harness` member | Meaning |
| --- | --- |
| `host`, `runner`, `logs` | The FakeHost, the `WorkflowRunner`, every `LogEntry` |
| `runs` | Latest copy of each `RunRecord` by id, in start order (from the runner's `onRun`) |
| `lastRun()` | The most recently started run |
| `restart()` | A **new** runner for the same workflow and host, like the background worker waking up |
| `fire(name)` | Fires the first scheduled timer whose name starts with `name`; throws if none |
| `messages(level?)` | Logged messages, optionally filtered by level |

`flow()` gives each workflow a unique id (`wf1`, `wf2`, …), `enabled: true`, `schemaVersion: 2`, positions
along x, and edge ids `source-port-target`. Node `step` settings pass through. `harness(wf, host, maxSteps)`
passes `maxSteps` to the runner (loop guard tests).

## Writing a new test

1. **A block or engine behaviour:** put it in the matching `tests/core/*.test.ts`. Build the workflow with
   `flow()`, wire the host's answers (`h.host.agent = async (tabId, request) => …`), run with
   `h.runner.runOnce()` or `start()` + `fire()`, then assert on `h.lastRun()`, `h.host.actions` and friends.
   For a page block, assert on the `AgentRequest` it sends; the agent itself is tested in `tests/dom`.
   See [Adding a Block](Adding-a-Block.md).
2. **A page ability:** add the op to `src/core/page.ts`, implement it in `src/dom/agent.ts`, and test it in
   `tests/dom/agent.test.ts` against a jsdom document (`document.body.innerHTML = …`). See
   [Page Protocol](Page-Protocol.md).
3. **Worker restarts:** call `h.restart()` and drive the new runner. State must come from `host.state`, not
   memory.
4. **Never real timers.** Use `fire()` and `advance()`; `host.sleep` is already virtual.
5. **Guide examples** are covered automatically: drop a valid `*.blockflow.json` into `docs/guide/examples/`.
6. Something that needs a real browser API: add a check to the matching `tests/e2e/specs/*.mjs` (or a new
   spec file; `run.mjs` picks it up) and a fixture page in `tests/fixtures/site/`.

## End-to-end tests (tests/e2e)

`npm run e2e` runs `BF_E2E=1 wxt build` and then `node tests/e2e/run.mjs`. It is not part of `npm test` or
`npm run check` (it needs a browser and takes minutes); CI runs it in its own job (see [CI](#ci)).

Run one area with `npm run e2e -- blocks-coverage` (several: `npm run e2e -- forms scraping`). Add
`BF_HEADLESS=1` to run without a window (`--headless=new`, which loads extensions) and
`BF_BROWSER=/path/to/chrome` to pick the browser. If launching times out (Brave in headless mode does on some
machines), use another browser, e.g. Playwright's Chromium from `npx playwright install chromium`.

### The e2e build

With `BF_E2E=1`, [wxt.config.ts](../../wxt.config.ts) writes to `.output-e2e/` (never mixed up with the build
you load by hand) and moves `debugger` and `userScripts` from `optional_permissions` into `permissions`,
because an automated browser cannot click the permission prompt. See [Build and Release](Build-and-Release.md).

It also defines `import.meta.env.BF_E2E` (`true` only in this build) for test-only hooks, which compile out of
every other build. There is one: the background worker accepts
`{ type: 'bf:e2e-menu-click', menuItemId, info: { pageUrl, selectionText, linkUrl, srcUrl }, tabId }` and
handles it like `contextMenus.onClicked`, because an automated browser cannot open the right-click menu.

### Spec layout

| File | Role |
| --- | --- |
| `run.mjs` | Entry: picks the specs named on the command line (all by default), launches once, runs each spec's default export with the harness, prints the summary, exits 1 on any failed check |
| `harness.mjs` | `launch()`: browser, extension, fixture server and the helpers below |
| `specs/<area>.mjs` | `export default async function (h) { … }`: one area's scenarios (e.g. `snapshot-codes`: Page Snapshot on `snapshot.html`, error codes of failed steps, the JSON export, the 📸 Snapshot page button). Order: `forms`, `editor-detect`, `testing`, `scraping`, `authoring`, `harder-pages`, then any others alphabetically |

A spec that throws is reported as `<name>: spec crashed` and the run goes on with the next spec.

### Harness

| Step | Detail |
| --- | --- |
| Pick a browser | First existing of: `$BF_BROWSER`, `/usr/bin/chromium`, `/usr/bin/chromium-browser`, Brave (`/opt/brave.com/brave-origin/brave`, `/opt/brave.com/brave/brave`), `/usr/bin/google-chrome`, macOS Chrome, newest `~/.cache/ms-playwright/chromium-*`. Fails if none, or if `.output-e2e/chrome-mv3/manifest.json` is missing |
| Serve fixtures | `startServer()` from `server.mjs` on `127.0.0.1:<random port>` |
| Launch | `chromium.launchPersistentContext` (playwright-core) with a temp profile, `--load-extension`, headed by default; `BF_HEADLESS=1` adds `--headless=new` |
| Find the extension | Waits for the service worker; its URL gives the extension id; opens `chrome-extension://<id>/editor.html` |
| Run a workflow | `run(wf)` sends `{ type: 'bf:run-workflow', workflow }` from the editor page, then polls `bf:runs` in `chrome.storage.local` every 200 ms until a finished run appears (90 s limit). See [Message Protocol](Message-Protocol.md) and [Storage Keys](Storage-Keys.md) |
| Seed state | `seedWorkflows(list)` closes the editor (it saves on close), writes `bf:workflows`, reopens it. Secrets go to `bf:secrets` |
| First-run card | Sets `bf:onboarding` to dismissed before the editor opens, so the "Try it" card does not cover the canvas (the `editor-ux` spec brings it back) |
| Report | `check(name, ok, detail)` prints ✓/✗; exit code 1 if any check failed. Last check: no uncaught errors in the editor page. |
| Other helpers | `workflow(name, nodes, edges?)` (ids `e2e-1`, `e2e-2`, …; a straight line by default), `step(record, nodeId)`, `summary(record)`, `openEditor()`, `context`, `worker` (evaluate `chrome.*` in the service worker), `editor` (the current editor page) |

Scenarios by spec:

| Scenario | Fixtures | Exercises |
| --- | --- | --- |
| **forms** | | |
| Classic login | `login.html` → `welcome.html` | Fill Form by label (text, password, select by option text, checkbox), submit, Wait For URL, Read Element, If |
| Wrong password | `login.html` | `onError: 'port'` routing, timeout message, Wait For text |
| Single-page app | `spa.html` | Covered-element detection (cookie overlay), controlled inputs, type mode, select, custom checkbox, disabled button, `pushState` route, shadow DOM (`>>>`) |
| Clear failures | `login.html` | Strict mode (2 matches, `nth=0` hint), missing element timeout message |
| **editor-detect** | | |
| Detect fields | `login.html` + editor UI | Fill Form "Detect fields" through the picker |
| **testing** | | |
| Phase C | `login.html`, `welcome.html` | Run Workflow in the same tab, Assert (hard/soft), failure screenshot, secrets kept out of run records, Manual Step prompt in the editor, Reports tab, JUnit and HTML export |
| **scraping** | | |
| Phase D | `/products` (dynamic), `table.html`, `feed.html`, `login.html` | Paginate + Extract List + Save Dataset + Download CSV, IndexedDB dataset, HTTP Request + Extract Table/List from HTML (offscreen parser), Scroll on an infinite feed, data-driven For Each login, Data tab preview |
| **authoring** | | |
| Phase E | `login.html`, `welcome.html`, `table.html` | Recorder → blocks and replay, Pick on page with alternatives, undo/redo/copy/paste, templates, `{{` autocomplete, Page Visited trigger |
| **harder-pages** | | |
| Phase F | `upload.html`, `popup.html`, `dialogs.html`, `/frames.html` + `frame-inner.html`, `api.html`, `trusted.html`, `login.html` | Upload File, Wait for Popup (`window.open`, `target=_blank`), Dialogs, same- and cross-origin iframes, Wait For response, real (trusted) input via debugger, background-tab screenshot, Run Script (passes or explains Chrome 135+), Playwright export run with `npx playwright test` |
| **scripts** | | |
| M1.2 | `table.html` + editor UI | Importing a `.script.json` through the Import button: blocks laid out (If rejoin), the run passes; Export as script enabled; Tidy up after a drag puts the blocks back on the grid, and Undo reverts it |
| **blocks-coverage** | | |
| Start | none | Starting values on Run; as a called workflow, the caller's value wins and the other default stays |
| Timer | none | 3 s in-run delay; Stop (`bf:stop-run`) during a 30 s delay ends the run as `cancelled`; a repeating 2 s Timer in an enabled workflow starts runs counting `tick` |
| Schedule | none | Switching a workflow on (`bf:workflows`, `enabled: true`) creates alarm `bf::<id>::<node>::next` at the planned minute (`chrome.alarms.getAll()`); switching off clears it |
| Context Menu | `meta.html` | The menu item exists (probed by creating a duplicate id), `bf:e2e-menu-click` runs the flow on that tab with the selection, switching off removes the item |
| Watch Element | `ticker.html` | An enabled watcher (every 2 s, no reload) notices the self-updating price and starts a run with `previous` and `value` |
| Navigate | `spa.html` | goto, reload, back and forward (back/forward fall back to `history.back()` in the page when Chromium's `tabs.goBack` skips entries added without a user gesture) |
| Press Key | `keys.html` | Control+A selects the field (its `select` event fires), Enter submits the form |
| Page Info | `meta.html` | Title, description, canonical, lang, meta tags, JSON-LD (the invalid block skipped), link count; localStorage one key / all; sessionStorage; cookies |
| Stop | none | Pass ends the path with the run passed; fail fails the run with the templated message |
| Repeat, Filter | none | Data Table → Filter → Repeat: `each` three times, then `done` |
| Notify | none | The run passes and `chrome.notifications.getAll()` in the worker lists the notification |
| **snapshot-codes** | | |
| Page Snapshot | `snapshot.html` (+ `frame-inner.html`) | The outline has headings, landmarks, field values, checked/disabled states, the shadow host and its button, the same-origin frame with `frame=#pay >> …` locators, the cut at 1,499 lines, no hidden elements; its frame locators fill and click as they are; a part of the page (`#search`); under 5 s for ~2,000 elements |
| Error codes | `snapshot.html` | `locator.not-found` (with locator and page URL), `locator.strict` (two `matches`), `element.disabled`, `assert.failed` (with locator), `timeout` (text never shown), `locator.invalid`; Export JSON has `schemaVersion` 1 and the codes |
| 📸 Snapshot page | `snapshot.html` | The Open Tab button copies the outline with the title/URL header (the clipboard write is captured in the page: Playwright cannot grant clipboard access to an extension origin) |
| Editor UX (`editor-ux`) | editor UI; `docs/manual-test/playground.html` via `scripts/playground.mjs` on port 7357 | In-editor toasts and confirm/input dialogs (no native ones), the All workflows switch and Turn all on with a problem workflow, `bf:state` cleanup on delete, recorder start-URL check, real-input setting only on page actions, undo per workflow, paste at the mouse, the Try it card and the playground template passing |
| Import checking (`import-check`) | editor UI | Importing a broken file (unknown type, mistyped config key) opens the issues dialog with each code, JSON path and did-you-mean and imports nothing; a file with only warnings imports and its toast's Details lists `page.no-tab`; Escape closes the dialog |
| Authoring evals (`evals`) | every page used by [tests/evals/tasks.json](../../tests/evals/tasks.json) | Each reference solution in `tests/evals/solutions/` is imported through the editor (compiled and checked), run, and scored with its task's checks (`status`, `output` at a dot path, `step-type`); the scorer the M4 CLI will reuse |

The Playwright export step writes `.output-e2e/playwright/exported.spec.ts` plus a config and runs it with
`LOGINPASSWORD` set, so `@playwright/test` is a dev dependency only for this.

### server.mjs

Exports `PASSWORD` (`Op3n-Sesame!`, the only password the fixture login accepts) and `startServer()`.

| Route | Response |
| --- | --- |
| `POST /login` | 303 to `/welcome.html?name=…&country=…&remember=…` if the password matches and an email was sent, else `/login.html?error=1` |
| `GET /api/slow` | After 700 ms, JSON `{ order }` with a rising number |
| `POST /api/save` | After 400 ms, `201 {"saved":true}` |
| `/frames.html` | Two iframes of `frame-inner.html`: `#same` (127.0.0.1) and `#other` (`localhost`, so cross-origin) |
| `/products?page=1..3` | 3 product cards per page, `a.next` except on page 3 |
| `/spa/*` | `spa.html` (client-side routes) |
| `/` | `login.html` |
| anything else | File from `tests/fixtures/site`, or 404 |

### Fixture pages

| Page | What it is |
| --- | --- |
| `login.html` | Server-rendered form (email, password, country select, remember checkbox, Sign in, "Forgot password?") that posts and loads a new page |
| `welcome.html` | `#greeting` "Welcome, name!" and the submitted country / remember values |
| `spa.html` | Single-page app: cookie banner overlay, controlled inputs, plan select, custom checkbox, disabled-until-valid button, `pushState` to `/spa/done`, `#order`, `<fancy-counter>` web component with shadow DOM |
| `table.html` | `#prices` table with relative links, `h1` "Prices" |
| `snapshot.html` | For Page Snapshot and error codes: banner with a named nav, a search form (value, select, checked checkbox, disabled Reset), two "Add to cart" buttons (strict), hidden promos, `<shop-badge>` with a shadow button, `#pay` iframe of `frame-inner.html`, `#greeting`, and 600 generated list items (past the line cap) |
| `feed.html` | Infinite scroll feed of `article.post` (40 in total) |
| `popup.html` | `window.open` button and a `target=_blank` link |
| `dialogs.html` | `confirm` (`#del`) and `prompt` (`#ask`) writing to `#result` |
| `frame-inner.html` | Card number field + Pay button showing which origin it ran in |
| `api.html` | Save button that POSTs to `/api/save` |
| `trusted.html` | Only reacts to trusted events (`event.isTrusted`), like some anti-bot checks |
| `upload.html` | Custom upload button over a hidden file input; echoes name, type and content |
| `meta.html` | Title, description and Open Graph meta, canonical link, `lang="en-GB"`, two JSON-LD blocks (one invalid), two links; sets localStorage `theme`/`cart`, sessionStorage `visit`, cookies `currency`/`consent` |
| `keys.html` | Search form (`label=Search`) whose submit writes `submitted: <value>` to `#status`; selecting the field writes `selected N of M` |
| `ticker.html` | `#price` counts up from 100 every 1.5 s, by itself |

## Firefox e2e (tests/e2e/firefox.mjs)

`npm run e2e:firefox` builds `.output-e2e/firefox-mv3` and runs a smoke test in Firefox. Playwright can't
load extensions into Firefox, so the runner starts Firefox itself (`--headless`, `BF_HEADED=1` to watch,
`BF_FIREFOX=/path` to choose the binary) and talks WebDriver BiDi: `webExtension.install` loads the build
as a temporary add-on, with a fixed `moz-extension://` UUID set through the profile's prefs.

Firefox's BiDi can't open `moz-extension://` pages, so the runner can't use the editor. Instead, e2e builds
register a bridge content script on `http://127.0.0.1/*`
([e2e-bridge.content.ts](../../src/entrypoints/e2e-bridge.content.ts)). A fixture page posts
`{ bfE2e, op, arg }` (`send` a runtime message, `get` from `storage.local`, `ping`) and the bridge answers.
Workflows run through `bf:run-workflow`, exactly like the Chromium specs.

The 14 checks cover forms, HTML parsing without an offscreen document, `storage.session` watch tabs,
upload, popups, dialogs, IndexedDB datasets, in-run delays, screenshots on failure, Notify, and the
"Chromium only" errors for Run Script and real input. CI runs it in the `e2e-firefox` job.

## Manual test pages

[docs/manual-test/playground.html](../manual-test/playground.html) has things to watch, click and fill; the
editor's "Try it" card and the `playground-tour` template use it, and the `editor-ux` e2e spec runs that
template against it. [docs/manual-test/clock.html](../manual-test/clock.html) shows the load time (changes on
every reload) and a line that never changes. Serve both with `npm run playground`
(`http://localhost:7357`, [scripts/playground.mjs](../../scripts/playground.mjs)) and follow README
[Try it end to end](../../README.md#try-it-end-to-end) to check Watch Element firing on change and not firing
on the stable line. Results of manual runs are logged in README
[What has been verified](../../README.md#what-has-been-verified).

## CI

[.github/workflows/ci.yml](../../.github/workflows/ci.yml) runs on pushes to `main` and on pull requests, with
two jobs on Ubuntu and Node 22:

- `check`: `npm ci`, `typecheck`, `npm run test:coverage` (uploads `coverage/` as the `coverage` artifact),
  `learn:check`, `guide:check`, `wiki:check`, `build`, `build:firefox`.
- `e2e`: `npm ci`, `npx playwright install --with-deps chromium`, then `BF_HEADLESS=1 xvfb-run -a npm run e2e`
  with `BF_BROWSER` set to Playwright's Chromium (`chromium.executablePath()` from `playwright-core`).

The GitHub mirror only receives `main`, so there both jobs run after a merge. Details in
[Tooling and Scripts](Tooling-and-Scripts.md#ci-workflow).

## See also

- [ARCHITECTURE.md, Testing strategy](../ARCHITECTURE.md#testing-strategy)
- [Lesson 8: Testing, debugging, publishing](../learning/08-testing-debugging-publishing.md)
- [Adding a Block](Adding-a-Block.md) · [Core Engine](Core-Engine.md) · [Page Agent](Page-Agent.md) · [Scheduling and Timers](Scheduling-and-Timers.md)
- [Build and Release](Build-and-Release.md) · [Tooling and Scripts](Tooling-and-Scripts.md)
