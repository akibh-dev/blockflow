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

- `tests/core`: engine and blocks through `tests/helpers/fakeHost.ts`. Timers are "fired" by calling
  `runner.handleTimer`, so no real time passes. There is a test that a brand-new runner continues a flow,
  which is exactly what happens after the worker sleeps.
- `tests/dom`: selector generation (including a property test: every element on a complex page gets a
  selector matching only itself) and the picker, in jsdom.
- `tests/editor`: pure conversion between saved workflows and canvas nodes.
- Not covered by automated tests yet: real browser APIs and React Flow interactions. See the README's
  "What has been verified" and use `docs/manual-test`.
