# BlockFlow

Build small browser automations by connecting blocks, like n8n or AutoHotkey, but inside your browser.
Works in Chrome, Firefox and Safari from one codebase ([WXT](https://wxt.dev) + React + TypeScript).

**Status: prototype 1.** Seventeen blocks, a canvas editor, and a background engine. See
[What has been verified](#what-has-been-verified) before you rely on it.

## The idea

Every block has an **input** (left dot) and an **output** (right dot). Connect any block's output to any
other block's input. The data a block produces becomes available to the next block.

| Block | What it does | Output data |
| --- | --- | --- |
| 🔗 **Open Tab** | Opens a page in a new tab, the workflow's own reused tab, a new window or the current tab, waits for load / network idle, and **names the tab** (`main`) for the blocks after it. | `url`, `tabId` |
| 👆 **Click** | Click, double-click, right-click or hover an element. Waits until it is visible, enabled, still and not covered. | passes input through |
| ⌨️ **Fill** | Types into a field (all at once, or key by key). Works with React/Vue/Angular forms. | passes input through |
| 📋 **Fill Form** | Many fields in one block (text, selects, checkboxes), optional submit click. **🎯 Detect fields** lists a form's fields for you. | passes input through |
| 🔽 **Select Option** · ☑️ **Check** · ⏎ **Press Key** | Dropdowns by text or value; tick/untick; Enter, Tab, Control+A… | |
| ⏳ **Wait For** | Element visible/hidden/gone/enabled, text appears/disappears, URL matches (also SPA route changes), page load, network quiet. | `url` |
| 🧭 **Navigate** · ✖️ **Close Tab** | Go to URL, back, forward, reload; close a tab of the run. | `url` |
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

Things you can build with just these three:

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

## Running and debugging

- **▶ Run** runs the workflow once, now, even when it is Off. A Timer at the start fires immediately; a
  Watch Element reads the page once. **■ Stop** stops it before the next block.
- Blocks light up with how they did in the last run (✓ passed, ✕ failed, ↪ error handled). Click a block to
  see its **input and output** from that run. The **Runs** tab under the canvas lists past runs (Run
  button and scheduled ones); click one to show it on the canvas.
- **Step settings** on every block: On error (stop / continue / send to an **error** output), Retries,
  Timeout (default 60s), Disabled, Note.
- If the browser stops the background worker in the middle of a run, the run is marked **interrupted**.

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
npm run check        # typecheck + tests
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
    engine.ts            WorkflowRunner: start blocks, pass data along connections, timers
    blocks/              timer, openUrl, watchElement, ifBlock, setVariable, httpRequest, notify, index.ts (registry of built-ins)
    template.ts          {{value}} templating
    config.ts            defaults, templating and validation of block settings
    validate.ts          checks a whole workflow (used by the editor)
    library.ts           duplicate, export and import of workflows
    ports.ts             block outputs (out / true / false / error) and routeTo()
    runs.ts              run and step records
    condition.ts         comparisons shared by If (and later Assert, Wait For…)
    workflow.ts          diffWorkflows() decides what the background must start/stop
  dom/                   Code that runs inside web pages
    selector.ts          CSS selector generation + widen/narrow navigation
    picker.ts            the click-to-pick overlay (shadow DOM)
    readElement.ts       function injected into a page to read an element (CSS only, kept for reference)
    locator.ts, aria.ts  Playwright-style locators: css, text=, role=, label=, testid=, >>, nth=
    agent.ts             the page agent: auto-wait, click, fill, select, check, press, read, wait, detect form
  browser/               Real implementations of the Host (alarms, tabs, storage, scripting)
  shared/                Storage keys and message types
  entrypoints/
    background.ts        runs enabled workflows; restart-safe
    picker.content.ts    injects the picker on demand
    agent.content.ts     the page agent, injected on demand by src/browser/pageDriver.ts
    editor/              React + React Flow editor page
tests/                   Vitest. core/ and editor/ run in Node, dom/ runs in jsdom.
docs/ARCHITECTURE.md     how it fits together and why
docs/manual-test/        a page that changes on every load, for end-to-end testing
docs/learning/           hand-coding course: build your own extension step by step (start at its README)
```

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
| Firefox host permission grant, Safari conversion, Chrome Web Store upload | **Not run.** |

## Known limitations

- **Short timers keep the worker awake.** Browsers limit `browser.alarms` to about 30 seconds, so timers
  below that run from in-memory timers plus a keep-alive ping (the alarm remains as a 30s heartbeat that
  revives the worker after a crash or browser restart). Verified in Chromium 141 with 5s timers running for
  50s. Costs a little battery while such a workflow is enabled. Firefox/Safari event pages and Safari in
  particular may still suspend the worker: untested. Timers of 30s or more are alarm-only and cheap.
- **Watch Element uses its own background tab** per watched URL (never your own tabs) and reloads it on each
  check by default. Pages that need a login work if you are signed in in the same browser profile.
- Broad site access (`<all_urls>`) for now. Later: ask for access per workflow with optional permissions.
- No templates or undo yet. Two editor tabs open at once overwrite each other's changes.
- Page actions use synthetic events (`isTrusted: false`); a few sites reject them. Iframes, closed shadow
  roots, file uploads and native dialogs are not supported yet (plan: phase F).
- No "Resume" for an interrupted run yet, and If has one condition (several joined with and/or come later).

## Roadmap ideas

The full plan for form filling, testing and scraping is in [docs/PLAN-automation.md](docs/PLAN-automation.md).

IF with true/false outputs, extract-text block, folders for workflows,
a recorder that turns your clicks into blocks, per-workflow permissions, Web Store packaging.
