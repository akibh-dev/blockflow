# BlockFlow product plan: Playwright-compatible automation in your browser

> **Status:** agreed, 2026-11-05 (decisions in §8). M0 done (v0.2.0), M1 done (v0.3.0, 2026-11-06), M2 done (v0.4.0, 2026-11-06). Task-level steps: [IMPLEMENTATION.md](IMPLEMENTATION.md). This plan replaces the
> phase list in [PLAN-automation.md](PLAN-automation.md) (phases A–F, all built) as the guide for what comes next.

M3 is done on `m3-network` (2026-11-10): Route, HAR Record, Emulate, Clear Site Data and console capture,
on run-scoped debugger sessions. M4 is done on `m4-outside-access` (2026-11-10): the native bridge, the MCP
server, the CLI runner and Suites. Together they are v0.5.0. M5 is done on `m5-debugging` (2026-11-10, v0.6.0):
trace timeline, breakpoints, visual comparison, ARIA snapshot assert, Run from here; see IMPLEMENTATION.md.

## 1. Goal

BlockFlow should do what people use Playwright for: test, automate, scrape and monitor web pages. It runs
**inside the browser as an extension**, and two kinds of users drive it:

- **Humans**, through the block editor: picking elements, recording, templates, and reports they can read.
- **LLMs and other programs**, through **well-defined workflow scripts**: a documented JSON format with a
  schema, strict validation and machine-readable results. Eventually they also get a way to run those
  scripts and read the results without a human in the loop.

One engine serves both. A workflow made in the UI and one written by a model are the same file.

### What being an extension changes

| We give up (hard limits) | We gain (things Playwright can't do as easily) |
| --- | --- |
| No launching browsers, no headless mode, no WebKit/Firefox engines from one runner | Runs in the user's **real, logged-in browser**: no auth scripting, no `storageState` |
| No per-test browser contexts (we share the user's profile; isolation is limited) | **Triggers**: page visited, right-click menu, schedule, element change, all with nothing installed |
| The MV3 worker sleeps; long runs need alarms and stored state | **Human in the loop**: Manual Step for CAPTCHA/2FA, notifications |
| Trusted input, network control and emulation need the optional `debugger` permission (Chromium only) | **Zero setup**: no Node, no driver; share a workflow as one file |
| Protected pages: `chrome://`, stores, PDF viewer, closed shadow roots | Visual building and picking for people who don't write code |
| Background tabs are throttled | An exit door: export to a real Playwright spec for CI |

**Principle:** match Playwright's *semantics* (locators, auto-wait, strictness, `expect`-style retries) so
knowledge transfers both ways. Where the browser allows it only through CDP, offer it as Chromium-only and
say so. Never fake a capability.

## 2. Who it is for

| User | Works through | Needs most |
| --- | --- | --- |
| Manual tester / QA | Editor, recorder, picker, reports | Reliable recording, readable reports, screenshots, data-driven runs |
| Power user (monitoring, scraping, forms) | Editor, templates, triggers | Triggers, datasets, notifications, scheduling that survives restarts |
| Developer | JSON files, Playwright export, CI | Text-first workflows, strict validation, a CLI runner, diff-friendly files |
| LLM agent | Scripts, schema, the [usage guide](guide/README.md) | Unambiguous format, precise errors, a page snapshot to write locators from, a way to run and read results |

## 3. Current features: what we keep

Everything built in phases A–F is in line with the goal. The question is mostly *what to finish*, not what to cut.

| Area | Today | Decision |
| --- | --- | --- |
| Engine: graph, ports, payloads, step settings (retries, timeout, onError, screenshot, disabled) | Built, well tested | **Keep.** Fix the timeout bug (§6) |
| Survives worker sleep: hybrid scheduler, alarms, stored state | Built, verified in Chromium | **Keep** |
| Locators: css, text, role, label, placeholder, testid, alt, title, xpath, `>>` chaining, `nth`, `frame=`, `>>>` shadow | Built, Playwright-like | **Keep**, then add filters (§4) |
| Auto-wait and strictness (visible, enabled, stable, not covered) | Built | **Keep.** This is the core of Playwright parity |
| Page actions: click/double/right/hover, fill/type, fill form, select, check, press key, upload, scroll, dialogs | Built | **Keep**, then add missing actions (§4) |
| Real input via CDP (`realInput`) | Built, Chromium, optional permission | **Keep.** Fix iframe coordinates (§6) |
| Tabs: Open Tab, Navigate, Wait for Popup, Close Tab, named sessions | Built | **Keep** |
| Assert (13 subjects, soft asserts, retries) | Built | **Keep**, then add subjects (§4) |
| Testing: Run Workflow (reuse), Stop, Manual Step, reports (HTML, JUnit, JSON), screenshots on error | Built | **Keep** |
| Data: expressions, templates, Set Variable, Transform, Filter, For Each, Repeat, Data Table, datasets, Download | Built | **Keep** |
| Scraping: Extract List/Table (tab or HTML), Paginate, Page Info, HTTP Request | Built | **Keep** |
| Triggers: Start, Timer, Schedule, Page Visited, Context Menu, Watch Element | Built | **Keep.** These set us apart from Playwright |
| Recorder, picker, Detect fields, templates, undo/redo, `{{` suggestions | Built | **Keep.** Recorder gaps in §6 |
| Run Script (userScripts, Chrome 135+) | Built | **Keep** as the escape hatch |
| Playwright export | Built, partial | **Keep.** It is our CI bridge until the CLI runner exists. Fix the template gaps (§6) |
| Secrets (masked in logs) | Built, encrypted with a passphrase (M6) | **Done** |
| Watch Element vs Read Element + Timer | Overlapping | **Keep both** (§8): Watch is the simple path |
| `readSelectorInPage` (old reader), `newTab` legacy setting in samples | Dead or legacy | **Remove** dead code; migrate the samples |

Nothing is proposed for removal at the feature level.

## 4. Playwright parity: the gaps

✅ have · 🟡 partial · ❌ missing. "CDP" = Chromium-only via the optional `debugger` permission.

| Capability | Playwright | BlockFlow today | Plan |
| --- | --- | --- | --- |
| Navigate, back/forward/reload, wait for URL/load/networkidle | `goto`, `waitForURL`… | ✅ Open Tab, Navigate, Wait For | — |
| Locators by role/text/label/testid, chaining, nth, frames | `getBy*`, `locator()` | ✅ | — |
| Locator filters: `has`, `hasText`, `hasNot`, `visible`, `or`/`and` | ✅ | ✅ `>> has-text=`, `has-not-text=`, `has=`, `has-not=`, `visible`, `\|\|` (no `and`) | **M2** ✅ |
| Role options `pressed`, `expanded`, `selected`, `disabled` | ✅ | ✅ also `pressed`, `expanded`, `selected`, `disabled` | **M2** ✅ |
| Click options: modifiers (Ctrl/Shift), position, middle button, click count | ✅ | ✅ Click `button`, `modifiers`, `position`, `clickCount` | **M2** ✅ |
| `focus`, `blur`, `clear`, `dispatchEvent`, `scrollIntoView` | ✅ | ✅ Element Action block | **M2** ✅ |
| Drag and drop | `dragTo` | ✅ Drag block (synthetic HTML5 + pointer, CDP with `realInput`) | **M2** ✅ |
| Keyboard shortcuts / chords, `insertText` | ✅ | ✅ chords in both input modes, `ControlOrMeta`, Press Key `mode: "text"` | **M2** ✅ |
| File upload | `setInputFiles` | ✅ text, URL or base64 data | **M2** ✅ (`source: data`) |
| File chooser via drop zone | 🟡 | ✅ Upload File `target: dropzone` | **M2** ✅ |
| Downloads: wait for, save, read name | `waitForEvent('download')` | ✅ Wait for Download (`downloads` API): `filename`, `url`, `size`, `mime`; `read` CSV/JSON/text by fetching the address again | **M2** ✅ |
| Dialogs | ✅ | ✅ | — |
| Popups / new pages | ✅ | ✅ | — |
| `expect`: text, value, visible/hidden, enabled, checked, count, attribute, URL, title | ✅ | ✅ | — |
| `expect`: `toHaveClass`, `toHaveCSS`, `toBeFocused`, `toBeEditable`, `toBeInViewport`, `toHaveAccessibleName` | ✅ | ✅ Assert `class`, `css`, `focused`, `editable`, `in-viewport`, `accessible-name`, `accessible-description` | **M2** ✅ |
| Visual comparison | `toHaveScreenshot` | ✅ Screenshot `compare` (baseline per block, masks, Accept new baseline) | **M5** ✅ |
| ARIA snapshot | `toMatchAriaSnapshot` | ✅ page snapshot (M1) and Assert `aria-snapshot` | **M5** ✅ |
| Screenshots: page, full page, element, on demand | ✅ | ✅ Screenshot block (Chromium: full page / background tabs via CDP; Firefox: `captureTab`) | **M2** ✅ |
| Network: wait for response / request | `waitForResponse`, `waitForRequest` | ✅ Wait For `response` (method, body via CDP on Chromium) and `request` | **M2** ✅ |
| Network: mock, block, modify (`route`) | ✅ | ✅ Route block: fulfill/abort/continue/modify/redirect via CDP `Fetch` (Chromium); abort/redirect via `declarativeNetRequest` on every browser | **M3** ✅ |
| HAR record/replay | ✅ | 🟡 HAR Record (metadata only, CDP) | **M3** ✅ record; replay later |
| Emulation: viewport, device, geolocation, locale, timezone, offline, color scheme | ✅ | ✅ Emulate block (CDP `Emulation`), also reduced motion; reset at run end | **M3** ✅ |
| Cookies and storage: read / set / clear | `context.cookies()`, `storageState` | ✅ Cookies & Storage (cookies API, HttpOnly too; page storage) | `storageState` save/load later |
| Isolation between tests | new context per test | 🟡 shared profile + Clear Site Data block (`browsingData`, Chromium) | **M3** ✅; incognito runs only if needed (§8) |
| API testing | `request` fixture | ✅ HTTP Request | Make `failOnError` actually fail (§6) |
| `evaluate` | ✅ | ✅ Run Script | — |
| Test runner: suites, tags, retries, parallel workers | ✅ | 🟡 per-step retries, Run Workflow, Suites (in order, one combined JUnit/HTML/JSON report) | **M4** ✅ suites; tags and parallel workers later |
| Tracing / trace viewer | ✅ | ✅ traced runs: before/after pictures, element box, network summary, filmstrip in Reports | **M5** ✅ |
| Debugging: pause, step through, inspector | `page.pause()`, `--debug` | ✅ breakpoints, Step / Continue / Stop, pause on error, Run from here | **M5** ✅ |
| Codegen | ✅ | ✅ recorder | Fix the recorder gaps (§6) |
| Headless / CI | ✅ | ✅ `blockflow run` CLI (headless Chromium, JUnit, exit codes), Playwright export | **M4** ✅ |
| Branching beyond true/false; loop until | (code) | ✅ If, Switch (one output per case + default), For Each, Repeat (`times`, `until`, `while`) | **M2** ✅ |

**Won't do:** running WebKit or Firefox engines from Chrome, headless inside the extension, parallel
browsers inside one profile, and bypassing CAPTCHAs.

## 5. The LLM track

Today a model can *write* a workflow from the [usage guide](guide/README.md), the schema and the block
reference, but it cannot run it, see the page or read the result without a person. This track closes that loop.

| # | Item | Why | Milestone |
| --- | --- | --- | --- |
| L1 | **Strict validation for scripts.** Unknown config keys and wrong value types are errors, not silently ignored. Every error has a JSON path (`/workflows/0/nodes/3/config/locator`), a stable code and a suggestion ("did you mean `locator`?") | Models make small mistakes; silent defaults hide them | M1 |
| L2 | **Linear `steps` format.** A workflow can be written as an ordered list (`steps: [{open: …}, {click: …}]`) with optional `id`s and `branch` targets, and compiled to nodes and edges. No positions; the editor lays it out automatically | The node/edge/position format is verbose and easy to get wrong for straight-line tests, which are most of them | M1 |
| L3 | **Auto-layout** for imported graphs without positions | Needed by L2, and nice for humans | M1 |
| L4 | **Page snapshot op**: an ARIA/role tree of the current page with ready-made locators for each element | Lets a model write correct locators without guessing (Playwright MCP does the same) | M1 |
| L5 | **Machine-readable results**: the JSON report gets stable error codes, the failing locator, the page URL and the matches found | So a model can fix its own script | M1 |
| L6 | **Local bridge**: a native-messaging host (small Node companion) that exposes BlockFlow to the outside: validate, import, run, report, snapshot | Required for any program to drive the extension | M4 |
| L7 | **MCP server** on top of L6: tools `validate_workflow`, `run_workflow`, `get_report`, `snapshot_page`, `list_workflows` | Lets Claude and other agents author, run and repair workflows in a loop, in the user's real browser | M4 |
| L8 | **CLI runner** `blockflow run file.json --report junit` that starts Chromium with the extension (reusing the e2e harness) | CI and scripts without Playwright export | M4 |
| L9 | **Versioned format** with migrations (`schemaVersion` exists; add migration tests) | Scripts written today must keep importing | M1 |
| L10 | **LLM docs**: keep `llms.txt` + the guide as the single source; add a "repair" section (error code → fix) | Models read docs, not code | M1, then ongoing |

### What trips models up today

Found by writing the scripting docs against the code. L1 and L5 have to cover all of these:

1. Edges pointing at a missing node id are dropped silently on import, so the target becomes an extra start block that runs with empty data. Duplicate node ids aren't caught, because ids are replaced before validation.
2. Unknown config keys are ignored, and the schema has no `additionalProperties: false`, so a typo like `"locater"` passes both.
3. Key names are inconsistent: Read Element and Watch Element use `selector`, Paginate uses `next`, every other block uses `locator`. Decided (§8): rename them to `locator` in M1, keeping the old keys as migrated aliases.
4. Requirements that depend on another setting are checked only at run time: Assert needs a locator or a `name` depending on its subject, Wait For needs `text`/`url`/`locator` by mode, Upload needs `content` or `url`. So are a page block without an Open Tab before it, invalid locator syntax, and a Run Workflow pointing at a missing workflow.
5. A missing secret renders as an empty string with no warning.
6. Step settings aren't validated (a bad `onError` value is accepted), and a `sourcePort` naming an output that doesn't exist is only a warning.
7. Workflow-level problems show only as a count in the header until you switch the workflow on.
8. Run reports use the ids assigned on import, not the ids in the file, so a model can't map a failure back to its own script.
9. There is no wait-for-a-fixed-time block that stays in the run: a Timer used as a delay splits the run.

**Decided (§8):** for L6, native messaging needs a one-time install of a small companion app. The other option
is a localhost WebSocket, which an extension can only reach as a client. Proposal: native messaging, because
it is officially supported in Chrome and Firefox and needs no open port.

## 6. Bugs and gaps found (fix before new features)

These come from the documentation pass. **P0** loses data or gives wrong results, **P1** is incorrect behaviour
people will hit, **P2** is a rough edge.

> **Status: all fixed in M0 (v0.2.0, 2026-11-05).** Testing in M0 found and fixed three more: Navigate
> back/forward failed in Chromium after a goto (`tabs.goBack` skips entries without a user gesture), any
> role/name lookup crashed on a page with an unlabelled `<section>` (`aria.ts` recursion), and the editor
> mistook its own saves for another tab's (storage does not keep key order). Details per task in
> [IMPLEMENTATION.md](IMPLEMENTATION.md#m0-stabilise-and-test-v02).

| P | Where | Problem |
| --- | --- | --- |
| P0 | `src/core/library.ts` | Duplicate, Import and New from template drop `step` settings and edge `sourcePort`: If/false becomes true, loop `done` becomes `each`. Import is the LLM entry point |
| P0 | `src/core/engine.ts` | A timed-out step keeps running, overlaps its retry and can still emit into the run |
| P1 | `src/core/blocks/manualStart.ts` | Start runs with `{}` whenever its workflow is switched on or the browser starts; the guide says "only by hand" |
| P1 | `src/core/blocks/httpRequest.ts` | "Stop the flow on HTTP errors" ends the path silently with status passed |
| P1 | `src/core/blocks/timer.ts` + background | A mid-flow delay splits the run: the ▶ Run record ends at the Timer, a called workflow returns early, and on a disabled workflow the delay never resumes |
| P1 | `src/browser/cdp.ts` / agent `locate` | Real-input clicks inside iframes use frame coordinates, so they miss |
| P1 | `src/browser` picking | Cancelling a pick leaves the editor waiting |
| P1 | `bf:watch-tabs` in `storage.local` | Tab ids are reused after restart, so Watch Element may reload one of the user's own tabs |
| P1 | Editor | Two editor tabs overwrite each other (last write wins); no storage listener |
| P1 | Picker and recorder | Don't work inside iframes or web components (`event.target` instead of `composedPath()[0]`); the recorder ignores popup tabs |
| P1 | `diffWorkflows` + background | Editing an **On** workflow restarts it on every autosave: a workflow without a trigger runs again (opening tabs) while you type, and timers restart. Such workflows also re-run on every browser start |
| P1 | `src/core/samples.ts` | The "every 5 minutes" sample still uses the old `newTab` key, so once switched on it opens a new tab every 5 minutes |
| P1 | Recorder | Recording into a non-empty workflow adds a second, unconnected chain with its own Open Tab; every password maps to one secret name `password` |
| P2 | `scripts/guide.ts` | Block reference table-of-contents anchors miss the leading `-` GitHub gives emoji headings |
| P1 | `src/core/playwright.ts` | Wait For `response` exports as `waitForLoadState('load')`, so the exported test doesn't wait for the call. Assert on url/title/value (and operators other than equals/contains) exports without retry. A mid-flow Timer becomes a comment instead of a delay |
| P2 | `src/core/playwright.ts` | Export ignores `{{$json.x}}`, dashed keys, `step.retries`/`timeoutSeconds` and Open Tab's `where`. Transform, Filter, Dialogs, Upload File, Wait for Popup and Run Script become comments, so later steps lose data. The CSV helper splits on commas only |
| P2 | `src/core/expression.ts` | `now()`/`today()` use the real clock, not `Host.now` |
| P2 | Filter block | Its fields support `{{…}}` but aren't marked templated (no suggestions, no secrets) |
| P2 | `resolveLocator` | One cross-origin match among several `frame=` matches throws even when another is same-origin |
| P2 | Misc | Stale error texts (file inputs, role options), LogPanel trigger labels, "Last activity" capped by log lines, `bf:state:*` never cleaned, picker hint in form mode, `activeTab` permission unused |

### UX rough edges (fix during M0/M1)

These are not bugs, but they get in the way of a first-time user or an LLM:

- The picker targets the most recently used tab when the block has no URL, and opens a new tab on every pick when it has one. It can't use the Open Tab block's URL.
- "Use real mouse and keyboard" appears on blocks where it does nothing (Notify, Log, HTTP Request).
- The editor uses `alert`/`confirm`/`prompt` for notices and for the recorder's start URL.
- The Runs tab labels every event or called run as "turned on". The Reports filter has no Interrupted or Running option.
- Undo history is cleared when you switch workflows. Paste lands at a fixed offset, not at the mouse.
- There is no first-run onboarding: the test page `docs/manual-test/clock.html` isn't reachable from the editor.
- An unpacked build keeps its data only while it's loaded from the same folder.

## 7. Milestones

| Milestone | Content | Done when |
| --- | --- | --- |
| **M0: Stabilise and test** | Fix all P0/P1 bugs. Write e2e coverage for every block against `tests/fixtures/site`. Verify Firefox for real. Keep the Safari build compiling (verification is in M6). Add tests for library round-trips (ports, steps) | `npm run check` + `npm run e2e` cover every block; Firefox verified; P0/P1 closed |
| **M1: Script-first** | L1–L5, L9, L10. ARIA snapshot op | A model with only `llms.txt` can write a passing login test in one or two tries, using errors to fix itself |
| **M2: Parity essentials** | Locator filters and role options, click options, focus/blur/clear, drag and drop, drop zones, Wait for Download, Screenshot block, new Assert subjects, Cookies & Storage block, Switch, Repeat until, Wait For `request` | Every row marked M2 in §4 is ✅ |
| **M3: Network and environment** (Chromium, CDP) | Route/mock/block, HAR record, Emulate, clean-site-data isolation | Mocking and emulation e2e tests pass on Chrome; other browsers say "Chromium only" clearly |
| **M4: Outside access** | Native bridge, MCP server, CLI runner, Suite view | An agent can validate → run → read report → repair through MCP; CI runs a suite through the CLI |
| **M5: Debugging and visual** | Trace timeline with snapshots, breakpoints and step-over, visual comparison, ARIA snapshot assert | A failing test can be understood from its report alone |
| **M6: Ship** ✅ code (v1.0.0) | Encrypted secrets, permissions review (site access per workflow; `activeTab` was already gone), store listings, finish the wiki | Published on the Chrome Web Store and Firefox Add-ons (**a person does this**, see `docs/store/README.md`) |

Order: M0 → M1 → M2. M3 and M4 can run in parallel after M1, then M5 → M6.

## 8. Decisions (owner, 2026-11-05)

| # | Question | Decision |
| --- | --- | --- |
| 1 | Safari | Keep it as a build target. Verifying it (Mac, Xcode, no `debugger`/`userScripts`) moves to M6 |
| 2 | Watch Element vs Read Element | Keep both. Watch Element is the simple path for "tell me when this changes" |
| 3 | Bridge transport (L6) | Native messaging with a small companion app |
| 4 | Isolation | "Clean site data before run" first (M3). Incognito-window runs only if that proves not enough |
| 5 | Linear `steps` format (L2) | A second import format, and the one we tell models to use. The graph format stays the stored and exported form |
| 6 | Config key names | Rename `selector` (Read/Watch Element) and `next` (Paginate) to `locator`; old keys keep working as migrated aliases (M1) |
| 7 | Positioning | **"Playwright-compatible automation in your browser"** |
