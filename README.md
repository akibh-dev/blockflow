# BlockFlow

Build small browser automations by connecting blocks, like n8n or AutoHotkey, but inside your browser.
Works in Chrome, Firefox and Safari from one codebase ([WXT](https://wxt.dev) + React + TypeScript).

**Status: prototype 1.** Three blocks, a canvas editor, and a background engine. See
[What has been verified](#what-has-been-verified) before you rely on it.

## The idea

Every block has an **input** (left dot) and an **output** (right dot). Connect any block's output to any
other block's input. The data a block produces becomes available to the next block.

| Block | What it does | Output data |
| --- | --- | --- |
| ⏱ **Timer** | Nothing connected to it: starts the flow every N seconds (or once). After another block: **delays** the flow by N seconds. | `tick`, `firedAt` |
| 🔗 **Open URL** | Opens a page in a tab. | `url`, `tabId` |
| 👁 **Watch Element** | Watches one element of a page and fires when its text changes. Pick the element by clicking it, like uBlock Origin's picker. | `value`, `previous`, `url`, `selector`, `changedAt` |

Blocks that nothing feeds are **start blocks**. They begin running when you switch the workflow **On**.

Use data from the previous block in any settings field with `{{name}}`, e.g. an Open URL block set to
`{{url}}` opens the page the Watch Element block noticed a change on. `{{$json.name}}` (n8n style),
`{{item.name}}` and `{{rows[0]}}` also work.

Things you can build with just these three:

```text
Timer ──▶ Open URL                              open a page every 5 minutes
Watch Element ──▶ Open URL                      open the page when a price changes
Timer ──▶ Watch Element ──▶ Open URL            Timer decides how often to check
Watch Element ──▶ Timer (delay) ──▶ Open URL    wait 20s after a change, then open
Timer ──▶ Open URL A
      └─▶ Open URL B                            one block feeds several
```

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
    blocks/              timer.ts, openUrl.ts, watchElement.ts, index.ts (registry of built-ins)
    template.ts          {{value}} templating
    config.ts            defaults, templating and validation of block settings
    validate.ts          checks a whole workflow (used by the editor)
    workflow.ts          diffWorkflows() decides what the background must start/stop
  dom/                   Code that runs inside web pages
    selector.ts          CSS selector generation + widen/narrow navigation
    picker.ts            the click-to-pick overlay (shadow DOM)
    readElement.ts       function injected into a page to read an element
  browser/               Real implementations of the Host (alarms, tabs, storage, scripting)
  shared/                Storage keys and message types
  entrypoints/
    background.ts        runs enabled workflows; restart-safe
    picker.content.ts    injects the picker on demand
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

Prototype 1 was written in an environment where the npm registry was blocked, so `npm install` and the
WXT build were **not** run there. What was checked, and how:

| Area | Status |
| --- | --- |
| Engine, blocks, templating, validation, workflow diffing (81 tests) | Run, passing. Mutation-checked: a deliberate bug in change detection is caught. |
| Strict TypeScript on core, dom, shared, browser, background, tests | Passing, with `wxt/browser` stubbed (so calls into browser APIs are not type-checked against real types). |
| Selector generator and element picker (29 tests) | Run in real Chromium 141, passing. Not yet run under jsdom. |
| React editor (state sync, autosave, validation, picker round trip, logs) | Driven in Chromium with React 19 in dev mode: 39 checks, no warnings, no render loops. React Flow itself was **faked**, so dragging, connecting and visuals are untested. |
| `npm install`, `wxt build`, `tsc` against real WXT/React Flow types | **Not run.** First thing to do. |
| Real extension in Chromium 141 (unpacked MV3, bundled background + picker, local test server): 5s Timer → Open URL and Watch Element every 5s for 50s, disable stops everything, element picker round trip (15 checks) | Run, passing. Used the real background code with a thin `wxt/browser` shim, not a WXT build. |
| Same on Firefox / Safari, Chrome Web Store build, a worker restart mid-run in a real browser | **Not run.** |

Expect small fixes on first contact with real dependencies, most likely type errors in `src/browser` and
the editor, or dependency version bumps.

## Known limitations

- **Short timers keep the worker awake.** Browsers limit `browser.alarms` to about 30 seconds, so timers
  below that run from in-memory timers plus a keep-alive ping (the alarm remains as a 30s heartbeat that
  revives the worker after a crash or browser restart). Verified in Chromium 141 with 5s timers running for
  50s. Costs a little battery while such a workflow is enabled. Firefox/Safari event pages and Safari in
  particular may still suspend the worker: untested. Timers of 30s or more are alarm-only and cheap.
- **Watch Element uses its own background tab** per watched URL (never your own tabs) and reloads it on each
  check by default. Pages that need a login work if you are signed in in the same browser profile.
- Broad site access (`<all_urls>`) for now. Later: ask for access per workflow with optional permissions.
- No import/export, templates or undo yet.
- Only three blocks, and a block's output goes to every connection (no conditions or branching yet).

## Roadmap ideas

Notification block, IF/condition, HTTP request, extract-text/set-variable, import/export workflows,
a recorder that turns your clicks into blocks, per-workflow permissions, Web Store packaging.
