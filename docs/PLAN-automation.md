# Plan: browser automation, testing and scraping

Status (2026-10-23): **Phases A to E built** (see the table in section 6 for what is in and what moved).
Phase F is a plan. Usage guide for people and AI tools: docs/guide/README.md. Today BlockFlow has 8 blocks
(Timer, Open URL, Watch Element, Read Element, If, Set Variable, HTTP Request, Notify), a workflow
manager and a run log.

Goal: make BlockFlow a no-code Playwright that runs inside the user's own browser. A user should be
able to open a site, fill a form, click, wait for the page (or SPA route) to change, read the result,
assert it, and get a report, a notification or a dataset out of it. The same blocks must also work for
scraping (pages, lists, pagination) and for monitoring (scheduled checks).

The design rule throughout: **few generic blocks with shared building parts**, not one block per site
or per task. A login test, a price scraper and a form filler should all be the same ~10 blocks wired
differently.

---

## 1. What changes, in one picture

```text
             ┌──────────── editor ─────────────┐
             │ canvas · run button · step       │
             │ inspector · recorder · reports   │
             └───────────────┬─────────────────┘
                             │ storage + messages
┌────────────────────────────▼─────────────────────────────┐
│ background worker                                         │
│  core engine (pure TS)                                    │
│    ports (true/false/error/each/done) · runs · retries    │
│    timeouts · run journal · sessions (named tabs)         │
│  Host  ──────────────────────────────────────────────┐    │
│    browser driver: tabs, navigation, network, shots  │    │
│    page driver ──► page agent (content script, per   │    │
│                    frame): locators, actionability,  │    │
│                    actions, extraction, highlight     │    │
│    optional CDP driver (Chromium, chrome.debugger)    │    │
│    data: datasets (IndexedDB), downloads, secrets     │    │
└──────────────────────────────────────────────────────┴────┘
```

Three new layers do most of the work:

1. **Engine upgrades**: ports, real "runs", error handling, long flows that survive the worker sleeping.
2. **Page agent + Locator**: one content script that finds elements the way Playwright does and acts on them.
3. **Sessions**: a run keeps track of its own tabs by name, so "Open → Fill → Click → Wait → Read" all
   hit the same tab.

---

## 2. Core concepts

### 2.1 Locator (shared by every page block)

One string field kind, `kind: 'locator'`, in Playwright-like syntax so it is readable, templatable,
JSON-safe, and exportable to real Playwright later.

| Syntax | Finds |
| --- | --- |
| `css=form#login input[name=email]` or plain CSS | CSS selector |
| `text=Sign in` / `text="Sign in"` (exact) / `text=/sign ?in/i` | visible text |
| `role=button[name="Submit"]` | ARIA role + accessible name |
| `label=Email` | input by its label (`for`, wrapping, `aria-labelledby`) |
| `placeholder=you@example.com` | input placeholder |
| `testid=login-btn` | `data-testid` (attribute name configurable: `data-test`, `data-cy`) |
| `xpath=//table//tr[2]` | XPath |
| `A >> B` | B inside A (chaining) |
| `css=my-app >>> button` | pierce open shadow roots |
| `frame=iframe#pay >> label=Card number` | inside an iframe |
| suffix `>> nth=2` | the 3rd match |

The picker (exists today) is upgraded to return **ranked candidates** (testid > role+name > label >
text > short CSS), each with its match count, and the user picks one. Unique matches are preferred.

### 2.2 Sessions and tabs

A run carries a small `$session` object in its payload: `{ tabs: { main: 123, popup: 456 } }`. It is
JSON, so it survives timers and worker restarts like any other payload.

- Every page block has a **Tab** field, default `main`.
- **Open Tab** creates or reuses a named tab and records it in `$session`.
- If a page block runs and its tab does not exist yet, it fails with a clear message
  ("No tab named main. Put an Open Tab block first.").
- Watch Element and Read Element keep their current "own background tab per URL" mode for monitoring
  (no Tab set = old behaviour), so existing workflows keep working.

### 2.3 Ports (branching, loops, errors)

Edges get a `sourcePort` (default `out`, so old workflows load unchanged). A block returns
`{ port, payload }` or just a payload (= `out`).

| Port | Used by |
| --- | --- |
| `out` | every block |
| `true` / `false` | If |
| `case:<name>` / `default` | Switch |
| `each` / `done` | For Each, Loop, Paginate |
| `error` | every block, when "On error → error port" is chosen |

The editor draws one output dot per port with a label. The block definition declares its ports:
`ports?: string[] | (config) => string[]`.

### 2.4 Common step settings (engine level, not per block)

Every block gets the same "Step" section in the settings panel, so no block has to re-implement them:

- **Timeout** (default 30s for page blocks)
- **Retries** (0 to 5) with backoff
- **On error**: stop the run / continue with input / send to `error` port
- **Disabled** (skip this step, pass input through) for debugging
- **Screenshot**: never / on error / always (page blocks)
- **Note** (free text shown on the block)

### 2.5 Runs

Today a workflow is either On (background) or Off. Add the notion of a **run**:

- `runId`, trigger (manual, schedule, page event, recorder replay), start/end, status
  (running, passed, failed, cancelled, interrupted), per-step results (input, output, duration,
  error, screenshot id).
- **Run** button in the editor: runs the workflow once, now, with live step highlighting. Works for
  workflows that are Off. This is the main mode for tests.
- **Stop** button: cancels the run (engine checks a cancel flag between steps; page waits abort).
- Run history per workflow, kept in IndexedDB with a size cap.

### 2.6 Conditions (shared by If, Assert, Wait, Loop-until, Filter)

Move the comparison logic of today's If block into `src/core/condition.ts`:

- operands are templated strings; operators: equals, not equals, contains, starts/ends with, matches
  regex, >, >=, <, <=, is empty, is not empty, is true, is false, length equals
- several clauses joined by **all** / **any**
- numbers parse `1,250` and `$9.99`

Then If, Assert, Wait Until, Loop Until and Filter are thin wrappers around the same condition editor.

### 2.7 Expressions without `eval`

MV3 forbids running code from strings in extension pages and the worker. Templates stay `{{path}}`.
Add a small **safe expression interpreter** (parse → AST → evaluate, no `eval`) for things like
`{{ value * 1.1 }}`, `{{ items.length }}`, `{{ upper(name) }}`, `{{ now('yyyy-MM-dd') }}`. Fixed set
of helper functions. Arbitrary JavaScript is a separate, opt-in block (see 4.6).

---

## 3. Block catalogue (target)

Existing blocks are marked ✅. Each row lists the shared parts it uses, so the reuse is visible.

### 3.1 Triggers (start a run)

| Block | Does | Shared parts |
| --- | --- | --- |
| ✅ Timer | every N s, or delay | scheduler |
| Manual | starts on the Run button, a keyboard shortcut (`commands`) or the toolbar menu; can ask for input values | run inputs |
| Schedule | cron-style ("weekdays 9:00") on top of alarms | scheduler |
| Page Visited | fires when a tab navigates to a URL pattern (`webNavigation`, includes SPA `onHistoryStateUpdated`) | url pattern |
| Context Menu | "Run on this page / this element" from the right-click menu; passes url, selection, element locator | locator |
| ✅ Watch Element | change on a page | locator, page driver |

### 3.2 Tabs and navigation

| Block | Does |
| --- | --- |
| Open Tab (replaces ✅ Open URL, kept as alias) | open URL in a named tab: new tab / reuse / current tab / new window; background or focused; wait until load / DOM ready / network idle |
| Navigate | go to URL, back, forward, reload in a session tab |
| Switch Tab | adopt an existing tab by URL/title pattern into the session (e.g. the tab the user is on) |
| Wait for Popup | catch a tab opened by the page (`tabs.onCreated` + `openerTabId`), name it |
| Close Tab | close a session tab |
| Screenshot | visible area (`tabs.captureVisibleTab`), element crop, full page (CDP); saved to run report or downloaded |

### 3.3 Page actions (all use Locator + actionability + Tab + Step settings)

| Block | Does |
| --- | --- |
| Click | click / double / right / hover / middle; modifiers; position |
| Fill | set a field (input, textarea, contenteditable): fill (instant) or type (per-key with delay); clear first |
| Fill Form | **many fields in one block**: a list of `locator → value` rows; "Detect fields" button picks a `<form>` and generates rows from labels; works with CSV rows (`{{row.email}}`) |
| Select Option | by value, label or index; multi-select |
| Check / Uncheck | checkbox, radio, switch (`role=switch`) |
| Press Key | `Enter`, `Tab`, `Control+A`, … on an element or the page |
| Upload File | set files on `<input type=file>` from a stored file or downloaded data (DataTransfer) |
| Scroll | to element, by pixels, to bottom (for lazy lists), until a condition holds |
| Submit Form | `form.requestSubmit()` |
| Handle Dialog | pre-set the answer to the next `alert/confirm/prompt` |

### 3.4 Waiting (the SPA problem)

One **Wait For** block with a mode select, so users learn one block:

- element: attached / visible / hidden / detached / enabled
- text appears / disappears (anywhere or in a locator)
- URL matches pattern (catches SPA route changes via `onHistoryStateUpdated`)
- network idle (no requests for N ms; counted with `webRequest` observe events per tab)
- response: a request matching a URL pattern finishes, with status (and body via CDP)
- condition: any condition (2.6) on a value read each poll
- fixed delay (✅ Timer as delay stays too)

Every page action also **auto-waits** for its own element (attached, visible, stable, enabled,
not covered) before acting, like Playwright. Most flows need no explicit waits.

### 3.5 Reading and extracting

| Block | Does |
| --- | --- |
| ✅ Read Element | one value: text, attribute, class, exists, count (+ previous/changed). Add: input value, `innerHTML`, CSS property, all matches as a list |
| Extract List | container locator + field map (`title: h2`, `price: .price`, `link: a@href`) → array of objects. The core scraping block |
| Extract Table | an HTML table → array of row objects using header cells as keys |
| Page Info | url, title, meta tags, `<link rel=canonical>`, JSON-LD |
| Read Storage | cookies (`cookies` API), localStorage/sessionStorage (page agent) |
| Fetch & Parse | HTTP request + parse HTML in an offscreen document with the same Locator syntax, no tab at all. Fast scraping for static pages |

### 3.6 Assertions (testing)

| Block | Does |
| --- | --- |
| Assert | condition (2.6) on any value, or a page shortcut: element visible / has text / has value / count / URL / title. Fail → run fails, step marked red, screenshot taken. "Soft" option: record the failure and continue |
| Expect Page | several assertions about one page in one block (checklist) |

### 3.7 Logic and data flow

| Block | Ports | Does |
| --- | --- | --- |
| ✅ If | true, false | condition |
| Switch | case:*, default | first matching case |
| For Each | each, done | iterate a list (from Extract List, CSV, JSON); `{{item}}`, `{{index}}` |
| Loop | each, done | repeat N times or until a condition; hard cap |
| Paginate | each, done | read page → click "Next" (locator) → wait → repeat until Next is gone or N pages |
| Filter | out | drop list items that fail a condition |
| ✅ Set Variable | out | now several `name = expression` rows |
| Transform | out | map/rename/pick fields with expressions; parse JSON; split text |
| Run Workflow | out, error | call another workflow as a function with inputs, get its outputs back (reuse "Login" in many tests) |
| Manual Step | out | pause the run, show a notification "Solve the CAPTCHA, then press Continue", resume on click |
| Stop / Fail | none | end the run as passed or failed with a message |

### 3.8 Output and integrations

| Block | Does |
| --- | --- |
| ✅ Notify | desktop notification; add buttons ("Open page") |
| ✅ HTTP Request | API / webhook (Slack, Discord, n8n, Zapier) |
| Save to Dataset | append rows to a named dataset (IndexedDB) |
| Export | dataset or value → CSV / JSON / XLSX download (`downloads` API) |
| Copy to Clipboard | via offscreen document |
| Log | write a custom line to the run log |

### 3.9 Test data and secrets

- **Data tables**: import CSV/JSON in the editor; Manual trigger can iterate rows ("run once per row")
  for data-driven tests.
- **Secrets**: stored separately from workflows, referenced as `{{secret.loginPassword}}`, masked as
  `•••` in logs, step inspector and exports, never included in workflow export files. Optional
  passphrase encryption with WebCrypto.

Block count after all phases: about 40, but they share 6 building parts (locator, tab, step settings,
condition, expression, list/each), so each new block is mostly configuration.

---

## 4. Browser extension limits and how we handle them

| Limit | Effect | Plan |
| --- | --- | --- |
| Synthetic events have `isTrusted = false` | some sites (anti-bot, payment widgets, some drag & drop) ignore our clicks/keys | page agent first (all browsers). Optional **CDP driver** via `chrome.debugger` (Chromium only, optional permission) sends real input with `Input.dispatchMouseEvent`/`insertText`. Shows the "BlockFlow started debugging this browser" bar while attached. Per step: "Use real input" checkbox |
| React/Vue/Angular controlled inputs ignore `el.value = x` | form fills "do nothing" | set through the native prototype setter, then dispatch `input` + `change` (+ `blur`). Tested against React 19, Vue 3, Angular fixtures |
| MV3 worker sleeps after ~30s idle | long flows die | runs keep the worker busy with extension API calls (polling waits do this naturally); waits longer than 30s go through the scheduler (exists); **run journal** writes the current step + payload before each step. On worker start: unfinished runs become "interrupted" with a Resume button (resume from the last step) |
| Background tabs are throttled; hidden tabs skip rendering, `IntersectionObserver`, `requestAnimationFrame` | lazy lists never load, animations never finish, screenshots blank | "Run in" setting per workflow: background tab (monitoring), **separate window** (default for tests), current tab. Scroll block triggers lazy loading. Warn when a run in a background tab times out |
| No running code from strings (MV3 remote code ban) | no "Execute JavaScript" box in the normal way | (a) safe expression language for 90% of needs; (b) **Run Script** block using `chrome.userScripts` (user must enable "Allow User Scripts"; Firefox has `userScripts` too); (c) MAIN-world built-in functions for common needs (read a JS global like `window.__NEXT_DATA__`) |
| Page CSP | blocks inline code in MAIN world | `scripting.executeScript` with a bundled function is not affected; userScripts are exempt from page CSP |
| Restricted pages: `chrome://`, Web Store, other extensions, PDF viewer, `view-source:` | cannot inject | clear error "Browsers do not let extensions run on this page"; `file://` needs the user toggle "Allow access to file URLs" |
| Cross-origin iframes | need host permission, separate frame ids | agent injected into all frames (`allFrames` / `frameIds` from `webNavigation.getAllFrames`); `frame=` locators |
| Closed shadow roots | invisible to DOM APIs | CDP driver only (`DOM.describeNode` with `pierce`) |
| Native file chooser, OS dialogs, print, download prompts | not scriptable | Upload File sets files directly; downloads via `downloads` API; `alert/confirm/prompt` handled by overriding in MAIN world before the action (or `Page.handleJavaScriptDialog` in CDP) |
| HTTP basic auth prompt | blocks the page | `webRequest.onAuthRequired` (Chrome MV3 needs `webRequestAuthProvider`) with a secret |
| CAPTCHA, 2FA | must not be bypassed | Manual Step block: pause, notify, continue when the user says so |
| Response bodies | `webRequest` gives URL/status/headers only | Wait For response checks status; body needs CDP (`Network.getResponseBody`) or an HTTP Request block |
| `storage.local` ~10 MB | screenshots and datasets would overflow | IndexedDB for runs, screenshots, datasets; `unlimitedStorage` permission; caps and "clear old runs" |
| `alarms` minimum ~30s | short schedules | already solved by `HybridScheduler` |
| Firefox | no `chrome.debugger`; host access is opt-in; `world: 'MAIN'` needs Firefox 128+ | CDP features hidden on Firefox; permission request screen on first run of a workflow |
| Safari | `webRequest`, `debugger`, `userScripts` limited or missing (to verify) | feature detection in the Host; editor greys out blocks the browser cannot run |
| No CI / headless | users want tests in CI | **Export as Playwright test** (`.spec.ts`): locators already use Playwright syntax, so most page blocks map 1:1. Unsupported blocks become `// TODO` comments |
| Permissions look scary | store review and user trust | move to `optional_host_permissions` per workflow (ask for `https://akibh.dev/*` only); `debugger`, `userScripts`, `cookies`, `downloads` all optional and requested by the block that needs them |

---

## 5. Engine and code changes

### 5.1 Types (sketch)

```ts
// src/core/types.ts
export interface EdgeDef { id: string; source: string; target: string; sourcePort?: string } // default 'out'

export interface StepSettings {
  timeoutMs?: number; retries?: number; onError?: 'stop' | 'continue' | 'port';
  disabled?: boolean; screenshot?: 'never' | 'error' | 'always'; note?: string;
}
export interface NodeDef { /* … */ step?: StepSettings }

export type RunResult = Payload | null | void | { port: string; payload: Payload };

export interface BlockDefinition<C> {
  /* … */
  ports?: string[] | ((config: C) => string[]);
  category: 'trigger' | 'tab' | 'action' | 'wait' | 'read' | 'assert' | 'logic' | 'data' | 'output';
  needs?: Capability[]; // 'page' | 'cdp' | 'downloads' | 'userScripts' … for permissions + feature detection
}

export interface Host {
  /* existing … */
  browser: BrowserDriver;   // tabs, navigation, windows, screenshots, network, dialogs
  page: PageDriver;         // run(tabId, request) → page agent; request = { op, locator, options }
  data: DataStore;          // datasets, runs, screenshots (IndexedDB)
  secrets: SecretStore;
  capabilities(): Capability[];
}
```

`PageDriver.run` takes one serialisable request (`{ op: 'click' | 'fill' | 'read' | 'extract' | 'waitFor' …, locator, options }`)
so one message path serves every page block, and FakeHost can fake the page with a tiny in-memory model
or jsdom.

### 5.2 Engine

- `emitFrom(nodeId, payload, port)`: only edges with that port.
- Step wrapper does timeout, retries, onError, disabled, screenshot, timing and step-result recording,
  in one place (`runStep()`), so blocks stay small.
- Replace `maxDepth = 25` by a per-run step budget (default 10 000) plus a per-node visit cap, since a
  50-step test or a 200-item For Each is normal now.
- `RunContext`: `runId`, cancel signal, step results sink, journal writer. Monitoring flows also get runs
  (one per trigger firing), so the history view works for both.
- `For Each` emits `each` per item and awaits the subtree (current `await emit` semantics already do
  this), then `done` with `{ items, results }`.

### 5.3 Page agent (`src/entrypoints/agent.content.ts`, `registration: 'runtime'`)

- Injected once per frame on demand (`scripting.executeScript({ files: ['/content-scripts/agent.js'] })`),
  keeps its state in the isolated world, answers `executeScript` calls through a small dispatcher.
- Modules in `src/dom/`: `locator.ts` (parse + resolve all syntaxes; extends today's `selector.ts`),
  `aria.ts` (implicit roles + accessible name, the simplified spec), `actionability.ts` (visible,
  stable over 2 frames, enabled, hit-test with `elementFromPoint`), `actions.ts` (click sequence
  pointerdown → mousedown → pointerup → mouseup → click with coordinates; fill with native setter;
  select; check; keys), `extract.ts`, `highlight.ts` (outline the element being acted on during runs).
- MAIN-world helpers (`world: 'MAIN'`) for dialogs and JS globals only.

### 5.4 Editor

- Output dots per port with labels; "Step" settings section; locator field with picker candidates and
  live "matches 1 element" check against the open tab.
- **Run / Stop** buttons, live node status (running, passed, failed, skipped), **step inspector**
  (input, output, error, screenshot for the selected node, n8n style).
- `{{` autocomplete from the outputs of upstream blocks.
- Undo/redo, copy/paste blocks, block groups with titles, comments.
- **Recorder**: "Record" opens the target tab; a recorder content script turns clicks, typing
  (debounced into Fill), selects and navigations into a block chain with good locators. A hover
  toolbar on the page adds "Assert visible / Assert text / Extract this" steps.
- Reports page: run list, filter by status, run detail with steps and screenshots, export JSON /
  JUnit XML / HTML.
- Templates: "Login test", "Fill form from CSV", "Scrape list to CSV with pagination",
  "Price drop alert", "Uptime check".

---

## 6. Phases

Each phase ends with: `npm run check` green, e2e green in Brave/Chromium, README "verified" table and
the matching learning lesson updated (CLAUDE.md rule).

| Phase | Builds | Done when |
| --- | --- | --- |
| **A. Engine foundation** ✅ built 2026-10-23. Not yet: Resume for interrupted runs (they are marked, with "Run" to start again), If with several and/or clauses in the UI (`condition.ts` supports them), run history in IndexedDB (uses `storage.local`, last 40 runs, payloads over 3 KB stored as a preview) | ports + migration, step settings, runStep wrapper, runs + journal, cancel, step budget, conditions core, If with true/false, Run/Stop button, live node status, step inspector | an If with two branches works in the editor; a failing step routes to `error`; a manual run shows per-step input/output; killing the worker mid-run marks it interrupted |
| **B. Page agent + sessions** ✅ built 2026-10-23 (`npm run e2e`, Chrome-family only so far; Firefox not run). Open URL became Open Tab (same type id, old settings still work). Not yet: frame= locators (phase F), a recorder-style ranked picker (the picker still returns CSS; phase E) | locator engine, actionability, agent content script, `$session` tabs, Open Tab, Navigate, Click, Fill, Fill Form (+ Detect fields), Select, Check, Press Key, Wait For (element, URL, network idle, text), Read Element on session tabs | the fixture login form (React-controlled, SPA redirect) is filled, submitted and its success message read, in Chrome and Firefox |
| **C. Testing** ✅ built 2026-10-23. Expect Page folded into Assert (chain Asserts; soft mode for a checklist). Runs stay in storage.local (40); screenshots in IndexedDB. Secrets are not encrypted (a passphrase is a later option) | Assert, Expect Page, screenshots on failure, run history in IndexedDB, reports page, JUnit/HTML export, Manual Step, Run Workflow (sub-flows), secrets | "Login" sub-flow reused by 3 tests; a broken selector gives a red step with a screenshot and a readable message |
| **D. Scraping and data** ✅ built 2026-10-23. Plus Scroll and Page Info (with storage/cookies). Data tables are a Data Table block feeding For Each rather than a per-row Manual trigger. Loop "until a condition" is not built (Repeat has a count) | Extract List, Extract Table, For Each, Loop, Paginate, Filter, Transform + expression language, datasets, Export CSV/JSON, data tables, Fetch & Parse (offscreen) | scrape a 3-page fixture list into a CSV; data-driven test runs once per CSV row |
| **E. Recorder and productivity** ✅ built 2026-10-23. Plus a Start block with starting values and a Schedule block. Context Menu passes url/selection/link/image, not the right-clicked element's locator. Block groups/comments on the canvas are not built | recorder, assert-from-page toolbar, picker candidates, `{{` autocomplete, undo/redo, copy/paste, templates, Page Visited and Context Menu triggers | recording the fixture login produces a flow that replays green without edits |
| **F. Power features** | CDP driver (real input, full-page screenshot, response bodies, closed shadow DOM), dialogs, popups, iframes, Upload File, userScripts Run Script, Export as Playwright, per-workflow optional permissions | a flow with an iframe payment field and a popup login passes; exported `.spec.ts` passes under `npx playwright test` |

Order matters: A is needed by everything; B is the heart of form filling; C and D can swap.

---

## 7. Testing strategy for this work

- **Core** (engine, conditions, expressions, ports, runs): Vitest with `FakeHost`, as today.
- **Page agent** (`src/dom/*`): jsdom for logic, plus a real-Chromium run for layout-dependent parts
  (visibility, hit testing, ARIA names), since jsdom has no layout.
- **Fixture site** in `tests/fixtures/site/`: login form (plain + React-controlled), SPA with a client
  router, slow API, infinite-scroll list, paginated table, iframe (cross-origin via a second port),
  shadow DOM widget, `confirm()` dialog, popup window, file upload.
- **E2E**: `npm run e2e` with `playwright-core` (dev dependency) loading `.output/chrome-mv3` into
  Chromium/Brave with a temp profile, seeding workflows through `chrome.storage`, and checking run
  results. Same approach already used to verify the akibh.dev flows by hand.
- Firefox: `web-ext run` smoke test per phase.

---

## 8. Open decisions

1. **Item model**: keep one payload per step (simple, current) and use For Each for lists, or move to
   n8n-style "every block processes a list of items"? Plan assumes the first; it is easier to learn
   and maps 1:1 to Playwright scripts.
2. **CDP driver by default on Chromium?** More reliable input, but the debugging bar is alarming.
   Plan: off by default, per-step opt-in, workflow-level "Always use real input".
3. **Run window**: separate window for manual runs (reliable, visible) vs background tab (quiet).
   Plan: window for manual runs, background tab for scheduled monitoring, user can change it.
4. **Name**: Open URL → Open Tab rename, with the old type id kept as an alias so saved workflows load.
