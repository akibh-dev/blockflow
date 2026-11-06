# Block Internals

How the 42 built-in blocks in `src/core/blocks/` are put together: the definition contract as the engine
actually calls it, what a block can reach through `ctx`, how its settings become editor widgets, the shared
helpers, and a per-block implementation table. Read this before changing a block or writing a new one
(then follow [Adding a Block](Adding-a-Block.md)). For what each block does from the user's side, see the
generated [block reference](../guide/blocks.md).

**Source:** [index.ts](../../src/core/blocks/index.ts), [pageCommon.ts](../../src/core/blocks/pageCommon.ts),
[dataCommon.ts](../../src/core/blocks/dataCommon.ts), every other file in [src/core/blocks/](../../src/core/blocks/),
plus the contract in [types.ts](../../src/core/types.ts) (`BlockDefinition`, `BlockContext`, `FieldSpec`) and
[config.ts](../../src/core/config.ts) (defaults, templating, validation).

## The definition contract

A block is one exported constant of type `BlockDefinition<C>` (`src/core/types.ts`), where `C` is the block's
own config interface (`TimerConfig`, `ClickConfig`…). Blocks are plain objects: no classes, no registration
side effects. The registry erases `C` (`AnyBlockDefinition`).

| Member | Required | Used by | Notes |
| --- | --- | --- | --- |
| `type` | yes | engine, saved workflows | The id stored in `NodeDef.type`. **Never rename**: saved workflows reference it (Open Tab is still `open-url`). Must be unique, `BlockRegistry.register` throws otherwise. |
| `label`, `description`, `icon` | yes | editor palette and config panel, guide | `description` and field labels/help are copied into `docs/guide/blocks.*` by `scripts/guide.ts`. |
| `accent` | yes | editor | Colour of the block. `PAGE_ACCENT` / `DATA_ACCENT` for page and data blocks. |
| `category` | no | palette | Do **not** set it in the block: `createDefaultRegistry()` stamps it from `BLOCK_GROUPS` in `index.ts`. |
| `defaultConfig: C` | yes | `withDefaults()` | Merged under the saved config (`{...defaultConfig, ...raw}`) on every resolve, so new keys get a value in old workflows. |
| `fields: FieldSpec[]` | yes | editor, validation, templating, guide | One entry per editable key. Order = order in the config panel. See [Settings and the editor](#settings-fields-and-the-editor). |
| `outputs: OutputSpec[]` | yes | editor ("Data this block passes on"), guide | Documentation only; the engine never checks it. Use `(same data)` for pass-through blocks. |
| `summary?(config)` | no | `BlockNode.tsx` | One line on the canvas. Receives the saved config with defaults applied, **not** template-rendered. |
| `ports?: string[]` | no | engine, editor handles, validation | Named outputs; default `['out']`. The engine appends `error` when `step.onError === 'port'` (`nodePorts()` in `ports.ts`). |
| `timeoutSeconds?` | no | `stepTimeoutSeconds()` | Default step timeout for this block type; the engine default is 60 (`DEFAULT_TIMEOUT_SECONDS`). A node's `step.timeoutSeconds` overrides it. |
| `permissions?` | no | `PermissionNote.tsx` | Optional browser permissions (`'debugger'`, `'userScripts'`) the editor offers to grant. |
| `validate?(config)` | no | `check.ts` (import), `validate.ts` (editor) | Rules over several settings that `required` cannot express. Receives the config with defaults applied (not rendered) and returns `ConfigProblem[]` (`{ key, code, message }`, code usually `config.required`, or `config.value` / `config.url.invalid`). Import reports each at `.../config/<key>` and refuses the file; the editor shows the message on the block. Must not throw. In: Assert (element subjects need `locator`, `attribute` needs `name`), Wait For (element modes → `locator`, text modes → `text`, `url`/`response` → `url`), Upload File (`url` or `content` by `source`), Download (`dataset` or `value` by `from`), Read Element (`name` for attribute/has-class), Navigate (`url` for goto, valid when not templated), Schedule (`at` is HH:MM for `day`), Extract List / Extract Table (`html` in HTML mode, `validateSource`). |
| `legacyKeys?` | no | `check.ts` | Config keys that are no longer settings but that `run` still reads from old workflows (Open Tab: `newTab`), so import does not call them unknown (`config.key.unknown`). Renamed keys go in `RENAMED_KEYS` (migrate.ts) instead. |
| `start?(ctx)` | no | root blocks when a workflow is switched on | Schedule yourself here (timers), or just log (event-driven triggers). |
| `trigger?(ctx)` | no | Run button / Run Workflow on a root | What a start block sends "right now". Return `null` to send nothing. |
| `run?(ctx, input)` | no | every step | The normal path. Returns `RunOutput`. |
| `onTimer?(ctx, name, data)` | no | `handleTimer()` | Called when a timer this node set fires. |

### When the engine calls what

| Situation | Entry point (`engine.ts`) | Block method called |
| --- | --- | --- |
| Workflow switched on, edited, browser start-up | `runner.start()` → `startRoot()` per root | `start(ctx)` if defined; **otherwise** `run(ctx, {})` once, as a new run with trigger `start` |
| ▶ Run button | `runOnce()` → `runRoots(run, {})` | `trigger(ctx)` (its result merged over the input) if defined, else `run(ctx, {})` |
| Called by Run Workflow | `runAsCall(input)` → `runRoots(run, input)` | as above, with the caller's payload as input |
| Upstream block sent data | `emitFrom()` → `runStep()` | `run(ctx, input)`; a block without `run` is skipped with a warning |
| A timer fired | `handleTimer(key)` | `onTimer(ctx, name, data)` (config resolved against `{}`) |
| Page Visited / context menu event | `handleEvent(nodeId, payload)` | `run(ctx, payload)` in a new run (trigger `event`) |

`start` and `onTimer` run **outside any run**: `ctx.runId` is `''`, `ctx.timeoutMs` is the 60 s default,
`softFail` only logs, `callWorkflow` throws, and `ctx.emit()` opens a *new* run whose first step is the
block's own firing. `start`/`onTimer` errors are caught and logged (`guard()`), never retried. Step
settings (timeout, retries, onError, disabled, screenshots) apply only to `run`/`trigger` calls. Background
on why runs start this way: [ARCHITECTURE: Engine model](../ARCHITECTURE.md#engine-model-srccoreenginets).

### What `run` returns

| Return | Effect |
| --- | --- |
| a `Payload` | Sent out of the block's first port (usually `out`). Each connected block gets a shallow copy. |
| `routeTo(port, payload)` (`ports.ts`) | Sent out of `port`. A port not in `nodePorts()` fails the step: `sent data to an output it does not have`. |
| `null` / `undefined` | The path ends here; the step is still `passed` (Stop "pass", HTTP Request with `failOnError`, Read Element "not found", Timer delay). |
| throw | The step failed; the engine retries (`step.retries`) and then applies `step.onError`. Throw `Error`s with a message the user can act on. |
| `ctx.softFail(msg)` then return | Step and run marked failed, but the output still flows (soft Assert). |

Pass-through blocks return `input` (or `{ ...input, extra }`): later blocks need everything upstream put in
the payload, including `$session`.

## The context (`BlockContext<C>`)

| Field | What it is | Notes |
| --- | --- | --- |
| `config: C` | Settings: defaults applied, `templated` fields rendered against the input (plus `secret.*`), validated | Validation errors stop the step before `run` is called, so `run` may trust required fields and selects. |
| `host: Host` | Everything outside the engine (tabs, page agent, HTTP, datasets…) | The only way out of `src/core`. See [Core Engine](Core-Engine.md) and [Browser Host](Browser-Host.md). |
| `emit(payload, port?)` | Send now, possibly several times | Inside a run it **awaits the whole downstream subtree** (loops rely on this). From `start`/`onTimer` it starts a new run. |
| `timers.set(name, {delayMs, periodMs?}, data?)` / `clear(name)` | Durable timers via `Host.scheduler` | Key is `bf::<workflowId>::<nodeId>::<name>` (`timerKey.ts`). `data` is stored, so it must be JSON. `runner.start()` and `stop()` clear every timer of the workflow. See [Scheduling and Timers](Scheduling-and-Timers.md). |
| `state.get(key)` / `state.set(key, value)` | Per-node key/value store via `Host.state` | Stored under `<workflowId>::<nodeId>::<key>` (`stateKey()`); survives worker restarts and is **not** cleared when the workflow restarts. JSON values only. |
| `log(level, message)` | Run log line for this node | Secrets are masked by the engine. |
| `softFail(message)` | Soft failure (see above) | |
| `callWorkflow(id, input)` | Child run, resolves with its last output | Only inside a run; nesting limit `MAX_CALL_DEPTH` (8). |
| `timeoutMs` | This step's timeout in ms | Page blocks wait a little less (`pageWaitMs`). |
| `realInput` | `step.realInput` | `inPage()` forwards it to `Host.page.act`. |
| `isRoot` | Nothing feeds this node | Available, but no built-in block reads it: they distinguish root vs. inline by *which method* is called. |
| `workflowId`, `workflowName`, `nodeId`, `runId` | Identity | `runId` is `''` outside a run. |

Rules that follow from the MV3 worker sleeping (from [CLAUDE.md](../../CLAUDE.md)): never use
`setTimeout`/`setInterval` for workflow timing (use `ctx.timers` + `onTimer`, or `ctx.host.sleep` for short
waits inside one step), and keep anything you must remember in `ctx.state`, never in module variables. The
one module-level variable in the blocks, Watch Element's `inFlight` set, is only an overlap guard that may
safely be lost.

## Settings: fields and the editor

`fields` drives four things at once: the config panel (`ConfigPanel.tsx`), validation (`config.ts`),
template rendering (`resolveConfig()`), and the generated guide/JSON schema (`scripts/guide.ts`). There is
no per-block editor code.

| `kind` | Editor widget | Run-time handling |
| --- | --- | --- |
| `text` | `<input>`; `<textarea>` when `multiline`; `TemplateInput` (with `{{…}}` suggestions) when `templated` | Rendered if `templated`; `required` = non-blank |
| `url` | same as text | Rendered if `templated`; must be http(s) (in design mode a value containing `{{` is accepted) |
| `selector` / `locator` | text input + **🎯 Pick on page** button | `pickerUrlKey` names a config key the picker also fills with the page URL; `pickPrefers: 'stable'` asks for a structural CSS selector instead of a readable locator |
| `number` | `<input type=number>` with `min`/`max`/`step` | Numeric strings are coerced by `withDefaults()`; `min`/`max` enforced |
| `boolean` | checkbox | must be a boolean |
| `select` | `<select>` of `options` | value must be one of `options[].value` |
| `rows` | table of `columns`, + Add row, ✕; a 🎯 button per `locator: true` column; **🎯 Detect fields** when `detectForm` | Each cell rendered if its column is `templated`; `required` = at least one non-empty row; every non-empty row needs its first column |
| `workflow` | `<select>` of saved workflows | stores the workflow id |

Validation runs twice: in **design** mode while editing (`validateWorkflow()` in `validate.ts`, which also
reports `{{ }}` syntax errors in templated fields) and in **run** mode just before each step.

Keep the strings user-facing and unchanged unless you mean to change the docs: labels, help, option labels
and `description` all land in `docs/guide/blocks.md`, and `npm run guide:check` fails until you run
`npm run guide:sync`.

## Shared helpers

### `pageCommon.ts`

| Export | Signature / value | Purpose |
| --- | --- | --- |
| `PAGE_ACCENT` | `'#7c3aed'` | Accent of page blocks. |
| `PAGE_TIMEOUT_SECONDS` | `30` | Default `timeoutSeconds` for page actions (Playwright's default too). |
| `tabField` | `TextField` (`key: 'tab'`, not templated) | The "Tab" setting. Empty = `main`. Wait for Popup spreads it with another label. |
| `locatorField(key = 'locator', label = 'Element', required = true)` | `TextField` | Templated `kind: 'locator'` field with the standard placeholder/help. Spread and override `help`/`placeholder` per block. |
| `pageWaitMs(ctx)` | `Math.max(1000, ctx.timeoutMs - 500)` | The wait passed to the host: slightly under the step timeout, so the page's own reason ("waiting for #x to be visible") wins over the engine's generic timeout. |
| `WithTab` | `{ tab: string }` | Config constraint of `inPage`. |
| `inPage(ctx, input, request)` | `Promise<{ tabId, result }>` | `requireSessionTab(input, config.tab)` then `host.page.act(tabId, request, pageWaitMs(ctx), realInput ? {realInput: true} : undefined)`. Throws "No tab named … Put an Open Tab block…" when the tab is missing. |

Blocks that need a tab but not the agent (Dialogs, Run Script, Wait For URL/load/response, Navigate, Wait
for Popup, Assert url/title) call `requireSessionTab` from `src/core/session.ts` directly. Tabs live in
the payload under `$session.tabs`; see [Core Engine](Core-Engine.md) and
[ARCHITECTURE: Page blocks](../ARCHITECTURE.md#page-blocks-and-the-page-agent).

### `dataCommon.ts`

| Export | Signature | Purpose |
| --- | --- | --- |
| `DATA_ACCENT` | `'#0d9488'` | Accent of data and loop blocks. |
| `listField(key = 'list', label = 'List', placeholder = 'items')` | `TextField` | A required, **non-templated** field holding an expression (`items`, `data.results`). |
| `valueAt(expression, input, label = 'List')` | `unknown` | `evaluate()` from `expression.ts`; errors are prefixed with `label`. |
| `listAt(expression, input, label = 'List')` | `unknown[]` | `valueAt` that insists on an array ("is not in the data" / "is not a list"). |

Expression fields (`listField`, Transform's `expression` column, Save to Dataset's and Download's `value`)
are deliberately not `templated`: they are evaluated by the block and keep their types (a list stays a
list), whereas templates always produce strings. See [Core Modules](Core-Modules.md).

### Helpers exported from block files

| Export | File | Used by |
| --- | --- | --- |
| `SourceConfig`, `sourceFields`, `inSource(ctx, input, request)` | `extractList.ts` | Extract List, Extract Table: run an agent op on a tab (`host.page.act`) or on HTML in the data (`host.html.act`). No `realInput`. |
| `tableToObjects(result)` | `extractList.ts` | Rebuilds `{columns, values}` into objects in column order (Chrome sorts object keys in `executeScript` results; see [ARCHITECTURE: Data and scraping](../ARCHITECTURE.md#data-and-scraping)). |
| `WAIT_UNTIL_OPTIONS` | `openUrl.ts` | "Continue when" options of Open Tab, Navigate, Wait for Popup. |
| `currentTabPayload(ctx)` | `pageVisited.ts` | `trigger` of Page Visited and Context Menu: the active web tab becomes `main`. |
| `textToBase64(text)` | `uploadFile.ts` | UTF-8 safe base64 for Upload File's text source. |

### `index.ts`

`BLOCK_GROUPS` lists every block by palette category, in palette order; `createDefaultRegistry()` registers
each with `category` set. Every block constant is also re-exported by name. The same registry is built by
the background worker, the editor (`src/entrypoints/editor/registry.ts`), `scripts/guide.ts` and the test
harness (`tests/helpers/fakeHost.ts`), so registering a block in `BLOCK_GROUPS` is all it takes to make it
appear everywhere.

## All blocks

Ports are `out` unless listed; every block also gets `error` when `step.onError` is `port`. "Timeout" is the
block's default step timeout (60 = engine default). Page ops are the `AgentRequest` ops it sends (see
[Page Protocol](Page-Protocol.md)); other host calls are `Host` methods.

### Start (`category: 'start'`)

| Block (`type`) | File | Methods | Host / page ops | Timers · state | Timeout | Implementation notes |
| --- | --- | --- | --- | --- | --- | --- |
| Start (`start`) | [manualStart.ts](../../src/core/blocks/manualStart.ts) | run | none | none | 60 | Returns `{...startingValues, ...input}`, so a Run Workflow caller's values win. Has no `start`, so (like any plain root) it also runs once when the workflow is switched on. |
| Timer (`timer`) | [timer.ts](../../src/core/blocks/timer.ts) | start, trigger, run, onTimer | `host.now` | `tick` (periodic if `repeat`), `delay:<uid>` one-shot carrying the payload · `count` | 60 | Root: `start` resets `count` and sets `tick`. Inline: `run` sets a delay timer and returns `null`; `onTimer` emits `{...data, firedAt}`. Because `onTimer` has no run, everything after a delay continues in a **new run** (trigger `timer`). |
| Schedule (`schedule`) | [scheduleBlock.ts](../../src/core/blocks/scheduleBlock.ts) | start, trigger, onTimer | `host.now` | `next` one-shot carrying `scheduledFor` | 60 | `nextOccurrence()` from `schedule.ts`; plans the next timer *before* emitting so a failing run does not stop the schedule. No `run`: cannot take input. |
| Page Visited (`page-visited`) | [pageVisited.ts](../../src/core/blocks/pageVisited.ts) | start (log only), trigger, run | `tabs.current` | none | 60 | The trigger lives in the background worker (`webNavigation` listeners call `handleEvent` with `$session.tabs.main`); `run` passes the event payload through. See [Background Worker](Background-Worker.md). |
| Context Menu (`context-menu`) | [contextMenu.ts](../../src/core/blocks/contextMenu.ts) | start (log only), trigger, run | `tabs.current` | none | 60 | Same pattern; menu items are created by the background from `title`/`contexts`. |
| Watch Element (`watch-element`) | [watchElement.ts](../../src/core/blocks/watchElement.ts) | start, trigger, run, onTimer | `page.readElement` (background tab per URL, not `page.act`) | `poll` (periodic) · `last` = `{signature, value}` | 60 | Schedules `poll` before the first check so a failing check does not stop it. First read is a baseline unless `emitOnFirstRead`; signature `url|locator` change = start over. Module-level `inFlight` set skips overlapping checks. `locator` is not templated (Read Element's is). |

### Tabs (`browser`)

| Block (`type`) | File | Methods | Host / page ops | Timers · state | Timeout | Implementation notes |
| --- | --- | --- | --- | --- | --- | --- |
| Open Tab (`open-url`) | [openUrl.ts](../../src/core/blocks/openUrl.ts) | run | `tabs.open` | state `tabId` (for `where: 'workflow'`) | 45 | Adds `url`, `tabId` and `$session.tabs[tab]` (`withSessionTab`). Legacy `newTab: false` with `where: 'new'` means `current`. Load wait is `timeoutMs - 500`. |
| Navigate (`navigate`) | [navigate.ts](../../src/core/blocks/navigate.ts) | run | `tabs.navigate` | none | 45 | URL validated only for `goto`. Adds `url`. |
| Wait for Popup (`wait-for-popup`) | [waitForPopup.ts](../../src/core/blocks/waitForPopup.ts) | run | `tabs.waitForPopup` (look-back 15 s), `tabs.waitForLoad`, `tabs.info` | none | 30 | Look-back catches a popup opened by the Click just before. Names the new tab in `$session`. |
| Close Tab (`close-tab`) | [closeTab.ts](../../src/core/blocks/closeTab.ts) | run | `tabs.close` | none | 60 | Uses `sessionTab` (not `require…`): a missing tab is only a warning. Removes the name from `$session`. |

### Page actions (`page`)

| Block (`type`) | File | Page ops / host | Timeout | Implementation notes |
| --- | --- | --- | --- | --- |
| Click (`click`) | [click.ts](../../src/core/blocks/click.ts) | `click` | 30 | Logs "the page navigated" when the driver answers `navigated`. Pass-through. |
| Fill (`fill`) | [fill.ts](../../src/core/blocks/fill.ts) | `fill` | 30 | Pass-through. |
| Fill Form (`fill-form`) | [fillForm.ts](../../src/core/blocks/fillForm.ts) | `set-field` per row, then `click` | 30 | Rows with empty locator or value are skipped; a row's error is prefixed with its locator. All rows share one step timeout, but each `inPage` call gets the full `pageWaitMs`. |
| Select Option (`select-option`) | [selectOption.ts](../../src/core/blocks/selectOption.ts) | `select` | 30 | `value` split on `|`. Adds `selected`. |
| Check (`check`) | [check.ts](../../src/core/blocks/check.ts) | `check` | 30 | No-op when already in the wanted state (`result.changed`). |
| Press Key (`press-key`) | [pressKey.ts](../../src/core/blocks/pressKey.ts) | `press` | 30 | `locator` omitted from the request when blank. |
| Upload File (`upload-file`) | [uploadFile.ts](../../src/core/blocks/uploadFile.ts) | `upload`; `http.download` for URLs | 30 | Text source encoded with `textToBase64`. Adds `uploaded`. |
| Scroll (`scroll`) | [scroll.ts](../../src/core/blocks/scroll.ts) | `scroll`; `host.sleep` | 120 | `to: 'end'` is block-only: repeats `scroll bottom` until `result.height` is unchanged twice or `maxScrolls`. Adds `scrolls`. |
| Dialogs (`dialogs`) | [dialogs.ts](../../src/core/blocks/dialogs.ts) | `page.dialogs` (not the agent) | 15 | Installs handlers in the page's MAIN world; lasts until the page navigates. Adds `dialogs`, `lastDialog`. |
| Wait For (`wait-for`) | [waitFor.ts](../../src/core/blocks/waitFor.ts) | `wait`; `tabs.waitForUrl`, `tabs.waitForResponse` (look-back 10 s), `tabs.waitForLoad`, `tabs.info` | 30 | `WaitMode` = agent `WaitState` + `url`/`load`/`networkidle`/`response` (host-side). Adds `url` (or `response`). |
| Run Script (`run-script`) | [runScript.ts](../../src/core/blocks/runScript.ts) | `page.runScript` | 30 | `permissions: ['userScripts']`. Code is not templated; it receives the input as `data`. Result stored under `into`. |

### Read & scrape (`read`)

| Block (`type`) | File | Page ops / host | Timers · state | Timeout | Implementation notes |
| --- | --- | --- | --- | --- | --- |
| Read Element (`read-element`) | [readElement.ts](../../src/core/blocks/readElement.ts) | URL set: `page.readElement`; else `read` op via `page.act` (wait ≤ 5 s) + `tabs.info` | state `last` = `{signature, value}` | 60 | Tab mode treats a "Timed out" error as not found. Not found → logs a warning and returns `null` (path ends). Signature `url|locator|read|name`; adds `value`, `previous`, `changed`, `count`, `url`, `locator` (and `selector`, the same value under its pre-v0.3 name). |
| Extract List (`extract-list`) | [extractList.ts](../../src/core/blocks/extractList.ts) | `extract` via `inSource` | none | 30 | Fields with blank names dropped; `limit` sent only when > 0. Adds `[into]` and `count`. |
| Extract Table (`extract-table`) | [extractTable.ts](../../src/core/blocks/extractTable.ts) | `table` via `inSource` | none | 30 | Adds `[into]` and `count`. |
| Paginate (`paginate`) · ports `each`, `done` | [paginate.ts](../../src/core/blocks/paginate.ts) | `read` (kind `enabled`), `click` (`next >> nth=0`); `host.sleep(150)`, `tabs.waitForLoad('networkidle')` | none | 1800 | Emits `each` with `page`, then stops when Next is missing/disabled (`enabled` answers `false` for a missing element instead of waiting) or at `maxPages`. Returns `routeTo('done', {pages})`. |
| Page Info (`page-info`) | [pageInfo.ts](../../src/core/blocks/pageInfo.ts) | `page-info` or `storage` | none | 30 | Adds `page` or `value`. |
| Page Snapshot (`page-snapshot`) | [pageSnapshot.ts](../../src/core/blocks/pageSnapshot.ts) | `snapshot` (with `locator` when set, `maxLines` at least 10) | none | 30 | Adds `snapshot` (the outline text) and `elements`; logs a warning when the outline was cut. Playwright export: `ariaSnapshot()` of the body or the locator. The editor's 📸 Snapshot page button on Open Tab uses the same op, not this block. |

### Test (`test`)

| Block (`type`) | File | Host / page ops | Timeout | Implementation notes |
| --- | --- | --- | --- | --- |
| Assert (`assert`) | [assert.ts](../../src/core/blocks/assert.ts) | `read` via `page.act` (300 ms each), `tabs.info`, `host.sleep(250)` | 10 | Page subjects retry a number of *attempts* computed from `pageWaitMs` (no wall clock). Yes/no subjects (`STATES`) compare with a fixed answer; others use `testClause` from `condition.ts`. A failure is a `CodedError('assert.failed')` with the element's locator (page subjects); `soft` passes it to `ctx.softFail`. Adds `actual`. |
| Manual Step (`manual-step`) | [manualStep.ts](../../src/core/blocks/manualStep.ts) | `prompt.ask` | 600 | `false` from the user throws. Pass-through. |
| Stop (`stop`) | [stopRun.ts](../../src/core/blocks/stopRun.ts) | none | 60 | `fail` throws `message`; `pass` logs and returns `null`. `outputs: []`. |

### Logic & loops (`logic`)

| Block (`type`) | File | Ports | Timeout | Implementation notes |
| --- | --- | --- | --- | --- |
| If (`if`) | [ifBlock.ts](../../src/core/blocks/ifBlock.ts) | `true`, `false` | 60 | `testClause(config)`; returns `routeTo(...)` with the input unchanged. |
| For Each (`for-each`) | [forEach.ts](../../src/core/blocks/forEach.ts) | `each`, `done` | 3600 | `listAt(list)`; awaits `emit({...input, [as]: item, index, total}, 'each')` per item, then `routeTo('done', {...input, count})`. The step timeout covers **all** iterations; every downstream step counts toward the 1000-step budget. |
| Repeat (`repeat`) | [repeat.ts](../../src/core/blocks/repeat.ts) | `each`, `done` | 3600 | Same pattern with `iteration` from 1; `done` gets the unchanged input. |
| Run Workflow (`run-workflow`) | [runWorkflow.ts](../../src/core/blocks/runWorkflow.ts) | `out` | 300 | `ctx.callWorkflow(workflow, input)`; the child's last output becomes this block's output. The `workflow` field kind renders a workflow picker. |

### Data (`data`)

| Block (`type`) | File | Host | Implementation notes |
| --- | --- | --- | --- |
| Set Variable (`set-variable`) | [setVariable.ts](../../src/core/blocks/setVariable.ts) | none | Value is templated, so always a string (use Transform for typed values). |
| Transform (`transform`) | [transform.ts](../../src/core/blocks/transform.ts) | none | Rows evaluated top to bottom with `valueAt`; each sees the ones above. |
| Filter (`filter`) | [filter.ts](../../src/core/blocks/filter.ts) | none | `left`/`right` are rendered by the block per item with `{...input, item}` (not `templated` fields, so the engine leaves them alone and no `secret.*` is in scope). Result key must be a simple name. Adds `count`. |
| Data Table (`data-table`) | [dataTable.ts](../../src/core/blocks/dataTable.ts) | none | JSON if the text starts with `[`/`{`, else `csvToObjects`. |
| Save to Dataset (`save-dataset`) | [saveDataset.ts](../../src/core/blocks/saveDataset.ts) | `datasets.write` | A list adds one row per item; anything else one row. Adds `datasetSize`. |
| Download (`download`) | [download.ts](../../src/core/blocks/download.ts) | `datasets.read`, `downloads.save` | CSV via `toCsv`, JSON pretty-printed, text as is. Adds `file`. |

All data blocks use the 60 s default timeout and `out`.

### Send & log (`output`)

| Block (`type`) | File | Host | Implementation notes |
| --- | --- | --- | --- |
| Notify (`notify`) | [notify.ts](../../src/core/blocks/notify.ts) | `notify` | Adds `notified: true`. |
| HTTP Request (`http-request`) | [httpRequest.ts](../../src/core/blocks/httpRequest.ts) | `http.fetch` | Headers parsed from `Name: value` lines; body sent for every method but GET when non-empty. Non-2xx with `failOnError` returns `null` (the path ends, the step passes). Adds `url`, `status`, `ok`, `body`, and `data` when the body parses as JSON. |
| Log (`log`) | [log.ts](../../src/core/blocks/log.ts) | none | Pass-through. |

## Gotchas

- **Renaming is breaking.** `type`, config keys and select option values are stored in users' workflows
  and exports. Add a new key with a default instead, and read old shapes in `run` (see Open Tab's
  `newTab`, listed in its `legacyKeys` so import accepts it), or rename through `RENAMED_KEYS` in
  migrate.ts.
- **Import rejects unknown config keys** (`config.key.unknown`). A key a block reads but does not declare
  as a field must be in `legacyKeys`, or files using it will be refused.
- **Rules between settings belong in `validate`**, not only in `run`: then import and the editor report
  them before the run, with a path. Keep the `run` check too (it guards templated values).
- **`defaultConfig` is merged shallowly.** A saved `rows` value replaces the default list entirely.
- **Templated output is a string.** `{{count}}` renders to `"3"`. Compare numbers with If/Assert (which
  coerce) or compute with Transform.
- **Timer data and state must be JSON.** They go to `storage.local`.
- **`ctx.emit` from a loop is sequential** and holds the loop step open; a long downstream chain needs the
  loop block's timeout to be long (For Each/Repeat use 3600 s, Paginate 1800 s).
- **A Timer delay splits the run.** Data after it arrives in a new run (trigger `timer`), so a ▶ Run or a
  Run Workflow call ends at the Timer.
- **`summary()` sees raw templates** (`{{url}}`), and must not throw on missing values: use `?? ''` and
  `|| 'placeholder'` as the existing blocks do.

## See also

- [Adding a Block](Adding-a-Block.md): step-by-step guide and checklist
- [Core Engine](Core-Engine.md): runner, runs, ports, `Host`
- [Page Protocol](Page-Protocol.md): every `AgentRequest` op and its answer
- [Page Agent](Page-Agent.md): how ops are carried out in the page
- [Scheduling and Timers](Scheduling-and-Timers.md): what happens behind `ctx.timers`
- [Editor Components](Editor-Components.md): `ConfigPanel`, `BlockNode`
- [Testing](Testing.md): `FakeHost` and the `harness()`
- [Block reference](../guide/blocks.md) (generated, user-facing)
- [ARCHITECTURE.md](../ARCHITECTURE.md)
