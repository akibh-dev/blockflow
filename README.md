# BlockFlow

**Playwright-compatible automation in your browser.** Build automations by connecting blocks (n8n style) in a
visual editor, or write them as JSON scripts, by hand or with an LLM.
Works in Chrome, Firefox and Safari from one codebase ([WXT](https://wxt.dev) + React + TypeScript).

**Status: prototype 1.** 42 blocks (full list: [block reference](docs/guide/blocks.md)), a canvas editor, and a background engine. See
[What has been verified](#what-has-been-verified) before you rely on it.

**Using BlockFlow, or asking an AI to build workflows for you?** Read the
[usage guide](docs/guide/README.md) and the generated [block reference](docs/guide/blocks.md)
(`llms.txt` points AI tools there).

## The idea

Every block has an **input** (left dot) and an **output** (right dot). Connect any block's output to any
other block's input. The data a block produces becomes available to the next block.

| Block | What it does | Output data |
| --- | --- | --- |
| ▶️ **Start** · 📅 **Schedule** · 🌍 **Page Visited** · 🖱 **Context Menu** | Start by hand with starting values; at set times (daily 09:00, weekdays, hourly, every N min); when you open a matching page; from the right-click menu. | your values; `firedAt`; `url`, `title`; `url`, `selection`, `link` |
| 🔗 **Open Tab** | Opens a page in a new tab, the workflow's own reused tab, a new window or the current tab, waits for load / network idle, and **names the tab** (`main`) for the blocks after it. | `url`, `tabId` |
| 👆 **Click** | Click, double-click, right-click or hover an element. Waits until it is visible, enabled, still and not covered. | passes input through |
| ⌨️ **Fill** | Types into a field (all at once, or key by key). Works with React/Vue/Angular forms. | passes input through |
| 📋 **Fill Form** | Many fields in one block (text, selects, checkboxes), optional submit click. **🎯 Detect fields** lists a form's fields for you. | passes input through |
| 🔽 **Select Option** · ☑️ **Check** · ⏎ **Press Key** | Dropdowns by text or value; tick/untick; Enter, Tab, Control+A… | |
| ⏳ **Wait For** | Element visible/hidden/gone/enabled, text appears/disappears, URL matches (also SPA route changes), page load, network quiet. | `url` |
| 🧭 **Navigate** · ✖️ **Close Tab** | Go to URL, back, forward, reload; close a tab of the run. | `url` |
| ✅ **Assert** | The test step: text, input value, attribute, count, visible, checked, enabled, URL, title, or any `{{value}}`. Page checks retry until they pass. **Soft** mode records the failure and goes on. | `actual` |
| 🧩 **Run Workflow** | Calls another workflow like a function (e.g. a reusable "Log in"), in the same tab; continues with its result. | its data |
| 🧺 **Extract List** · 📊 **Extract Table** | Scrape repeated items (fields by locator, links absolute) or a table, from a tab or from fetched HTML (no tab). | `items` / `rows`, `count` |
| 📄 **Paginate** · 🖱️ **Scroll** · ℹ️ **Page Info** | Click Next through pages; scroll infinite lists to the end; title/meta/JSON-LD, localStorage, cookies. | `page`; `page`/`value` |
| 🔁 **For Each** · 🔂 **Repeat** · 🧹 **Filter** · 🧮 **Transform** | Loop over a list (`each`/`done` outputs), N times; keep matching items; compute values with expressions (`sum(pluck(items,'price'))`). | `item`, `index` |
| 🗂️ **Data Table** · 💾 **Save to Dataset** · ⬇️ **Download** | Paste CSV/JSON test data; keep rows between runs (Data page); save CSV/JSON files. | `rows`; `datasetSize`; `file` |
| 📎 **Upload File** · 💬 **Dialogs** · 🪟 **Wait for Popup** · 🧑‍💻 **Run Script** | Files without the file dialog; answer alert/confirm/prompt; catch new tabs/windows; your own JS (Chrome 135+). | `uploaded`; `dialogs`; `popupUrl`; `result` |
| ✋ **Manual Step** · ⏹ **Stop** · 📝 **Log** | Pause until you press Continue (CAPTCHA, 2FA); end a path as passed/failed; write to the log. | |
| ⏱ **Timer** | Nothing connected to it: starts the flow every N seconds (or once). After another block: **delays** the flow by N seconds. | `tick`, `firedAt` |
| 🔀 **If** | Two outputs, **true** and **false**: the data goes one way or the other (equals, contains, starts with, regex, greater/at least, empty, is true…). | passes input through |
| 📝 **Set Variable** | Adds a named value to the data, usable as `{{name}}` later. | your `name` |
| 🌐 **HTTP Request** | Calls an API or webhook (GET/POST/…, headers, body). | `status`, `ok`, `body`, `data` (parsed JSON) |
| 🔔 **Notify** | Shows a desktop notification. | `notified` |
| 🔎 **Read Element** | Reads one value: text, input value, an attribute (`aria-pressed`), a class (`dark`), exists, or how many match. From the run's tab (after Click/Fill), or from a Page URL in BlockFlow's own background tab. | `value`, `previous`, `changed`, `count`, `url` |
| 👁 **Watch Element** | Watches one element of a page and fires when its text changes. Pick the element by clicking it, like uBlock Origin's picker. | `value`, `previous`, `url`, `selector`, `changedAt` |

Blocks that nothing feeds are **start blocks**. They begin running when you switch the workflow **On**.

Use data from the previous block in any settings field with `{{name}}`, e.g. an Open URL block set to
`{{url}}` opens the page the Watch Element block noticed a change on. `{{$json.name}}` (n8n style),
`{{item.name}}` and `{{rows[0]}}` also work.

Things you can build with a few blocks:

```text
Timer ──▶ Open URL                              open a page every 5 minutes
Watch Element ──▶ Open URL                      open the page when a price changes
Timer ──▶ Read Element ──▶ If ──▶ Notify        notify when dark mode is on, or the post count grew
                                                (If: {{value}} greater than {{previous}})
Timer ──▶ Watch Element ──▶ Open URL            Timer decides how often to check
Watch Element ──▶ Timer (delay) ──▶ Open URL    wait 20s after a change, then open
Timer ──▶ Open URL A
      └─▶ Open URL B                            one block feeds several
```

## Elements: locators

Every "Element" setting takes a **locator**, Playwright style. Press 🎯 **Pick on page** to get a CSS one, or
write a more readable one yourself:

| Locator | Finds |
| --- | --- |
| `#save`, `form .btn` | CSS (the default). `my-widget >>> button` reaches inside a web component |
| `text=Sign in` · `text="Sign in"` · `text=/sign ?in/i` | by visible text: contains (any case) · exact · regex |
| `role=button[name="Save"]` | by role and accessible name (`checkbox[checked]`, `heading[level=2]`) |
| `label=Email` · `placeholder=you@example.com` · `testid=submit` | form fields by label / placeholder; `data-testid` (`data-test`, `data-cy`, `data-qa`) |
| `#list >> text=Pro` · `li >> nth=0` | inside another element · the first (`-1` = last) |

Actions are strict: if a locator matches two elements the step fails and says so, instead of clicking the
wrong one.

## Form filling example

```text
Open Tab (https://shop.test/login)
  → Fill Form (label=Email: me@x.com · label=Password: … · label=Country: Bangladesh · label="Remember me": true,
               then click role=button[name="Sign in"])
  → Wait For (URL matches /account)            ← on error → Notify "login broken"
  → Read Element (#greeting) → If ({{value}} contains "Welcome") → true: Notify "login OK"
```

## Harder pages, and CI

- `frame=#pay >> label=Card number` reaches into iframes, also from other sites.
- Step setting **Use real mouse and keyboard** sends trusted input through the browser debugger
  (Chromium; asks for the permission when ticked) for sites that ignore synthetic events.
- **Wait For → a network request finishes** waits for an API call (URL pattern + status).
- 🎭 exports a workflow as a **Playwright test** (`.spec.ts`) to run in CI with `npx playwright test`.

## Building faster

- **● Record** turns what you do on a page into blocks (Fill Form, Click, Select, Check, Wait For URL,
  and Assert from the on-page toolbar). Passwords are not recorded; the blocks use `{{secret.password}}`.
- **Pick on page** offers readable locators (`role=button[name="Save"]`, `label=Email`) with alternatives.
- Typing `{{` suggests data names. **+ New ▾** starts from a template. Ctrl+Z / Ctrl+Shift+Z, Ctrl+C / Ctrl+V.

## Running and debugging

- **▶ Run** runs the workflow once, now, even when it is Off. A Timer at the start fires immediately; a
  Watch Element reads the page once. **■ Stop** stops it before the next block.
- Blocks light up with how they did in the last run (✓ passed, ✕ failed, ↪ error handled). Click a block to
  see its **input and output** from that run. The **Runs** tab under the canvas lists past runs (Run
  button and scheduled ones); click one to show it on the canvas.
- **Step settings** on every block: On error (stop / continue / send to an **error** output), Retries,
  Timeout (default 60s), Disabled, Note.
- If the browser stops the background worker in the middle of a run, the run is marked **interrupted**.
- **Reports** (header): every run with its steps, errors and **screenshots** (taken when a step fails,
  of the run's tab), exportable as a self-contained **HTML** report, **JUnit XML** for CI, or JSON.
- **Secrets** (header): passwords and tokens used as `{{secret.name}}`, shown as `•••` everywhere and
  never exported with workflows.

## Managing workflows

- **Sidebar** (file-manager style): click a row to open it, the dot turns it on/off, hover for rename (or double-click),
  duplicate, export to a `.blockflow.json` file and delete. `+ New` and `Import` sit on top, plus search.
- **All workflows** tab: a table with on/off switches, block icons, last activity, Edit / Duplicate / Export / Delete,
  select several to export together, Turn all on / off.
- Imported and duplicated workflows always arrive **off** with fresh ids. Turning on a workflow with errors is refused with the reason.

## Getting started

Requires Node 20+.

```bash
npm install          # also runs `wxt prepare`
npm run check        # typecheck + tests + generated docs and learning examples in sync
npm run dev          # opens Chrome with the extension loaded and hot reload
```

Click the BlockFlow toolbar icon to open the editor. Two example workflows are created on first install
(both start Off).

### Try it end to end

A page whose text changes on every load is included for testing:

```bash
npx serve docs/manual-test        # or: python3 -m http.server 8080 --directory docs/manual-test
```

In the editor: add a **Watch Element** block, set Page URL to `http://localhost:3000/clock.html` (use the
port that was printed), press **Pick on page**, click the clock, then add and connect an **Open URL** block
set to `{{url}}`. Turn the workflow **On** and watch the **Run log** at the bottom.

### Other browsers

```bash
npm run build:firefox      # .output/firefox-mv3  (load via about:debugging → This Firefox → Load Temporary Add-on)
npm run build:safari       # .output/safari-mv3   (then convert, see below)
npm run build:all
```

- **Firefox (Manifest V3)** does not grant site access automatically. After installing, open
  `about:addons` → BlockFlow → Permissions and allow access to all sites, or Watch Element and the picker
  will fail with a permissions error.
- **Safari** needs Xcode: `xcrun safari-web-extension-converter .output/safari-mv3`, then build and run the
  generated app, and enable the extension in Safari → Settings → Extensions.

## Project layout

```text
src/
  core/                  The engine. Plain TypeScript, no browser APIs, fully unit-tested.
    types.ts             Workflow model, block definition, Host interface
    engine.ts            WorkflowRunner: start blocks, pass data along connections, timers, runs, sub-workflows
    registry.ts          BlockRegistry (lookup by type)
    blocks/              one file per block (42), index.ts = registry of built-ins and palette groups;
                         pageCommon.ts / dataCommon.ts hold shared fields and helpers
    template.ts          {{value}} templating
    expression.ts        safe expression language for {{ }} and Transform/Filter (no eval)
    config.ts            defaults, templating and validation of block settings
    validate.ts          checks a whole workflow (used by the editor)
    library.ts           duplicate, export and import of workflows
    samples.ts           the example workflows seeded on first install
    ports.ts             block outputs (out / true / false / error) and routeTo()
    runs.ts              run and step records, secret masking
    condition.ts         comparisons shared by If and Assert
    report.ts            JUnit XML and HTML reports from runs
    csv.ts               CSV parse/write
    session.ts, page.ts  the run's named tabs; requests to the page agent
    locatorSyntax.ts     locator parsing shared by the page agent and the Playwright export
    url.ts, urlPattern.ts URL checks; `*` / `**` / regex URL patterns
    schedule.ts          next run time for the Schedule block
    timerKey.ts          timer and state keys (bf::<workflow>::<node>::<name>)
    recording.ts         turns recorded steps into blocks
    playwright.ts        exports a workflow as a Playwright .spec.ts
    workflow.ts          diffWorkflows() decides what the background must start/stop
    id.ts, text.ts       small helpers
  dom/                   Code that runs inside web pages
    selector.ts          CSS selector generation + widen/narrow navigation
    bestLocator.ts       readable locators (role=, label=…) with alternatives, for picker, recorder, Detect fields
    picker.ts            the click-to-pick overlay (shadow DOM)
    recorder.ts          the recorder: turns clicks and typing into steps
    readElement.ts       function injected into a page to read an element (CSS only, kept for reference)
    locator.ts, aria.ts  Playwright-style locators: css, text=, role=, label=, testid=, frame=, >>, nth=
    agent.ts             the page agent: auto-wait, click, fill, select, check, press, read, wait, extract, detect form
  browser/               Real implementations of the Host (alarms, tabs, storage, scripting)
    host.ts              assembles the Host
    hybridScheduler.ts, scheduler.ts  timers: alarms + in-memory timers + keep-alive
    pageDriver.ts        calls the page agent (frames, real input), navigation.ts waits for load / URL / network
    pageReader.ts, tabs.ts  Watch/Read Element's own background tab; tab helpers
    cdp.ts               real mouse and keyboard through the debugger API (Chromium, optional permission)
    popups.ts            popups and new tabs opened by a run's tab
    htmlParse.ts         runs the agent on fetched HTML (offscreen document in Chrome)
    blobStore.ts         IndexedDB: screenshots and datasets
    stores.ts            storage.local wrappers (workflows, logs, runs)
    picking.ts, recording.ts  start/finish the picker and the recorder
    prompts.ts           Manual Step questions (notification + editor banner)
    ownTabs.ts           tabs BlockFlow opened (never trigger Page Visited)
  shared/                Storage keys and message types (keys.ts, messages.ts)
  entrypoints/
    background.ts        runs enabled workflows; restart-safe
    picker.content.ts    injects the picker on demand
    recorder.content.ts  the recorder, injected on demand into the recording tab
    agent.content.ts     the page agent, injected on demand by src/browser/pageDriver.ts
    offscreen/           Chrome only: parses fetched HTML (the service worker has no DOM)
    editor/              React + React Flow editor page
tests/                   Vitest. core/, editor/ and browser/ run in Node, dom/ runs in jsdom.
                         e2e/ drives the real build in Chromium against fixtures/site (npm run e2e)
docs/ARCHITECTURE.md     how it fits together and why
docs/wiki/               internals wiki, file by file (start at docs/wiki/Home.md)
docs/manual-test/        a page that changes on every load, for end-to-end testing
docs/learning/           hand-coding course: build your own extension step by step (start at its README)
docs/guide/              usage guide for people and AI tools, generated block reference, example workflows
docs/PLAN-automation.md  the plan for phases A to F (form filling, testing, scraping, harder pages)
scripts/guide.ts         generates docs/guide/blocks.md, blocks.json, workflow.schema.json (npm run guide:sync)
```

Going deeper: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and the reasons behind it,
the [internals wiki](docs/wiki/Home.md) for a file-by-file reference.

## Adding a block

1. Create `src/core/blocks/myBlock.ts` exporting a `BlockDefinition` (settings `fields`, `outputs`,
   and `run` and/or `start`/`onTimer`). Use `openUrl.ts` as the smallest example.
2. Register it in `src/core/blocks/index.ts`.
3. Add tests that run it through `harness()` from `tests/helpers/fakeHost.ts`.

The editor palette, settings form, validation and `{{…}}` support come from the definition. No UI code
needed.

## What has been verified

| Area | Status |
| --- | --- |
| `npm install`, `tsc` against real WXT/React Flow types, `npm run check` (131 tests incl. jsdom) | Run, passing (WXT 0.20.27, Vite 8, Vitest 3). |
| `wxt build` for Chrome and Firefox | Run, passing. `web-ext lint` on the Firefox build: 0 errors (innerHTML warnings come from React DOM and the picker's static template). |
| Engine, blocks, templating, validation, workflow diffing | Unit tested. Mutation-checked: a deliberate bug in change detection is caught. |
| React editor (state sync, autosave, validation, picker round trip, logs) | Driven in Chromium with React 19 in dev mode: 39 checks, no warnings, no render loops (React Flow faked). The real build renders the canvas and samples without errors, but dragging and connecting by hand is untested. |
| Real WXT Chrome build in Playwright Chromium 131 (headless, local test server): editor loads, samples seeded, picker injected from `/content-scripts/picker.js` and round trip to editor, 3s repeating Timer → Open URL, short timer keeps firing after the service worker is stopped (resumes via the heartbeat alarm, so expect a gap of up to 30s), disable stops it, Watch Element in a background tab fires on change with `{{url}}`, a stable element never fires, 30s alarm timer fires once (12 checks) | Run, passing. |
| 2026-10-23, Brave Origin 155 (temp profile, real WXT Chrome build, local server): Timer → HTTP Request (POST, header, body) → If → Set Variable → Notify → Open URL ran end to end with `{{data.price}}` templating; a second flow with a false If stopped and sent no notification | Run, passing. |
| 2026-10-23, Brave Origin 155: workflow manager UI driven through the real editor (new, rename, duplicate, enable/disable, turn all off, export, import, bad import, refuse empty, delete) | Run, passing (13 checks). |
| 2026-10-23, Brave Origin 155 against the live akibh.dev and blog.akibh.dev: Read Element (class `dark` on `<html>`, `aria-pressed` on the theme button, post-link count) → If → Notify. Flipping the theme between two reads gave `changed=true` and a notification; a local page whose post count grows 3→5→7 notified only on increases; unchanged reads stayed quiet | Run, passing. |
| 2026-10-23, Brave Origin 155, Phase A (runs, ports, step settings) through the real editor: If true/false branches, dragging a new connection from the "false" output, inspector input/output, error output + retries (2 attempts), switching back to "stop" removes the error output and its edge, Stop button cancels before the next block, killing the service worker mid-run marks the run interrupted (18 checks) | Run, passing. |
| 2026-10-23, `npm run e2e` (Brave Origin 155, 20 checks, 3 runs in a row): classic login with Fill Form + submit + Wait For URL + Read + If; wrong password routed to the error output with a readable timeout; SPA with a cookie overlay ("covered by" reason), React-style controlled inputs, typed email, select, custom checkbox under its label, disabled-until-valid button, pushState route, text appearing, shadow DOM button; strict-mode and missing-element errors; Detect fields in the editor on a real form. Unit tests: 212 incl. a React 19 form filled in jsdom | Run, passing. |
| 2026-10-23, `npm run e2e` Phase C (30 checks in all): Run Workflow reusing a login in the same tab, Assert text/title passing, a soft Assert failing the run while the flow continues, its screenshot in the Reports page and in the HTML export, JUnit export, the secret password absent from all run records, Manual Step continued from the editor banner | Run, passing. |
| 2026-10-23, `npm run e2e` Phase D (38 checks in all, Playwright Chromium 131: Brave stopped launching under automation that afternoon, see below): Paginate 3 pages + Extract List + Save to Dataset (9 rows in IndexedDB, absolute links) + Download CSV, HTTP Request + Extract Table/List from HTML through Chrome's offscreen document, Scroll an infinite feed to 40 posts, a CSV-driven For Each login (one good, one bad), Data page preview | Run, passing. |
| 2026-10-23, `npm run e2e` Phase E (47 checks in all, Chromium 131): recording a real login (typing, select, checkbox, submit, navigation, Assert text from the toolbar) became Open Tab → Fill Form → Wait For → Assert with readable locators and `{{secret.password}}`, and replayed green; pick gives `role=button[name="Forgot password?"]` plus alternatives; undo/redo/copy/paste; a template; `{{` suggestions; Page Visited started a run on a visited tab. Context Menu and Schedule: unit tests only | Run, passing. |
| 2026-10-23, `npm run e2e` Phase F (57 checks in all, twice in a row, Chromium 131): Upload File on a hidden input, Wait for Popup (window.open and target=_blank from a background tab), Dialogs (confirm dismissed, prompt answered), same-origin and cross-origin iframes, Wait For a POST /api/save 201, synthetic click untrusted vs real input trusted (click and typing), a background-tab screenshot through the debugger, Run Script's message on a browser without userScripts.execute, and a workflow exported from the editor as a .spec.ts passing under `npx playwright test` | Run, passing. |
| Firefox host permission grant, Safari conversion, Chrome Web Store upload | **Not run.** |

## Known limitations

- **Short timers keep the worker awake.** Browsers limit `browser.alarms` to about 30 seconds, so timers
  below that run from in-memory timers plus a keep-alive ping (the alarm remains as a 30s heartbeat that
  revives the worker after a crash or browser restart). Verified in Chromium 141 with 5s timers running for
  50s. Costs a little battery while such a workflow is enabled. Firefox/Safari event pages and Safari in
  particular may still suspend the worker: untested. Timers of 30s or more are alarm-only and cheap.
- **Watch Element uses its own background tab** per watched URL (never your own tabs) and reloads it on each
  check by default. Pages that need a login work if you are signed in in the same browser profile.
- Broad site access (`<all_urls>`) for now; only `debugger` and `userScripts` are optional (asked when a block needs
  them). Per-workflow site permissions are not built: browsers only ask on a click, which scheduled runs cannot give.
- Two editor tabs open at once overwrite each other's changes.
- `npm run e2e` picks Brave first. If a browser hangs at launch under automation (Brave did after an update on
  2026-10-23), run `BF_BROWSER=/path/to/chromium npm run e2e`; Playwright's Chromium in
  `~/.cache/ms-playwright` is used automatically when nothing else is found.
- Page actions use synthetic events (`isTrusted: false`) unless the step's **Use real mouse and keyboard**
  is on (Chromium only, not inside cross-origin iframes). Closed shadow roots, drag and drop and file drop
  zones are not supported. Run Script needs Chrome 135+ with user scripts allowed. Full list: the usage
  guide's [Limits](docs/guide/README.md#17-limits-what-a-browser-extension-cannot-do-or-blockflow-does-not-do-yet).
- No "Resume" for an interrupted run yet, and If has one condition (several joined with and/or come later).

## Roadmap ideas

The product plan (Playwright-compatible automation in your browser, for people and LLMs; milestones M0–M6) is
[docs/PLAN.md](docs/PLAN.md), built task by task per [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md). Phases A–F, already built, are in [docs/PLAN-automation.md](docs/PLAN-automation.md).

Folders for workflows, per-workflow permissions, If with several conditions, resuming an interrupted run,
Web Store packaging. (Done since the first version of this list: If with true/false outputs, reading
elements, the recorder.)
