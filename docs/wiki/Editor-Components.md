# Editor Components

Reference for every React component in the editor's `components/` folder: what it shows, its props and
state, and which messages, storage keys or browser APIs it touches. Read [Editor](Editor.md) first for how
`Editor.tsx` owns the state these components receive.

**Source:** [BlockNode.tsx](../../src/entrypoints/editor/components/BlockNode.tsx),
[ConfigPanel.tsx](../../src/entrypoints/editor/components/ConfigPanel.tsx),
[TemplateInput.tsx](../../src/entrypoints/editor/components/TemplateInput.tsx),
[PermissionNote.tsx](../../src/entrypoints/editor/components/PermissionNote.tsx),
[Screenshot.tsx](../../src/entrypoints/editor/components/Screenshot.tsx),
[LogPanel.tsx](../../src/entrypoints/editor/components/LogPanel.tsx),
[Sidebar.tsx](../../src/entrypoints/editor/components/Sidebar.tsx),
[NewMenu.tsx](../../src/entrypoints/editor/components/NewMenu.tsx),
[ImportButton.tsx](../../src/entrypoints/editor/components/ImportButton.tsx),
[WorkflowActions.ts](../../src/entrypoints/editor/components/WorkflowActions.ts),
[WorkflowsPage.tsx](../../src/entrypoints/editor/components/WorkflowsPage.tsx),
[ReportsPage.tsx](../../src/entrypoints/editor/components/ReportsPage.tsx),
[DataPage.tsx](../../src/entrypoints/editor/components/DataPage.tsx),
[SecretsPage.tsx](../../src/entrypoints/editor/components/SecretsPage.tsx),
[PromptBanner.tsx](../../src/entrypoints/editor/components/PromptBanner.tsx),
[Dialogs.tsx](../../src/entrypoints/editor/components/Dialogs.tsx),
[TryItCard.tsx](../../src/entrypoints/editor/components/TryItCard.tsx)

## At a glance

| Component | Where it appears | Side effects |
| --- | --- | --- |
| [BlockNode](#blocknode) | every block on the canvas | none (reads two contexts) |
| [ConfigPanel](#configpanel) | right column, canvas view | sends `bf:start-pick`, listens for `bf:pick-result` / `bf:pick-error` |
| [SnapshotButton](#snapshotbutton) | ConfigPanel, Open Tab only | sends `bf:snapshot-page`, listens for `bf:snapshot-result`, writes the clipboard |
| [TemplateInput](#templateinput) | templated text settings | none |
| [PermissionNote](#permissionnote) | ConfigPanel, blocks with `permissions` | `permissions.contains` / `request` |
| [Screenshot](#screenshot) | step inspector, reports | IndexedDB read |
| [LogPanel](#logpanel) | bottom row, always | none (callbacks) |
| [Sidebar](#sidebar) | left column, always | none (callbacks) |
| [NewMenu](#newmenu) | sidebar, All workflows | none |
| [ImportButton](#importbutton) | sidebar, All workflows | file picker |
| [WorkflowsPage](#workflowspage) | `manage` view | none (callbacks) |
| [ReportsPage](#reportspage) | `reports` view | IndexedDB read, downloads |
| [DataPage](#datapage) | `data` view | IndexedDB read/delete (polls), downloads |
| [SecretsPage](#secretspage) | `secrets` view | reads/writes `bf:secrets` |
| [PromptBanner](#promptbanner) | top of the page, all views | sends `bf:answer-prompt` |
| [Dialogs](#dialogs) (`DialogHost`) | toasts bottom right, modal dialogs; rendered once by `App` | none |
| [TryItCard](#tryitcard) | top right of the canvas, first run | reads/writes `bf:onboarding`, `fetch` of the playground, `tabs.create` |

Shared conventions: components are function components with props interfaces declared in the same file;
everything that changes workflows goes back to `Editor` through callbacks (no component writes
`bf:workflows`); messages, confirmations and questions use [Dialogs](#dialogs) (`toast`,
`confirmDialog`, `promptDialog`), never `window.alert/confirm/prompt`; block metadata comes from the
shared [`registry`](Editor.md#registryts).

## BlockNode

How one block looks on the canvas. Registered in `Editor` as `nodeTypes = { block: BlockNode }`.

**Exports**

| Export | Kind | Purpose |
| --- | --- | --- |
| `BlockNode` | component | Receives React Flow's `NodeProps<BlockFlowNode>` (`id`, `data`, `selected`). |
| `BlockFlowNode` | type | `Node<BlockNodeData, 'block'>`, the node type used in `Editor`'s state. |
| `IssuesContext` | context | `Map<nodeId, string[]>` of validation messages. Provided by `Editor`. |
| `RunStatusContext` | context | `Map<nodeId, StepStatus>` for the inspected run. Provided by `Editor`. |

**What it renders**

- Header: `def.icon`, `def.label` (falls back to `?` / the raw type for unknown blocks), a run badge
  (`⏳ ✓ ✕ ↪ ⤼` for running / passed / failed / handled / skipped) and a `!` badge when it has problems
  (the problems are the node's `title` tooltip).
- `def.summary(config)` with `defaultConfig` merged in, the step note, and "Disabled: passes data through".
- Handles: one target on the left. On the right, one source handle per port from
  `nodePorts(def, { config, step })` in `src/core/ports.ts` (so a Switch shows one per case plus `default`);
  the handle `id` is the port name, which becomes the edge's `sourceHandle`. When the port list changes
  it calls React Flow's `updateNodeInternals(id)` so new handles can be connected. With a single `out` port it draws one plain handle; otherwise labelled handles
  spread evenly down the right side and the node gets a `minHeight` of `22 + 20 × ports`.
- CSS classes: `bf-node` + `selected`, `has-problem`, `disabled`, `run-<status>`, `multi-port`; the block's
  colour arrives as `--accent`.

**Why contexts:** issues and run status are not stored in node `data`, because `data` is written back to
the workflow by `fromFlow` (see [Editor, gotchas](Editor.md#gotchas)).

## ConfigPanel

The right column on the canvas view: settings of the selected block, generated from its `fields`
(`FieldSpec[]` in `src/core/types.ts`), so a new block needs no editor code.

**Props (`ConfigPanelProps`)**

| Prop | Type | Meaning |
| --- | --- | --- |
| `node` | `BlockFlowNode \| undefined` | Selected node (first with `selected`). Undefined shows "Select a block…". |
| `problems` | `string[]` | Validation messages for this node. |
| `onChange(nodeId, patch)` | callback | Shallow-merges into `data.config` (`Editor.updateConfig`; for blocks with dynamic ports it also moves or removes the connections of renamed / removed outputs via `followPortChanges`). |
| `onStepChange(nodeId, patch)` | callback | Merges into `data.step` (`Editor.updateStep`). |
| `onDelete(nodeId)` | callback | Removes the node and its edges. |
| `lastStep` | `StepRecord \| undefined` | This node's last step in the inspected run. |
| `workflows` | `{ id, name }[]` | Other workflows, for `workflow` fields (Run Workflow). |
| `suggestions` | `string[]` | Names for `{{` completion (see [Editor, suggestions](Editor.md#-suggestions)). |

**State:** `pick` (`idle | waiting | done | error`, message text, the field it belongs to, and alternative
locator `candidates`); refs `pending` (the current `PickTarget`) and `configRef` (latest merged config, read
by the message listener). Pick status resets whenever the selected node changes.

**Layout, top to bottom:** title and description; [PermissionNote](#permissionnote) if `def.permissions`;
problems list; one control per field; [StepResult](#internal-pieces) if the block ran; StepSettingsEditor;
"Data this block passes on" (`def.outputs`); Delete block. Unknown block types get only an error and a
Delete button.

**Field kind → control**

| `field.kind` | Control |
| --- | --- |
| `boolean` | checkbox |
| `number` | number input (`min`/`max`/`step`); empty stores `''` |
| `select` | `<select>` of `options` |
| `workflow` | `<select>` of the other workflows |
| `rows` | `RowsInput` table |
| text kinds (`text`, `selector`, `locator`, …) | [TemplateInput](#templateinput) when `templated`, else `<textarea>` (`multiline`) or text input |
| `selector`, `locator` | additionally a 🎯 **Pick on page** button |

Values shown are `{ ...def.defaultConfig, ...node.data.config }`; only what the user changes is written.

**Element picking (messages).** `startPick(target, config)` stores the target in `pending` and sends
`bf:start-pick { url?, urlFrom?, mode }`:

- `url` is the value of `field.pickerUrlKey` (e.g. Watch Element's page URL) when set and not templated
  (`urlFrom: 'block'`), else the `upstreamUrl` prop: the URL of the nearest Open Tab before the block,
  computed by the editor (`urlFrom: 'upstream'`). Without either the background reuses the editor's picker
  tab or the most recent web tab (see [Browser Host: picking.ts](Browser-Host.md#pickingts)).
- `mode` is `'form'` for **Detect fields**, `'watch'` for fields with `pickPrefers: 'stable'`, otherwise
  `'action'` (it picks the hint on the page).

A `runtime.onMessage` listener applies the answer to the pending target only (so another editor tab's pick
is ignored):

| Target | On `bf:pick-result` |
| --- | --- |
| `field` | Sets the field to the first readable candidate (`role=`, `text=`…) unless `field.pickPrefers === 'stable'`, then the CSS selector. Also writes the page URL into `pickerUrlKey`. Offers all candidates plus the selector as one-click alternatives. |
| `cell` (a locator column of a rows field) | Sets that cell to `candidates[0] ?? selector`. |
| `form` | Replaces the rows with the form's `fields`, keeping values already typed for locators still present, and copying `hint`. |

`bf:pick-error` shows the message; a failed `sendMessage` shows "Could not reach the background worker".
The other side is in [Picker and Recorder](Picker-and-Recorder.md) and
[Message Protocol](Message-Protocol.md).

Open Tab blocks also get [SnapshotButton](#snapshotbutton) below their settings.

### Internal pieces

| Function | Purpose |
| --- | --- |
| `RowsInput` | Table editor for `rows` fields (Fill Form, Extract List, Manual Start, Transform). Cells are TemplateInputs (suggestions only for `column.templated`), or a `<select>` for a column with `options` (Switch's Condition; a new row starts with the first option, an unknown stored value stays shown), 🎯 per `column.locator` cell, `+ Add row`, ✕ remove, and **Detect fields** when `field.detectForm`. A row's `hint` becomes the value placeholder. Rows are keyed by index. |
| `FieldInput` | The scalar control table above. |
| `StepSettingsEditor` | "Step settings" `<details>`, open when anything is set. On error (`stop`/`continue`/`port`), Retries (0..`MAX_RETRIES`), Timeout (placeholder = `def.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS`), Screenshot (`error`/`always`/`never`), **Use real mouse and keyboard** (only for blocks with `realInput: true` in their definition, or when already set; asks for the `debugger` permission first; stays off if refused), Disabled, Note. Semantics: [ARCHITECTURE.md, Engine model](../ARCHITECTURE.md#engine-model-srccoreenginets). |
| `StepResult` | "Last run" `<details>`: status, duration, attempts, chosen port, error, `ErrorDetails`, [Screenshot](#screenshot), input and output as JSON. |
| `ErrorDetails` (exported) | A failed step's error `code` as a small badge (`.bf-error-code`) and, for `locator.strict`, the `matches` list. Also used by ReportsPage. |
| `formatMs(ms)` (exported) | `850 ms`, `2.5 s`, `12 s`. Also used by LogPanel and ReportsPage. |

## SnapshotButton

**📸 Snapshot page** on Open Tab ([SnapshotButton.tsx](../../src/entrypoints/editor/components/SnapshotButton.tsx)).

**Props:** `url` (the block's URL setting; not sent when it has `{{…}}`).

Sends `bf:snapshot-page` and waits (button disabled, "Taking snapshot…") for `bf:snapshot-result`, which
only the waiting component acts on. On success it writes `text` with `navigator.clipboard.writeText` and
toasts "Page snapshot copied (N lines)"; an error or a refused clipboard is an error toast. The background
side is `snapshotForEditor` in [Browser Host: picking.ts](Browser-Host.md#pickingts).

## TemplateInput

A text input or textarea that offers data names after `{{`, IDE style.

| Prop | Type | Meaning |
| --- | --- | --- |
| `value`, `onChange(value)` | `string` | Controlled value. |
| `suggestions` | `string[]` | Candidate names (`url`, `item.title`, `secret.apiKey`). |
| `placeholder`, `ariaLabel`, `title` | `string?` | Passed through. |
| `multiline` | `boolean?` | `<textarea rows=4>` instead of `<input>`. |

**State:** `menu: { items, start, active } | null`.

- `look(text, caret)` opens the menu when the caret is after an unclosed `{{` and what is typed since is a
  name (`[\w.$-]`); items are suggestions that start with it (case-insensitive), max 8, excluding an exact
  match.
- `insert(item)` replaces the typed part with `item}}` (swallowing an existing `}}` right after the caret)
  and puts the caret after it on the next frame.
- Keys while open: ↑/↓ move, Enter/Tab insert, Esc closes. Blur closes after 150 ms so a click on an item
  still lands (items also `preventDefault` on mousedown).

## PermissionNote

**Exports:** `PermissionNote({ permissions })` and `requestPermission(permission)`.

- `permissions`: `('debugger' | 'userScripts')[]` from the block definition.
- On mount, checks each with `browser.permissions.contains` and lists the missing ones with a reason and a
  **Grant** button.
- `requestPermission` calls `browser.permissions.request`. It must run inside a click handler (browsers only
  show the prompt on a user gesture). If the browser throws (Firefox/Safari lack these permissions) it
  shows an error toast and returns `false`.

`userScripts` also needs the user to switch on "Allow User Scripts" in `chrome://extensions`, which the
note says. Which builds declare these as optional is in `wxt.config.ts`; see
[Build and Release](Build-and-Release.md).

## Screenshot

`Screenshot({ id, alt? })`: loads a screenshot by id from IndexedDB (`loadScreenshot` in
`src/browser/blobStore.ts`) and shows it as a thumbnail link that opens full size in a new tab.
State `src`: `undefined` (loading), `null` (gone: only the newest 150 are kept), or the data URL. See
[Browser Host](Browser-Host.md) for the blob store.

## LogPanel

The bottom row, with two tabs.

| Prop | Meaning |
| --- | --- |
| `entries` | Log lines already filtered by `Editor` (active workflow, or all). |
| `labelFor(entry)` | Label for a line: block label, plus the workflow name in "all" mode. |
| `showAll`, `onToggleAll(next)` | The "all workflows" checkbox; filters both tabs. |
| `onClear()` | Clear on the log tab (`clearLogs`). |
| `runs` | Runs to list (already filtered). |
| `inspectedRunId`, `onInspect(runId)` | Highlight / choose the run shown on the canvas. Choosing a run of another workflow opens that workflow. |
| `onClearRuns()` | Clear on the runs tab (`clearRuns`, keeps running runs). |
| `workflowName(id)` | Name for a run's workflow in "all" mode. |

**State:** `tab` (`log | runs`). The log tab scrolls to the end when lines are added. The runs tab lists
newest first with status, start time, trigger (`TRIGGER_LABELS`: `manual` "Run button", `start` "turned
on", `timer` "schedule", `event` "page event", `call` "called by another workflow"), step count
(including `droppedSteps`), duration and error.

## Sidebar

The left column: workflows on top, block palette below.

**Props:** everything in [`WorkflowActions`](#workflowactions), plus `workflows`, `activeId`, and
`onAddBlock(type)`.

**State:** `query` (workflow search, shown once there are more than 4), `renaming` (id being renamed),
`blockQuery` (palette filter).

| Part | Behaviour |
| --- | --- |
| Workflow row | Dot toggles on/off; name opens; double click or ✎ renames inline (Enter/blur saves a non-empty name, Esc cancels); ⧉ duplicate; ⬇ export; 🎭 Playwright; 🗑 delete. |
| Header | [NewMenu](#newmenu) and [ImportButton](#importbutton). |
| Palette | `registry.list()` grouped by `CATEGORY_LABELS` order, empty groups hidden. Filter matches label, description and type. Groups `start`, `browser` and `page` start open; all open while filtering. |
| Adding blocks | Click calls `onAddBlock(type)`. Drag sets `DRAG_MIME` (`application/x-blockflow-block`) to the block type; `Editor.onDrop` reads it. |

**Export:** `DRAG_MIME`.

## NewMenu

`NewMenu({ onBlank, onTemplate, plain? })`: a "+ New ▾" button with a small menu: **Blank workflow** and one
item per [template](Editor.md#templatests) (with "· N workflows" when a file holds several). Closes on a
mousedown outside. `plain` drops the link styling (used on the All workflows bar). State: `open`.

## ImportButton

`ImportButton({ onFiles, className? })`: an "Import" button that clicks a hidden
`<input type="file" accept=".json,application/json" multiple>`. Calls `onFiles(FileList)` and clears the
input so picking the same file again still fires `change`.

## WorkflowActions

`WorkflowActions.ts` is an interface, not a component: the operations the Sidebar and WorkflowsPage offer
(`onOpen`, `onCreate`, `onCreateFromTemplate`, `onRename`, `onToggle`, `onDuplicate`, `onExport`,
`onExportPlaywright`, `onDelete`, `onImport`). `Editor` builds one object and spreads it into both, so the
two lists can never behave differently. What each does is in
[Editor, workflow actions](Editor.md#workflow-actions).

## WorkflowsPage

The "All workflows" view: a file-manager table.

**Props:** [`WorkflowActions`](#workflowactions) plus `workflows`, `activeId`, `runs` (`bf:runs`),
`errorCounts` (`Map<id, number>` of validation errors) and `onSetAll(enabled)`.

**State:** `query` (name filter), `picked` (`Set` of selected ids).

- Bar: search, + New, Import, **Export selected (n)** or **Export all**, Turn all on / off.
- Columns: select, on/off switch, name (+ "n problems"), block icons (tooltip: block and connection counts),
  **Last activity** (end time, or start time while running, of the workflow's latest run in `runs`, with
  its status; "never" without runs), and Edit / Duplicate / Export / Playwright / Delete.
- The switch of a workflow with problems is disabled while it is off, with the tooltip "Fix the problems
  first" (like the header switch); it can always be switched off. Its `aria-label` is "<name> on".

## ReportsPage

Test-report view over the stored runs.

**Props:** `runs` (all of `bf:runs`), `onShowOnCanvas(run)` (opens the workflow and inspects that run),
`onClear()`.

**State:** `workflow` and `status` filters, `openId` (run shown in the detail pane).

- Filters: workflow (from the runs themselves, so deleted workflows still appear) and result: Passed,
  Failed, Cancelled, Interrupted, Running (each matches that status only).
- The trigger is shown with `TRIGGER_LABELS` (`src/core/runs.ts`): Run button, turned on, schedule, page
  event, called by another workflow.
- Totals line from `summarize(shown)` (`src/core/report.ts`).
- Detail: steps with status, block label, duration, attempts, port taken, error, error code
  (`ErrorDetails` from ConfigPanel), [Screenshot](#screenshot), and **open called run** for Run Workflow
  steps (`childRunId`).
- Exports (of the filtered runs) through `downloadText`: **JSON** (`toJsonReport`: versioned, see
  `docs/guide/report.schema.json`), **JUnit XML** (`toJUnitXml`) and
  **HTML** (`toHtmlReport`, with screenshots loaded from IndexedDB and inlined as data URLs, so the file
  stands alone). Report formats are documented in [Core Modules](Core-Modules.md).

## DataPage

Browser for datasets written by Save to Dataset blocks (IndexedDB, `src/browser/blobStore.ts`).

**State:** `datasets` (`null` while loading), `open` (selected dataset name).

- `refresh()` calls `listDatasets()` (sorted by `updatedAt`, newest first) on mount, **every 3 s** while
  the page is open (runs keep adding rows), and on the Refresh button.
- Detail: preview of the first 50 rows (`PREVIEW_ROWS`); columns are the union of object keys in those
  rows, or a single "value" column for non-object rows. Objects in cells are shown as JSON.
- Download CSV (`toCsv` from `src/core/csv.ts`) or JSON; Delete (`deleteDataset`, after `confirmDialog`).

## SecretsPage

Editor for named secrets in `bf:secrets` (`Record<string, string>`), through
`useStorageValue` ([hooks](Editor.md#hooksts)).

**State:** `name`, `value` (the new-secret row), `shown` (names whose value is visible).

- Names must match `/^[A-Za-z_][A-Za-z0-9_]*$/` (so `{{secret.name}}` parses). Adding an existing name
  overwrites it.
- Existing values are edited in place; every keystroke saves the whole map.
- Delete asks for confirmation in a `confirmDialog` (workflows using it will fail).
- Values are plain text in `storage.local`; the page says so. Masking in logs and reports is done by the
  engine (see [ARCHITECTURE.md, Engine model](../ARCHITECTURE.md#engine-model-srccoreenginets)), and
  secrets are never part of a workflow export because they are never in a workflow.

## PromptBanner

`PromptBanner({ prompts })`: rendered above the app grid whenever Manual Steps are waiting
(`usePrompts()` → `bf:prompts`). One row per prompt: workflow name, message, **Continue** and
**Fail the run**, each sending `bf:answer-prompt { runId, ok }`. The background also shows a notification
with the same buttons; whichever is answered first wins, and the prompt disappears from storage. See
[Background Worker](Background-Worker.md).

## Dialogs

`Dialogs.tsx` replaces the browser's `alert` / `confirm` / `prompt`, which block the page (React, storage
listeners) and cannot be driven by the e2e tests. Plain functions over a module-level store, so any code can
call them (no context needed); `<DialogHost />` in `App.tsx` renders them.

| Export | Does |
| --- | --- |
| `toast(message, kind = 'info', action?)` | A note in the bottom right corner (`.bf-toast`, `role="status"`), newlines kept. `info` 5 s, `success` 4 s, `error` 9 s (twice as long with an action), or the × button. At most 5 at a time. `action: { label, run }` adds a button (`.bf-toast-action`) that closes the toast and calls `run`, e.g. **Details** after an import with warnings. |
| `confirmDialog({ title?, message, confirmLabel?, danger? })` | Modal (`.bf-modal`, `role="dialog"`); resolves `true` on the confirm button or Enter, `false` on Cancel, Escape or a click on the backdrop. `danger` makes the button red. |
| `promptDialog({ title?, message, defaultValue?, placeholder?, confirmLabel?, validate? })` | Modal with one input (focused and selected); resolves the trimmed text, or `null` on cancel. `validate(value)` returns an error shown under the input (the dialog stays open) or `null`. |
| `issuesDialog({ title?, message, issues })` | Wide modal (`.bf-modal-wide`) listing `Issue`s from [check.ts](../../src/core/check.ts) (`.bf-issues`, one `.bf-issue.<level>` row each: level, `.bf-issue-code`, `.bf-issue-path` (the JSON Pointer), message, `.bf-issue-hint`). Buttons: **Copy** (the list as text via `issuesText`, for pasting into an AI chat) and **Close** (also Enter, Escape, backdrop). Resolves when closed. Used by import and "New from template". |
| `issuesText(issues)` | One line per issue: `<level> <code> at <path>: <message> <hint>`. |

Several dialogs queue: the oldest is shown. While one is open the canvas shortcuts are ignored.

## TryItCard

`TryItCard({ onCreate })`, first-run onboarding on the canvas (top right).

- Loads `bf:onboarding` (`OnboardingState`) once; renders nothing while loading or once `tryItDismissed`
  is set (the × button sets it).
- Step 1 tells the user to run `npm run playground` (serves `docs/manual-test` at
  `http://localhost:7357`, [scripts/playground.mjs](../../scripts/playground.mjs)) and shows whether
  `PLAYGROUND_URL` answers (`fetch`, which an extension page may do for any host it has permission for);
  **Check again** / **Open it**.
- Step 2, **Create the Try-it workflow**: `onCreate(template.text)` with the `playground-tour` template
  (Editor's `onCreateFromTemplate`), which opens it on the canvas.
- Why the playground is not an extension page: Chromium refuses to script `chrome-extension://` pages,
  the extension's own included, so blocks could not click or fill there.

## See also

- [Editor](Editor.md): state, data flow, conversion, styling
- [Message Protocol](Message-Protocol.md) and [Storage Keys](Storage-Keys.md)
- [Picker and Recorder](Picker-and-Recorder.md): the other end of Pick on page
- [Block Internals](Block-Internals.md): `fields`, `outputs`, `ports`, `permissions` that drive these components
- [Adding a Block](Adding-a-Block.md)
