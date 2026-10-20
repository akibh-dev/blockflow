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
 "Pick on page" ──message──▶ picking.ts ──inject──▶ picker (content script) ──message──▶ editor
```

## Engine model (`src/core/engine.ts`)

- Blocks are nodes, connections are edges. A block's **output payload** is passed to every connected block
  as its **input payload**. Each branch gets its own copy.
- A block with nothing connected to its input is a **root**. `start()` calls `def.start(ctx)` on each
  root, or `def.run(ctx, {})` once if the block has no `start`.
- A non-root block's `run(ctx, input)` is called when an upstream block emits. Returning a payload
  continues the flow; returning `null` ends it. Blocks that emit later (timers, watchers) call
  `ctx.emit(payload)` from `start` or `onTimer`.
- Settings marked `templated` are rendered against the input payload (`{{url}}`) right before the block
  runs, then validated. A failing block logs an error and stops **its** branch only.
- A flow stops after 25 blocks in a row (`DEFAULT_MAX_DEPTH`), so accidental loops end.

This is why any block can feed any other: a block only ever sees "a payload came in" or "I was started",
never which block sent it.

## Surviving the background worker sleeping

Chrome stops the MV3 service worker after about 30 seconds idle, so nothing important lives in memory:

- **Timers** go through `Scheduler` (backed by `browser.alarms`). The alarm name is a key
  `bf::<workflowId>::<nodeId>::<timerName>`. When an alarm fires, `background.ts` builds a **fresh**
  `WorkflowRunner` and calls `handleTimer(key)`, which finds the block and calls its `onTimer`.
  Data a timer carries (the payload a delay-Timer is holding) is stored next to the alarm.
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
