# Implementation plan

> **Status:** 2026-11-06. **M0 done** (v0.2.0), **M1 done** (branch `m1-script-first`, v0.3.0); M2 is next
> (M3 and M4 may start in parallel). This is the
> task-level plan for [PLAN.md](PLAN.md): *what* to build is decided there (goal, gaps, decisions in §8).
> This file says *how*, in which order, with which files, tests and docs. Tick tasks off here as they
> land, and update the matching wiki pages in the same change.

## How we work

- **One branch and one PR per milestone** (large milestones may split into parts), into `main` on
  Forgejo, authored `akibh-dev`. The wiki is republished (`npm run wiki:publish`) after each merge.
- **Every task lands with:** tests (unit with `tests/helpers/fakeHost.ts`, jsdom for `src/dom`, e2e for
  anything that touches a real page or browser API), docs (usage guide, generated block reference via
  `npm run guide:sync`, the matching wiki page, the learning course when it points at changed code), and
  a green `npm run check` + `npm run build` + `npm run build:firefox`.
- **Rules from CLAUDE.md still bind.** Engine stays browser-free (`Host`), no `setTimeout` in blocks,
  JSON payloads, relative imports, page work through `page.act` ops.
- **Sizes:** S ≈ under half a day, M ≈ 1–2 days, L ≈ 3–5 days of focused work.
- **Versions:** M0 → 0.2, M1 → 0.3, M2 → 0.4, M3 + M4 → 0.5, M5 → 0.6, M6 → 1.0.

## Dependency map

```text
M0 Stabilise ──▶ M1 Script-first ──▶ M2 Playwright essentials ──▶ M5 Debugging & visual ──▶ M6 Ship
                      │                                                    ▲
                      ├──────────────▶ M3 Network & environment (CDP) ─────┤
                      └──────────────▶ M4 Outside access (bridge, MCP, CLI)┘
```

M1 must come before M2–M4: strict validation, error codes and migrations shape every new block's
config. M3 and M4 are independent of each other.

---

## M0: Stabilise and test (v0.2)

Goal: no known P0/P1 bugs, every block covered by an automated test that runs a real browser where it
matters, Firefox verified for real.

### M0.1 Bugs: done in part 1 (`551e273`)

- [x] **Import/Duplicate/templates keep `step` and `sourcePort`.** Import also refuses edges to missing
  blocks and duplicate block ids. `src/core/library.ts`; tests in `tests/core/library.test.ts`,
  `guideExamples.test.ts` (every example's ports and steps survive import).
- [x] **Timed-out steps are fenced off.** Late emits, sub-workflow calls and soft failures are refused;
  no steps are added to a finished run. `ctx.aborted()` added. `src/core/engine.ts`, `types.ts`.
- [x] **Start runs only by hand or when called.** Plain start blocks run once on switch-on, not on edits
  or browser start; edits restart a workflow only when its start blocks change (`rootSignature`).
  `engine.ts`, `workflow.ts`, `blocks/manualStart.ts`, `background.ts`.
- [x] **Live runs keep the worker awake.** `HybridScheduler.hold/release`, wired in `background.ts`.
- [x] **Timer delays ≤ 600 s wait inside the run.** Stop works mid-wait. Longer delays use a durable
  timer and also resume on a workflow that is off.
- [x] **HTTP Request `failOnError` fails the step.**
- [x] **Samples use `where`, not the legacy `newTab`.** Test: samples use only known config keys.
- [x] **Watch tabs in `storage.session`; legacy key removed.**
- [x] **Cancelled pick resets the editor.**
- [x] **Editor tabs merge each other's saves** (`editor/sync.ts`, `tests/editor/sync.test.ts`).

### M0.2 Bugs: remaining

| ID | Task | Where | How | Size |
| --- | --- | --- | --- | --- |
| M0.2a | ✅ **Real-input clicks in iframes land in the right place** | `src/dom/agent.ts` (`locate`), `src/browser/pageDriver.ts`, `cdp.ts` | `locate` returns frame-local coordinates. Add the frame's offset chain: for same-origin frames the agent walks `window.frameElement` up to the top, adding each `getBoundingClientRect()` plus border/padding. For cross-origin frames the driver asks the parent frame's agent for the iframe element's rect (it already knows the frame by `frameId` via `webNavigation.getAllFrames`) and adds it. e2e: real-input click inside the same-origin and cross-origin frames in `tests/fixtures/site/frame-inner.html` must report `isTrusted` and hit the right button | M · **Done** |
| M0.2b | ✅ **Picker and recorder see through shadow DOM** | `src/dom/picker.ts`, `src/dom/recorder.ts` | Use `event.composedPath()[0]` instead of `event.target` in the window-level capture listeners; generate the locator with `>>>` for elements in open shadow roots (`bestLocator.ts` already understands shadow hosts for CSS). jsdom tests with a custom element | S · **Done** |
| M0.2c | ✅ **Picker and recorder work inside iframes** | `src/browser/picking.ts`, `recording.ts`, `src/dom/picker.ts`, `recorder.ts` | Inject with `allFrames: true`. A frame's picker sends its locator plus its frame path; the background turns it into `frame=<iframe css> >> <locator>` (asking the parent frame for a CSS path to the iframe element). Only the top frame shows the toolbar; frames forward Esc/Enter. e2e: pick and record inside both fixture frames | L · **Done** |
| M0.2d | ✅ **Recorder follows popup tabs** | `src/browser/recording.ts`, `src/core/recording.ts` | Accept steps from tabs whose opener is the recording tab (`bf:popups` already tracks openers). Emit a Wait for Popup step (`name: popup`) and `tab: "popup"` on the following steps | M · **Done** |
| M0.2e | ✅ **Recording into a non-empty workflow connects to it** | `src/entrypoints/editor/Editor.tsx`, `src/core/recording.ts` | When the workflow already has an Open Tab on the recorded tab's origin, drop the recorded Open Tab and connect the first recorded block to the selected block (or the last block of the main path). Place blocks to the right of the selection, not below. Fix the misleading comment | M · **Done** |
| M0.2f | ✅ **One secret name per password field** | `src/core/recording.ts` | Name secrets from the field's label/name (`{{secret.password}}`, `{{secret.adminPassword}}`…), deduplicated; the editor's banner lists the secret names to create | S · **Done** |
| M0.2g | ✅ **Playwright export fixes** (done: runtime inlined from the real core source by `src/core/playwrightRuntime.ts`; e2e `playwright-export` runs 3 exported workflows green) | `src/core/playwright.ts`, `src/core/playwrightRuntime.ts`, `tests/core/playwright.test.ts`, `tests/e2e/specs/playwright-export.mjs` | `{{$json.x}}` and dashed keys; Wait For `response` → `page.waitForResponse(pattern)`; Assert url/title/value with retrying `expect(page).toHaveURL/ toHaveTitle`, `expect(locator).toHaveValue`; operators beyond equals/contains through `expect.poll`; Timer delay → `page.waitForTimeout`; `step.retries` → `test.describe.configure({ retries })` comment or a retry helper, `timeoutSeconds` → `{ timeout }`; Open Tab `where: "current"` → reuse `page`; Transform/Filter/Data Table through a small runtime helper module emitted at the top of the spec (expression evaluator is pure, so it can be inlined); proper CSV parsing (reuse `src/core/csv.ts` logic). Every change gets a snapshot test, and e2e re-runs the exported spec | M |
| M0.2h | ✅ **Small fixes (P2)** (all done; the frame/picker items landed with M0.2a–f) | various | `expression.ts` `now()/today()` take the clock from the evaluation context (Host.now); Filter fields marked `templated`; `resolveLocator` tries every `frame=` match and only throws `FrameBoundaryError` when none is same-origin; stale texts (file inputs, role options incl. `include-hidden`, picker hint per mode); LogPanel trigger labels (`event` → "page event", `call` → "called by"); Reports filter gets Interrupted and Running; "Last activity" from run records, not log lines; `bf:state:*` removed when a workflow is deleted; drop unused `activeTab` permission; `scripts/guide.ts` anchors with GitHub's leading dash for emoji headings; delete `readSelectorInPage` and `clearScreenshots`/`clearRecording` if still unused. **Done:** `EvalEnv` (`evaluate`/`render`/`resolveConfig` third argument, `evalEnv(ctx)` in data blocks); Filter `templated` + `perItem`; `diffWorkflows().removed` → timers + `clearWorkflowState`; `TRIGGER_LABELS`; anchors per github-slugger (U+FE0F kept, percent-encoded) | M |
| M0.2i | ✅ **UX rough edges** (all done; picker URL and tab reuse landed with M0.2c) | editor | "Use real mouse and keyboard" only on page-action blocks (field metadata `pageAction: true`); replace `alert/confirm/prompt` with an in-editor toast + confirm dialog + small modal (recorder start URL); undo history kept per workflow (map by id); paste at the mouse position; the All workflows switch disabled when a workflow has problems (same as header). **Done as:** `BlockDefinition.realInput` (Click, Fill, Fill Form, Select Option, Check, Press Key, Paginate); `components/Dialogs.tsx` (`toast`, `confirmDialog`, `promptDialog`); `histories` map; e2e `editor-ux`. Picker uses the URL of the nearest Open Tab upstream when the block has none, and reuses one picker tab per editor instead of opening a new one each time | M |
| M0.2j | ✅ **First-run onboarding** (an extension page can't be automated, so the playground is `docs/manual-test/playground.html` served by `npm run playground`) | editor, `docs/manual-test`, `scripts/playground.mjs` | Ship `docs/manual-test/clock.html` as an extension page (`public/playground.html`) with a few elements to watch, click and fill; first editor open shows a short "Try it" card that opens it with a ready template. **Done differently:** an extension page cannot be automated (Chromium refuses to script `chrome-extension://` pages, the extension's own included; checked in Chromium 131), so `docs/manual-test/playground.html` is served by `npm run playground` at `http://localhost:7357`; the card (`TryItCard`, `bf:onboarding`) checks it is up and creates the `playground-tour` template | S |

### M0.3 Test coverage

Every block gets at least one unit test and, when it touches a page or a browser API, one e2e check.
Blocks with no e2e check today:

| Block | Missing | Add | Done |
| --- | --- | --- | --- |
| Start | e2e | Run with starting values, and as a called workflow with caller values winning | x |
| Timer | e2e | Short repeating timer survives a worker stop (exists in README history; move into `run.mjs`), in-run delay, Stop during delay | x (in-run delay, Stop during a delay, repeating trigger; the worker-stop check is not automated) |
| Schedule | e2e | `every: minutes` with a fake system time is not possible; check that the alarm is created with the right `when` | x |
| Context Menu | unit + e2e | Unit: config → menu item; e2e: `contextMenus.onClicked` dispatched via `chrome.contextMenus` test hook (call the background's handler through a test-only message when `BF_E2E`) | x (`bf:e2e-menu-click`, BF_E2E builds only) |
| Watch Element | e2e | Change detection on `feed.html` | x (on a new `ticker.html`: `feed.html` does not change by itself) |
| Navigate | e2e | back/forward/reload/goto on `spa.html` | x (back/forward fixed: fall back to `history.back()` in the page) |
| Press Key | e2e | Enter submits, Control+A selects | x (`keys.html`) |
| Page Info | unit + e2e | Title/meta/JSON-LD on a new `meta.html` fixture; local/session storage; cookies | x |
| Stop | e2e | pass/fail outcomes | x |
| Repeat, Filter | e2e | small data flows (cheap, they're pure, but prove the editor wiring) | x |
| Notify | e2e | notification created (read through `chrome.notifications.getAll`) | x |
| Scroll | unit | the end/top/element modes against `FakeHost` | x |

Also:

- [x] **Split `tests/e2e/run.mjs`** (≈600 lines) into one file per area under `tests/e2e/specs/`, sharing
  `harness.mjs` (launch, `seedWorkflows`, `run`, `check`). `npm run e2e -- <name>` runs one area.
- [x] **e2e in CI.** A GitHub Actions job runs Chromium headless with the extension (new headless
  supports extensions) under `xvfb-run` as a fallback. Runs on PRs touching `src/browser`, `src/dom`,
  `src/entrypoints`, `tests/e2e`.
- [x] **Coverage report** (`vitest --coverage`) published as a CI artifact; no threshold yet.
  (`npm run test:coverage`; the e2e job runs on every PR and push to `main`, not only on PRs touching
  `src/browser`, `src/dom`, `src/entrypoints`, `tests/e2e`.)

### M0.4 Firefox verification

Firefox is installed on the dev machine; Safari waits for M6 (decision §8.1).

- [x] `npm run build:firefox` and `web-ext lint`: 0 errors (6 `innerHTML` warnings from React DOM and the
  picker/recorder templates).
- [x] **Firefox e2e** `tests/e2e/firefox.mjs` (`npm run e2e:firefox`, CI job `e2e-firefox`): Playwright can't load
  extensions into Firefox, so the runner drives Firefox over WebDriver BiDi (`webExtension.install`), and a
  test-only bridge content script (e2e builds only) relays messages, since BiDi can't open `moz-extension://`
  pages. 14 checks pass on Firefox 159.
- [x] Nothing broke; results recorded in README "What has been verified". Not tried yet: a user granting
  host access by hand on a normal (non-temporary) install.

**M0 done when:** all P0/P1 rows of PLAN §6 closed; every block has unit + (where relevant) e2e
coverage; e2e runs in CI; Firefox checklist passes; wiki updated; v0.2 tagged.

---

## M1: Script-first (v0.3)

Goal: a model with only `llms.txt` writes a passing login test in one or two tries, using BlockFlow's
errors to repair its own script.

### M1.1 Strict validation with paths, codes and suggestions (L1) ✅

- **New module `src/core/check.ts`**: `checkFile(raw: unknown, registry): Issue[]` runs on the *raw*
  file before ids are replaced, so paths and ids are the author's. `Issue = { level, code, path, message,
  hint? }`, `path` a JSON Pointer (`/workflows/0/nodes/3/config/locater`).
- **Codes** (stable, documented in the guide's "Repair" table): `json.invalid`, `file.shape`,
  `node.id.duplicate`, `node.type.unknown`, `config.key.unknown`, `config.type`, `config.required`,
  `config.enum`, `config.locator.invalid`, `config.url.invalid`, `config.template.invalid`,
  `edge.endpoint.missing`, `edge.port.unknown`, `step.key.unknown`, `step.value`, `graph.no-start`,
  `graph.cycle`, `graph.unreachable`, `page.no-tab` (a page block with no Open Tab upstream on every
  path), `workflow.call.missing`, `secret.unknown` (warning when the secret store is known).
- **Did-you-mean** for unknown types and keys (Damerau-Levenshtein ≤ 2 against the registry).
- **Per-block conditional rules**: optional `validate(config): {key, code, message}[]` on
  `BlockDefinition` (Assert subject → locator/name; Wait For mode → text/url/locator; Upload → content or
  url; Download from dataset → dataset). The editor shows these too (`validate.ts` calls the same hooks).
- **Type checks** from field kinds: number, boolean, select options, rows shape, locator syntax
  (`parseLocator` from `locatorSyntax.ts`), URL (template-aware).
- **Schema**: `scripts/guide.ts` emits `additionalProperties: false` per block config and for `step`, and
  `enum`s for selects, so editors and LLM tool-use validate before import.
- **Import** calls `checkFile` first; errors block the import and are listed in a panel (not an alert)
  with their paths; warnings import with a banner.
- Tests: one fixture per code in `tests/core/check.test.ts`.

### M1.2 Linear `steps` format (L2) and auto-layout (L3) ✅

```json
{ "format": "blockflow-script", "version": 1, "name": "Login test",
  "steps": [
    { "open": "https://example.com/login" },
    { "fill-form": { "fields": [{ "locator": "label=Email", "value": "me@x.dev" }], "submit": "role=button[name=\"Sign in\"]" } },
    { "id": "check", "assert": { "subject": "text", "locator": "role=heading", "operator": "contains", "expected": "Welcome" },
      "step": { "onError": "port" }, "onError": [ { "notify": { "title": "Login broken", "message": "{{error}}" } } ] }
  ] }
```

- Each step is `{ "<block type or alias>": config }` plus optional `id`, `step`, and branch lists
  keyed by port (`true`, `false`, `each`, `done`, `onError` → `error`). Branches are nested step lists.
  Aliases for the most common blocks (`open` → `open-url` with `url`, `click` with a string → locator).
- **Compiler** `src/core/script.ts`: `compileScript(raw) → Workflow` (nodes, edges with ports, ids from
  `id` or generated) and `decompile(workflow) → script` when the graph is a tree (for export "as script").
- **Auto-layout** `src/core/layout.ts`: layered left-to-right layout (longest-path layering, barycentric
  ordering, 260 px × 140 px grid). Used for scripts, for imports without positions, and as a "Tidy up"
  button in the editor.
- Import accepts both formats; the guide and `llms.txt` teach the script format first (decision §8.5).
- Tests: round-trip of every guide example (graph → script → graph is isomorphic), layout snapshot tests.

### M1.3 Page snapshot for authoring (L4) ✅

- **New page op `snapshot`** (`src/core/page.ts`, `src/dom/agent.ts`, jsdom tests): walks the
  accessibility tree (`aria.ts` roles and names), skipping hidden nodes, and returns a compact outline:
  `- button "Sign in" [ref=e12] locator=role=button[name="Sign in"]`, with frames and shadow roots
  marked. The locator per element comes from `bestLocator.ts` (unique, readable first). Cap ~1,500 lines.
- **Block `page-snapshot`** (read category): outputs `snapshot` (text) and `elements` (list), so a run
  can record what the page looked like. The editor gets a "📸 Snapshot page" button on Open Tab that
  copies the outline (useful when chatting with an LLM before M4 exists).
- Same op later backs the MCP tool `snapshot_page` (M4) and the ARIA assert (M5).

### M1.4 Machine-readable results (L5) ✅

- `StepRecord` gains `code` (from a small error taxonomy: `locator.not-found`, `locator.strict`,
  `element.not-visible`, `element.disabled`, `element.covered`, `timeout`, `assert.failed`, `http.status`,
  `navigation.failed`, `permission.missing`, `script.error`…), `locator`, `url`, and `matches` (up to 5
  descriptions for strict-mode errors). Page errors already carry most of this text: give `agent.ts`
  errors a `code` field and carry it through `pageDriver.ts` → engine.
- Steps also record `sourceId`, the author's node id from the imported file (kept on `NodeDef` as
  `origin`), so a report maps back to the script.
- JSON report export gets a versioned schema (`docs/guide/report.schema.json`, generated).

### M1.5 Versioning and migrations (L9) and key renames (§8.6) ✅

- `src/core/migrate.ts`: `migrate(workflow) → Workflow` applied on load and import. `schemaVersion: 2`
  renames `selector` → `locator` (Read Element, Watch Element) and `next` → `locator` (Paginate); old keys
  still accepted in files (migrated, with a `config.key.renamed` info issue).
- Tests: v1 fixtures of every changed block load as v2; the stored list is rewritten once.

### M1.6 Docs for models (L10) ✅

- Guide: the script format first, a "Repair" table (code → fix), the snapshot workflow, examples
  converted to scripts (graph versions kept and tested).
- `llms.txt` points to the script format, the schema, the repair table.
- An eval set: 10 tasks against `tests/fixtures/site` (login, scrape, upload…) with expected outcomes,
  runnable later through the CLI (M4) to measure "passes in ≤ 2 tries".

**As built (v0.3.0).** Import checking: `check.ts` (codes, JSON Pointers, did-you-mean in `suggest.ts`),
blocks' `validate` hooks shared with the editor, an issues dialog with Copy. Scripts: `script.ts` (aliases,
shorthands, If rejoin, several scripts per file, Export as script), `layout.ts` (also Tidy up); script
files get the same strict check with paths moved back to the author's steps. Snapshot: page op `snapshot`
(`src/dom/snapshot.ts`), block `page-snapshot`, "📸 Snapshot page" on Open Tab. Results: `errors.ts`
(24 codes), `StepRecord.code/locator/url/matches/sourceId`, `report.schema.json`. Migration: `migrate.ts`
(schema v2). Docs: script format first in the guide and `llms.txt`, Repair and error-code tables; eval set
with reference solutions scored by `npm run e2e -- evals`. **Not yet measured:** whether a model passes in
≤ 2 tries; that needs the CLI (M4.3) to run the eval set against a model.

**M1 done when:** strict check + codes + suggestions in import and editor, script format with
round-trip tests, snapshot op and block, coded step errors, v2 migration, docs; wiki pages
Workflows-as-Scripts, Troubleshooting, Core-Modules, Page-Protocol updated.

---

## M2: Playwright essentials (v0.4)

| ID | Feature | Design | Tests | Size |
| --- | --- | --- | --- | --- |
| M2.1 | **Locator filters** | `locatorSyntax.ts` grammar: `>> has-text=…`, `>> has=<locator>`, `>> has-not=…`, `>> visible`, `A \|\| B` (or). `locator.ts` applies them as filters on the current match set, like Playwright's `filter()`. Readable locators from `bestLocator.ts` may use `has-text` to disambiguate | jsdom unit tests per filter; guide §4 table | M · **Done** |
| M2.2 | **Role options** `pressed`, `expanded`, `selected`, `disabled` | `aria.ts` state readers; `parseRole` accepts them | jsdom | S · **Done** |
| M2.3 | **Click options** | Click config: `button` (left/middle/right), `modifiers` (Alt, Control, Meta, Shift), `position` (x,y in element), `clickCount`. Synthetic path sets the event fields; real input passes them to `Input.dispatchMouseEvent` | jsdom + e2e (trusted.html logs modifiers) | M |
| M2.4 | **Element Action block** (`element-action`) | One block, `action`: focus, blur, clear, scroll-into-view, dispatch-event (`eventType`, `detail` JSON). New page ops `focus`, `blur`, `clear`, `dispatch` | jsdom + e2e | M |
| M2.5 | **Drag and drop** (`drag`) | Config `from`, `to` locators (+ optional offsets). Synthetic: pointerdown/mousedown, dragstart with a shared `DataTransfer`, dragenter/dragover on target, drop, dragend, pointer/mouse up; works for HTML5 DnD. Real input: CDP `Input.dispatchMouseEvent` moves with `Input.setInterceptDrags` + `dispatchDragEvent` for native DnD. New op `drag` | new fixture `dnd.html` (HTML5 list + a pointer-events slider); e2e both modes | L |
| M2.6 | **Drop zones** | Upload File `target: input \| dropzone`; dropzone mode dispatches dragenter/dragover/drop with a `DataTransfer` carrying the `File` | fixture `upload.html` gets a drop zone | S |
| M2.7 | **Wait for Download** (`wait-for-download`) | `Host.downloads.waitFor(pattern, timeoutMs)` on `downloads.onCreated`/`onChanged` with a look-back like Wait for Popup; output `filename`, `url`, `size`, `mime`, `downloadId`. Optional `saveAs` into a dataset (text files) | e2e with a fixture link to a generated CSV | M |
| M2.8 | **Screenshot block** (`screenshot`) | `area`: visible (captureVisibleTab), full-page and element (CDP `Page.captureScreenshot` with `captureBeyondViewport` / `clip`, Chromium; Firefox: `tabs.captureTab` has a `rect` option for element and full page). Stored in `blobStore`, shown in the step and report; output `screenshotId` | e2e per mode | M |
| M2.9 | **More Assert subjects** | `class` (has/contains), `css` (`name` = property), `focused`, `editable`, `in-viewport` (ratio > 0, IntersectionObserver once), `accessible-name`, `accessible-description`. Agent `read` kinds extended | jsdom + e2e | M · **Done** |
| M2.10 | **Cookies & Storage block** (`cookies-storage`) | `action`: get/set/delete/clear on `area` cookies (`cookies` permission, optional) or local/session storage (page op `storage`). Clearing cookies for an origin uses `cookies.getAll({ url })` + `remove` | e2e on fixture origin | M |
| M2.11 | **Switch block** (`switch`) | Dynamic ports: `ports` becomes `ports?: string[] \| ((config) => string[])`; `nodePorts` and the editor read it. Config rows `{port name, operator, value}` evaluated in order + `default` port | unit + editor convert test | M |
| M2.12 | **Repeat until / while** | Repeat gets `until` condition (left/operator/right, templated per iteration) and `max` iterations; same evaluator as If | unit | S |
| M2.13 | **Wait For `request`** and response body | `mode: request` (method, url pattern); `response` mode can capture the body (`captureBody: true`, CDP `Network.getResponseBody` when real input/debugger is granted, else not available) | e2e on api.html | M |
| M2.14 | **Keyboard chords** | Verify `Control+Shift+K`, `Meta+A` in both input modes; add `insertText` mode to Press Key | jsdom + e2e | S · **Done** |
| M2.15 | **Upload from data** | Upload File `source: data` (base64 from a previous block, e.g. HTTP Request `body64`) | unit | S |

**M2 done when:** every M2 row in PLAN §4 is ✅, each with guide + block reference + recipes updated,
Playwright export covers the new blocks (or marks them), and Capabilities-and-Limitations is refreshed.

---

## M3: Network and environment (v0.5, Chromium via CDP)

Shared groundwork:

- **`src/browser/cdp.ts` sessions per run**: attach once per tab per run (refcounted), enable domains
  lazily, detach at run end (`onRun` finished) or tab close. A run that used CDP shows it in the report.
- Every CDP feature checks `browser.debugger` and the optional permission; on Firefox and without the
  permission the block fails with code `permission.missing` and a clear message.

| ID | Feature | Design | Size |
| --- | --- | --- | --- |
| M3.1 | **Route block** (`route`) | Rules `{url pattern, method?, action: fulfill \| abort \| continue \| modify}` with `status`, `headers`, `body` (templated, JSON helper), `delayMs`. CDP `Fetch.enable({patterns})` + `Fetch.requestPaused` handler in the background for the run's tabs; rules live for the rest of the run (or until a `route` block with `clear`). Cross-browser subset (`abort`, redirect) through `declarativeNetRequest` session rules scoped to the tab id | L |
| M3.2 | **HAR recording** (`har-record` start/stop) | Collect `Network.*` events for the run's tab into HAR 1.2; on stop, save into a dataset or Download. Replay is deferred | M |
| M3.3 | **Emulate block** (`emulate`) | `device` presets (from a small built-in table: iPhone, Pixel, iPad, desktop sizes), `viewport`, `deviceScaleFactor`, `userAgent`, `locale`, `timezone`, `geolocation`, `colorScheme`, `reducedMotion`, `offline`. CDP `Emulation.*` / `Network.emulateNetworkConditions`; cleared at run end | M |
| M3.4 | **Clean site data before run** | Step-less workflow setting `isolation: { clearSiteData: [origins] }` or block `clear-site-data`; `browsingData.remove({ origins }, { cookies, localStorage, indexedDB, cacheStorage, serviceWorkers })` (new optional permission `browsingData`) | S |
| M3.5 | **Console and errors capture** | With CDP attached, record `Runtime.consoleAPICalled` and `Runtime.exceptionThrown` per step into the run record (bounded), shown in Reports; Assert subject `console-errors` count | M |

Fixtures: `api.html` and new `geo.html` (shows timezone, locale, geolocation, color scheme, online
state). e2e per feature. **M3 done when:** Route, HAR, Emulate, clean data and console capture pass e2e
on Chromium, fail cleanly elsewhere, and are documented with "Chromium only".

---

## M4: Outside access (v0.5)

Decision §8.3: native messaging with a small companion.

### M4.1 Bridge (L6)

```text
 MCP client (Claude…) ──stdio──▶ blockflow-mcp ──┐
 CLI (blockflow run)  ─────────▶                 ├─ local socket (unix / named pipe, per-user, token) ─▶ native host
                                                 ┘                                                     ▲   stdio (native messaging)
                                                                                         extension background (connectNative)
```

- **Native host** `packages/bridge/` (Node, published as `blockflow-bridge`): `blockflow-bridge install`
  writes the host manifest for Chrome/Chromium/Brave/Edge and Firefox with the extension ids; the browser
  launches it when the extension calls `runtime.connectNative('dev.akibh.blockflow')`. It listens on a
  per-user socket (`$XDG_RUNTIME_DIR/blockflow.sock`, `\\.\pipe\blockflow-<user>`) protected by a token in
  `~/.config/blockflow/token`.
- **Extension side** `src/browser/bridge.ts`: a "Allow outside control" switch (off by default, editor
  Settings page). While on, the worker keeps the native port open (an open native port keeps an MV3
  worker alive) and serves requests: `validate`, `import`, `list`, `run` (by id or inline script,
  returns the run record when finished, streams step updates), `report`, `snapshot` (tab or URL),
  `stop`. Every request is logged; imported workflows are tagged "via bridge".
- Protocol: JSON-RPC 2.0 over both hops, request ids, size-limited messages (1 MB native messaging limit;
  screenshots go by blob id + separate `blob.get` chunks).

### M4.2 MCP server (L7)

`packages/mcp/` (`blockflow-mcp`, stdio): tools `list_workflows`, `validate_workflow` (script or graph,
returns M1 issues), `run_workflow` (inline script or id; returns status, failing step, code, locator,
URL, screenshot), `get_report`, `snapshot_page` (url or current tab → M1.3 outline), `stop_run`.
Resources: the guide, block reference and schema. Prompt: "write and repair a BlockFlow test".
Tested with an MCP inspector and the M1 eval set.

### M4.3 CLI runner (L8)

`blockflow run <file|dir> [--report junit|json|html] [--out dir] [--headed] [--browser path]`:
launches Chromium with the built extension (reusing the e2e harness), enables outside control in that
profile, imports through the bridge, runs, writes reports, exits non-zero on failure. Secrets from env
(`BLOCKFLOW_SECRET_<NAME>`). Used in CI for the guide examples.

### M4.4 Suites

Editor "Suites" page: named list of workflows, run in order, one combined report (JUnit with one
testcase per workflow, HTML with sections). Stored under `bf:suites`. CLI runs a suite by name or file.

**M4 done when:** an agent can validate → run → read report → repair through MCP against the fixture
site, the CLI runs the guide examples in CI, and suites produce a combined JUnit report.

---

## M5: Debugging and visual (v0.6)

| ID | Feature | Design | Size |
| --- | --- | --- | --- |
| M5.1 | **Trace timeline** | Step setting / run option `trace`: before/after screenshots per page step, the locator's bounding box, console (M3.5) and network summary when CDP is on. Reports page gets a timeline view (step list + filmstrip). Storage bounded per run (blobStore quota, oldest runs evicted) | L |
| M5.2 | **Breakpoints and step-over** | Step setting `pause: true`; Run with "Debug" pauses before such steps (and on failure when "pause on error" is ticked). The engine awaits a `Host.prompts`-like `debug` channel; the editor shows Continue / Step / Stop and the current input. Highlights the element on the page | M |
| M5.3 | **Visual comparison** | Screenshot block `compare: true` with a baseline per (workflow, block) in IndexedDB; diff in the editor/offscreen document with `OffscreenCanvas` (pixelmatch-style threshold, mask regions); report shows baseline/actual/diff; "Accept new baseline" button | L |
| M5.4 | **ARIA snapshot assert** | Assert subject `aria-snapshot` compares the M1.3 outline (without refs/locators) against an expected template with Playwright-like partial matching (`- heading "Welcome"`, regex names) | M |
| M5.5 | **Run from here / re-run failed** | Run a workflow starting at a selected block with the input of its last run; re-run only failed workflows of a suite | S |

---

## M6: Ship (v1.0)

| ID | Task | Design | Size |
| --- | --- | --- | --- |
| M6.1 | **Encrypted secrets** | WebCrypto AES-GCM; key from a passphrase (PBKDF2, 600k iterations) unlocked once per browser session and kept in `storage.session`; optional "no passphrase" mode keeps today's behaviour with a warning. Migration encrypts existing secrets | M |
| M6.2 | **Permissions review** | Optional host permissions per workflow (`optional_host_permissions` + "Grant access to example.com" when a workflow is switched on or run), drop `activeTab`, justify each permission in `docs/PRIVACY.md` | M |
| M6.3 | **Safari** | Convert with `xcrun safari-web-extension-converter`, verify what works without `debugger`/`userScripts`/offscreen, document | M |
| M6.4 | **Store releases** | Chrome Web Store and Firefox Add-ons listings (screenshots, description using the §8.7 positioning, privacy policy), `npm run zip` / `zip:firefox` in a release workflow, signed Firefox build | M |
| M6.5 | **Docs complete** | Internals wiki for everything added since, learning course lessons for the bridge and CDP, README status → 1.0 | M |
| M6.6 | **Performance and limits** | Large workflows (500 blocks) render and save smoothly; run history and dataset quotas configurable; memory of long-running For Each bounded | S |

---

## Tracking

| Milestone | Branch | Status |
| --- | --- | --- |
| M0 | `m0-stabilise` | ✅ Done: 395 unit tests, 122 Chromium e2e checks (Brave), 14 Firefox e2e checks |
| M1 | `m1-script-first` | ✅ Done: 544 unit tests, 154 Chromium e2e checks in 14 specs (system Chromium), 14 Firefox e2e checks; eval set: 10/10 reference solutions pass |
| M2 | `m2-essentials` | Not started |
| M3 | `m3-network` | Not started |
| M4 | `m4-outside-access` | Not started |
| M5 | `m5-debugging` | Not started |
| M6 | `m6-ship` | Not started |
