# Architecture

## One-paragraph version

A workflow is a graph of blocks. The **engine** (`src/core`) knows nothing about browsers: it runs the
graph against a `Host` interface (open a tab, read a page element, schedule a timer, keep a bit of
state). `src/browser` implements that interface with real extension APIs; tests implement it with
in-memory fakes. The **background worker** loads enabled workflows and lets the engine run them. The
**editor** only edits workflows in storage; it never talks to the engine directly.

```text
 Editor (React)                Background worker                    Web pages
 ──────────────                ─────────────────                    ─────────
 edit workflow ──▶ storage ──▶ onChanged → diffWorkflows()
                               start/stop affected workflows
                               WorkflowRunner ──▶ Host ──▶ tabs.create / scripting.executeScript ──▶ page
 run log  ◀── storage ◀──────  log sink                      alarms ──▶ onAlarm → runner.handleTimer()
 runs     ◀── storage ◀──────  onRun (bf:runs)
 Run/Stop ──message──────────▶ runner.runOnce() / cancel
 "Pick on page" ──message──▶ picking.ts ──inject──▶ picker (content script) ──message──▶ editor
```

## Engine model (`src/core/engine.ts`)

- Blocks are nodes, connections are edges. A block's **output payload** is passed to every block connected
  to that output as its **input payload**. Each branch gets its own copy.
- **Outputs (ports, `src/core/ports.ts`).** Most blocks have one output, `out`. A block can declare more
  (`ports: ['true', 'false']` on If) and choose one by returning `routeTo(port, payload)`. An edge stores
  its `sourcePort`; edges saved before ports existed have none and belong to the block's first output.
- A block with nothing connected to its input is a **root**. `start()` calls `def.start(ctx)` on each
  root, or `def.run(ctx, {})` once if the block has no `start`.
- A non-root block's `run(ctx, input)` is called when an upstream block emits. Returning a payload
  continues the flow; returning `null` ends it. Blocks that emit later (timers, watchers) call
  `ctx.emit(payload)` from `start` or `onTimer`.
- Settings marked `templated` are rendered against the input payload (`{{url}}`) right before the block
  runs, then validated.
- **Runs (`src/core/runs.ts`).** Each trip of data through the workflow is a run: one per start-block
  firing, or one per press of **Run** (`runOnce()`, which calls a start block's `trigger()` instead of
  starting its schedule). Every block it passes is a **step**. The runner reports a copy of the run after
  every change to `onRun`; the background stores it in `bf:runs` (last 40, big payloads replaced by a
  preview) and the editor reads it from there to colour blocks and fill the step inspector.
- **Step settings** (`NodeDef.step`) are applied by the engine in `runStep()`, never by blocks: timeout
  (default 60s, via `Host.sleep`), retries with 1s/2s/4s backoff, disabled (pass the input through), and
  on error: `stop` (this path stops, the run fails), `continue` (pass the input on), or `port` (send
  `{...input, error}` out of an extra `error` output).
- **Stop button**: the runner asks `isCancelled(runId)` before every step. **Worker death**: on every
  worker start, runs still marked `running` that this worker does not own become `interrupted`.
- A run stops after 1000 steps (`DEFAULT_MAX_STEPS`), so accidental loops end.
- **Soft failures**: `ctx.softFail(message)` marks the step and run failed but lets the block return
  normally (soft Assert).
- **Screenshots**: after a failed or handled step (or every step, by step setting) the engine asks
  `Host.screenshots.capture(tabId)` for the step's tab (`config.tab`, else `main`, looked up in
  `$session`). The browser host uses `tabs.captureVisibleTab`, so only a tab showing in its window can
  be captured; images go to IndexedDB (`src/browser/blobStore.ts`, newest 150 kept) and the step keeps
  the id.
- **Sub-workflows**: `ctx.callWorkflow(id, input)` builds a child `WorkflowRunner` (same host, registry,
  observer; `callDepth + 1`, max 8) and calls `runAsCall(input)`: every start block gets the input, and
  the data at the end of the last path (`lastOutput`) is the result. The child run is a separate record
  with `parentRunId`; the calling step keeps `childRunId`. Stopping the parent stops the child.
- **Secrets**: loaded once per run from `Host.secrets`, offered to templates as `secret.*` (never put in
  the payload), and masked (`maskText`/`maskPayload` in `runs.ts`) in every log line, step input/output
  and error.
- **Manual Step** uses `Host.prompt.ask`: the background lists the question in `bf:prompts` (the editor
  shows a banner), shows a notification with Continue/Fail buttons, and waits, calling an extension API
  every 500 ms so the worker stays awake.

This is why any block can feed any other: a block only ever sees "a payload came in" or "I was started",
never which block sent it.

## Surviving the background worker sleeping

Chrome stops the MV3 service worker after about 30 seconds idle (and the keep-alive above is only a
convenience for short timers), so nothing important lives in memory:

- **Timers** go through `Scheduler`, implemented by `HybridScheduler` (`src/browser/hybridScheduler.ts`).
  The timer key is `bf::<workflowId>::<nodeId>::<timerName>`. Every timer is stored in `storage.local`
  (`bf:timer:<key>`, including any payload it carries) and has a `browser.alarms` entry.
  - **30s or more:** the alarm does the work. When it fires, `background.ts` builds a **fresh**
    `WorkflowRunner` and calls `handleTimer(key)`, which finds the block and calls its `onTimer`.
  - **Under 30s** (alarms cannot do this in published extensions): an in-memory `setTimeout` fires it, then
    goes through the same `onAlarm` path. While any such timer is armed, a ping (`runtime.getPlatformInfo`
    every 20s) resets the worker's idle timer so it is not stopped. The alarm becomes a 30s *heartbeat*:
    if the worker dies anyway, the heartbeat wakes it and `handleAlarm()` re-arms the in-memory timer.
  - `restoreAll()` runs on every worker start: it recreates alarms the browser forgot and re-arms short
    timers. An overdue periodic timer waits a full period; an overdue one-shot fires straight away.
  - All browser access is behind small ports (alarms, store, clock, ping), so the logic is tested with a
    fake clock in `tests/browser/hybridScheduler.test.ts`.
- **Block state** (the last value Watch Element saw, a Timer's tick count) is in `Host.state`
  (`storage.local`), via `ctx.state`.
- `start()` is only called when a workflow is enabled or edited, on browser startup, and on install. A
  plain worker wake-up never re-runs start blocks.
- `diffWorkflows()` compares old and new saved workflows. It ignores block positions and names, so
  dragging a block never restarts a workflow.

## Page blocks and the page agent

A run keeps its tabs by name in the payload: `$session.tabs.main = <tabId>` (`src/core/session.ts`). Open
Tab adds one; every page block has a Tab field (default `main`) and fails with a clear message if that tab
is not in the run. Being plain payload data, it survives timers and worker restarts.

Page blocks send one request each to `Host.page.act(tabId, request, timeoutMs)` (`src/core/page.ts`):

```text
 block (core) ── act() ──▶ pageDriver.ts ── scripting.executeScript ──▶ agent (content script, isolated world)
                           │  inject agent.js when the page has none           │ locator.ts: find
                           │  ask again every ≤2s until the timeout            │ actionability: visible, enabled,
                           │  "vanished" after an action = it navigated        │   stable, not covered
                           ◀────── done / pending + reason / error ────────────┘ events: pointer/mouse/key/input
```

- **Locators** (`src/dom/locator.ts`): CSS (default, `>>>` pierces open shadow roots), `text=`, `role=`
  (with a simplified ARIA role and accessible-name model in `aria.ts`), `label=`, `placeholder=`,
  `testid=`, `alt=`, `title=`, `xpath=`, chained with `>>`, `nth=`. Actions are **strict**: two matches is
  an error that suggests `>> nth=0`.
- **Auto-wait**: each action waits for exactly one match that is visible, enabled (and editable for
  Fill), stable for two looks 50 ms apart, and is what `elementFromPoint` hits at its center (a label
  covering its own checkbox counts as the checkbox). A timeout reports the last reason.
- **Why short calls**: a navigation destroys the page and the agent mid-wait; extension API calls every
  ≤2s also keep the MV3 worker from being stopped during long waits.
- **Values** are set through the native prototype setter plus `input`/`change` events, which React, Vue
  and Angular all pick up. Keys are synthetic, so their default actions (type a character, Enter submits,
  Tab moves focus) are done by the agent.
- **Waiting for the page**: `navigation.ts` polls tab status for load, counts in-flight requests with
  `webRequest` (observe only) for network idle, and polls the tab URL for URL patterns, which also catches
  `history.pushState` in single-page apps.
- Watch Element and Read Element with a Page URL still use BlockFlow's own background tab per URL, but read
  through the agent too, so every locator works there.

Known gaps (see docs/PLAN-automation.md, phase F): events are `isTrusted: false`, so sites that check it
need the future CDP driver; iframes and closed shadow roots are not reached yet.

## Data and scraping

- **Expressions** (`src/core/expression.ts`): tokenizer + Pratt parser + interpreter, whitelisted
  functions, own properties only. MV3 forbids `eval`/`new Function` in extension pages and workers, and
  a hand-rolled interpreter is safe on untrusted data. `template.ts` uses it for any `{{…}}` that is not
  a plain path; design-mode validation reports parse errors.
- **Scraping** goes through the page agent (`extract`, `table` ops). Results come back as
  `{columns, values}`: Chrome serialises `executeScript` results through `base::Value`, which sorts
  object keys, so objects are rebuilt in the block (`tableToObjects`) to keep column order.
- **HTML without a tab**: `Host.html.act` parses with `DOMParser` and runs the same agent on the parsed
  document (no layout, so geometry checks are skipped). Chrome's service worker has no DOM, so it opens
  an offscreen document (`src/entrypoints/offscreen`, reason `DOM_PARSER`) and messages it; Firefox's
  background page parses directly.
- **Loops** (For Each, Repeat, Paginate) call `ctx.emit(payload, 'each')` per item from inside `run`;
  `emit` awaits the whole downstream subtree, so iterations run one after another in the same run, then
  the block returns `routeTo('done', …)`.
- **Datasets** live in IndexedDB (`datasets` store, keyed by name); `unlimitedStorage` lifts the quota.
  **Downloads** use `downloads.download` with a `data:` URL in Chrome's worker (no `createObjectURL`
  there) or a `blob:` URL where available.

## Triggers and the recorder

- **Page Visited / Context Menu** have no timers: the background registers `webNavigation`
  (`onCompleted`, `onHistoryStateUpdated`) and `contextMenus.onClicked` listeners at the top level and,
  per event, finds the matching start blocks of enabled workflows and calls `runner.handleEvent(nodeId,
  payload)` with the tab put in `$session` as `main`. Context menu items are re-created from the enabled
  workflows on install, startup and every workflow change. Tabs BlockFlow opened (Open Tab, watch tabs)
  are listed in `storage.session` (`ownTabs.ts`) and never trigger Page Visited, so a workflow cannot
  start itself in a loop.
- **Schedule** computes the next local time in `src/core/schedule.ts` and sets a one-shot timer; each
  firing plans the next one first.
- **Recorder** (`src/dom/recorder.ts`, injected by `src/browser/recording.ts` after every page load of the
  recording tab) reports steps by message; the background appends them to `bf:recording` (and adds
  `navigated` steps from `tabs.onUpdated`). When it stops, the editor converts the steps with
  `src/core/recording.ts` and inserts the blocks. Locators come from `src/dom/bestLocator.ts`, shared
  with the picker and Detect fields.

## Watch Element

`Host.page.readElement({ url, selector, reload })` (see `src/browser/pageReader.ts`):

1. Reuse the background tab BlockFlow previously opened for that URL (or open one, inactive). It never
   reuses your own tabs, so it never reloads a page you are working in.
2. Reload it if `reload` is on, wait for load.
3. `scripting.executeScript` runs `readSelectorInPage(selector)` in the page. If the element is not there
   yet it retries for ~6 seconds, for single-page apps.

The block compares the whitespace-normalised text with the last value in `ctx.state`. The first read only
records a baseline. If the URL or selector changes, the baseline resets, so editing a workflow never
reports a fake change.

## Element picker

Same interaction as uBlock Origin's: hover highlights, click locks, then **Broader / Narrower** (↑ / ↓)
moves to the parent or back, Enter confirms, Esc cancels.

- `src/dom/selector.ts` builds the selector: stable id, else test attribute (`data-testid`...), else
  tag + stable classes; `:nth-of-type` only when siblings are ambiguous; ancestors are added until the
  selector matches exactly one element. Generated ids/classes (`css-1x2y3z`, `:r1:`) and state classes
  (`active`) are ignored.
- `src/dom/picker.ts` draws the overlay in a shadow root (page CSS can't touch it) and swallows the page's
  own click handlers while picking.
- `src/browser/picking.ts` opens the page (or uses your most recently used web tab), injects
  `content-scripts/picker.js`, and forwards the result to the editor.

## Testing strategy

- `npm run e2e` (`tests/e2e/run.mjs`) builds, loads `.output/chrome-mv3` into a Chromium-based browser with a
  throwaway profile (Brave, Chromium or Chrome; `BF_BROWSER` to choose), serves `tests/fixtures/site` (a
  classic login form, a single-page app with a controlled form, an overlay, a custom checkbox, a web
  component) and runs workflows through the real background worker.


- `tests/core`: engine and blocks through `tests/helpers/fakeHost.ts`. Timers are "fired" by calling
  `runner.handleTimer`, so no real time passes. There is a test that a brand-new runner continues a flow,
  which is exactly what happens after the worker sleeps.
- `tests/dom`: selector generation (including a property test: every element on a complex page gets a
  selector matching only itself) and the picker, in jsdom.
- `tests/editor`: pure conversion between saved workflows and canvas nodes.
- Not covered by automated tests yet: real browser APIs and React Flow interactions. See the README's
  "What has been verified" and use `docs/manual-test`.
