# Editor

The editor is the extension page (`editor.html`) where workflows are built: a React app around a React Flow
canvas. It only edits workflows in storage and asks the background worker to do things; it never runs the
engine itself. Read this page before changing how the editor loads, saves, converts or displays workflows.
For the individual components, see [Editor Components](Editor-Components.md).

**Source:** [index.html](../../src/entrypoints/editor/index.html),
[main.tsx](../../src/entrypoints/editor/main.tsx), [App.tsx](../../src/entrypoints/editor/App.tsx),
[Editor.tsx](../../src/entrypoints/editor/Editor.tsx), [hooks.ts](../../src/entrypoints/editor/hooks.ts),
[flow/convert.ts](../../src/entrypoints/editor/flow/convert.ts),
[registry.ts](../../src/entrypoints/editor/registry.ts),
[templates.ts](../../src/entrypoints/editor/templates.ts), [files.ts](../../src/entrypoints/editor/files.ts),
[style.css](../../src/entrypoints/editor/style.css)

## Where it sits

See the diagram in [ARCHITECTURE.md, One-paragraph version](../ARCHITECTURE.md#one-paragraph-version). In
short:

```text
 Editor ── saveWorkflows (bf:workflows) ──▶ storage ──▶ background: onChanged → diffWorkflows → start/stop
 Editor ◀── storage.onChanged (bf:logs, bf:runs, bf:prompts, bf:recording, bf:secrets) ── background
 Editor ── runtime.sendMessage (run, stop, pick, record, answer prompt) ──▶ background
 Editor ◀── runtime message (bf:pick-result / bf:pick-error) ── background
 Editor ── IndexedDB (screenshots, datasets) via src/browser/blobStore.ts
```

## Entry: index.html → main.tsx → App → Editor

| File | What it does |
| --- | --- |
| `index.html` | WXT turns the `editor/` folder into an unlisted page, `editor.html`. Just `<div id="root">` and the module script. The toolbar button opens it (`openEditor()` in `background.ts` focuses an existing editor tab instead of opening a second one). |
| `main.tsx` | Imports `@xyflow/react/dist/style.css` **before** `style.css` (ours overrides React Flow's), then `createRoot(...).render(<StrictMode><App/></StrictMode>)`. StrictMode runs effects twice in dev, so every effect cleans up (the `alive` flags in the hooks). |
| `App.tsx` | Wraps `Editor` in `ReactFlowProvider` so `Editor` can call `useReactFlow()` (it needs `screenToFlowPosition` for drops and paste), and renders [`DialogHost`](Editor-Components.md#dialogs) for toasts and dialogs. |
| `Editor.tsx` | Everything else: state, actions, layout. One component, ~780 lines, sectioned by `// --- name ---` comments. |

## Views (pages / navigation)

There is no router. `Editor` keeps `view: 'canvas' | 'manage' | 'reports' | 'data' | 'secrets'` in state;
the header tabs set it. The header, [Sidebar](Editor-Components.md#sidebar) and
[LogPanel](Editor-Components.md#logpanel) are always shown; the middle of the grid changes:

| `view` | Header tab | Middle of the page |
| --- | --- | --- |
| `canvas` | Canvas | `<ReactFlow>` + [ConfigPanel](Editor-Components.md#configpanel) |
| `manage` | All workflows (n) | [WorkflowsPage](Editor-Components.md#workflowspage) |
| `reports` | Reports | [ReportsPage](Editor-Components.md#reportspage) |
| `data` | Data | [DataPage](Editor-Components.md#datapage) |
| `secrets` | Secrets | [SecretsPage](Editor-Components.md#secretspage) |

Opening a workflow (sidebar, table, a run in Reports) switches back to `canvas`. Importing switches to
`manage`. The [PromptBanner](Editor-Components.md#promptbanner) is rendered above the grid on every view.

## State in `Editor`

| State | Type | Meaning |
| --- | --- | --- |
| `workflows` | `Workflow[] \| null` | The whole library. `null` until loaded (renders "Loading…"). Source of truth for saving. |
| `activeId` | `string \| null` | Workflow on the canvas. `active` is derived with `useMemo`. |
| `nodes`, `edges` | `BlockFlowNode[]`, `Edge[]` | React Flow's controlled state for the active workflow. |
| `view` | see above | Which page is shown. |
| `showAllLogs` | `boolean` | Log panel: all workflows or only the active one (also filters runs). |
| `inspectedRunId` | `string \| undefined` | Run shown on the canvas and in the step inspector. `undefined` = follow the newest run of the active workflow. |
| `logs`, `runs`, `prompts` | from hooks | Live views of `bf:logs`, `bf:runs`, `bf:prompts`. |
| `recording` | `RecordingState \| null` | `useStorageValue(bf:recording)`. |
| `secrets` | `Record<string,string>` | `useStorageValue(bf:secrets)`, only for `{{` suggestions. |

Refs (read inside stable callbacks without re-creating them): `latest` (= `workflows`), `activeIdRef`,
`nodesRef`, `histories` (undo stacks by workflow id), `mouse` / `lastPasteAt` (for paste at the mouse). A
module-level `clipboard` holds copied blocks, so they survive switching workflows (not page reloads).

### The edit loop

```text
 loadWorkflows() ──▶ workflows ──open(w)──▶ toFlow(w) ──▶ nodes / edges ──▶ <ReactFlow>
                          ▲                                        │ onNodesChange / onEdgesChange / onConnect
                          │                                        ▼   updateConfig / updateStep / addBlock ...
                          └──── setWorkflows(map) ◀── fromFlow(base, nodes, edges), unless sameGraph(base, next)
 workflows ──(400 ms debounce, and on pagehide)──▶ saveWorkflows()  ──▶  bf:workflows
```

- **Load once.** On mount, `loadWorkflows()`; if storage is empty a fresh `My first workflow` is created
  (and saved by the debounce). The editor does **not** subscribe to `bf:workflows` afterwards: it owns that
  key. Only the background's first-install seeding (`sampleWorkflows()`) writes it otherwise.
- **Canvas → workflow.** An effect on `[nodes, edges, activeId]` rebuilds the workflow with
  [`fromFlow`](#flowconvertts) and skips the update when `sameGraph` says nothing real changed (React Flow
  also reports selection and size measurements). So selecting a block never causes a save.
- **Save.** An effect on `workflows` saves after `SAVE_DELAY_MS = 400`; a `pagehide` listener flushes
  `latest.current` so closing the tab right after an edit does not lose it.
- **Switching workflow** calls `open(w)`: re-runs `toFlow` and resets `inspectedRunId`. The undo history of
  each workflow is kept (`open(w, true)`, used when another editor tab changed the open workflow, drops it).
  `<ReactFlow key={activeId}>` remounts so `fitView` applies to each workflow.
- Name changes and on/off go straight into `workflows` (they are not part of the graph).

### Undo / redo

`histories.current` is a `Map<workflowId, { past, future, lastAt, restoring }>` (`historyOf(id)` creates an
entry on first use). The canvas → workflow effect pushes the **previous** graph (`{nodes, edges}` of the
saved model) onto the active workflow's `past`, unless its last push was less than `HISTORY_MERGE_MS = 600`
ago (one drag = one step). At most `HISTORY_LIMIT = 100` steps. `undo`/`redo` move snapshots between the
stacks and call `showGraph`, which sets `restoring = true` so that change is not recorded again. Switching
workflows keeps every history (in memory only, not across reloads); deleting a workflow drops its entry.

### Keyboard shortcuts

A `window` keydown listener, only in the `canvas` view and ignored while typing in an input, textarea,
select or contenteditable, and while a dialog (`.bf-modal`) is open:

| Keys | Action |
| --- | --- |
| Ctrl/Cmd+Z | Undo |
| Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y | Redo |
| Ctrl/Cmd+C | Copy selected blocks and the edges between them |
| Ctrl/Cmd+V | Paste: new ids, selected. The top-left pasted block goes where the mouse is (`onMouseMove` on the canvas → `screenToFlowPosition`); with the mouse outside the canvas or not moved since the last paste, offset 40 px from the copied blocks instead (pasting again steps further) |
| Ctrl/Cmd+D | Duplicate selection (copy + paste with the 40 px offset) |
| Backspace / Delete | React Flow's own delete (`deleteKeyCode`) |

### Canvas details

| Thing | Where | Notes |
| --- | --- | --- |
| Node renderer | `nodeTypes = { block: BlockNode }` | Module-level constant so React Flow does not warn about a new object per render. |
| Edges | `defaultEdgeOptions`: `smoothstep`, closed arrow | Edges from a named port (`true`, `false`, `error`...) get a `label` and `className="port-<name>"` in `shownEdges` (display only, not stored). |
| Connect | `onConnect` | Ignores self-loops and duplicates (same source, target and handle). New edge id from `uid()`. |
| Add block | `addBlock(type, position?)` | Palette click: cascades at (120,100) + 36 px × (count mod 6). Drop: `screenToFlowPosition` of the cursor. Config starts as a copy of `def.defaultConfig`. |
| Step settings | `updateStep` | Drops values back at default (`''`, `false`, `0`, `'stop'`, `screenshot: 'error'`) so saved workflows stay small. Switching On error away from `port` also deletes edges leaving the `error` handle. |
| Validation | `validateWorkflow(active, registry)` | `issuesByNode` feeds `IssuesContext`; error count shows in the header, disables Run, and blocks turning a workflow on. `errorCounts` does this for every workflow (manage page). |
| Run status | `statusByNode` from the inspected run's steps | Feeds `RunStatusContext`, so blocks show ✓ ✕ ⏳. |
| Theme | `colorMode="system"` | Follows the OS like `style.css`. |

### `{{` suggestions

`suggestions` (passed to [ConfigPanel](Editor-Components.md#configpanel) →
[TemplateInput](Editor-Components.md#templateinput)) is the sorted union of:

1. `outputs[].key` of every block **upstream** of the selected one (breadth-first over incoming edges;
   keys starting with `(` are descriptive placeholders and skipped),
2. keys of the selected block's input in the inspected run (skipping `$session` and other `$` keys), plus up
   to 12 `key.inner` names for object values,
3. `secret.<name>` for every stored secret.

### Workflow actions

Implemented once in `Editor` and passed as a [`WorkflowActions`](Editor-Components.md#workflowactions)
object to both the Sidebar and WorkflowsPage. All work by id and read `latest.current`, so they are stable.

| Action | Implementation |
| --- | --- |
| `onCreate` | `createWorkflow(uniqueName('Workflow N'))`, open it. |
| `onCreateFromTemplate(text)` | `parseImport(text, existing)`; adds all workflows of the template, opens the **last** one. |
| `onToggle` | `setEnabledFor`: turning on is refused with an error toast (`whyNotOn`: `validateWorkflow` errors, or empty). Turning off always works. "Turn all on/off" (`setAllEnabled`) switches everything it can in one update and names the workflows left off in one toast. |
| `onDuplicate` | `duplicateWorkflow` (core/library: new ids, "… copy", off), open it. |
| `onExport(ids)` | `exportWorkflows` → `downloadText(fileNameFor(...))`. One file per click; exported workflows are always `enabled: false`. |
| `onExportPlaywright(id)` | `workflowToPlaywright(workflow, { registry, lookup })` → `<name>.spec.ts`. `lookup` resolves Run Workflow targets. |
| `onDelete` | `confirmDialog` (in-editor), then `deleteNow`. Deleting the last one leaves a new empty workflow; deleting the open one opens the first remaining. The background then clears its timers and `bf:state:<id>::*` ([Background Worker](Background-Worker.md)). |
| `onImport(files)` | `readFiles` → `parseImport` per file (ids/names made unique against everything, including earlier files of the same import), error toast on failure, then add, open the first, switch to `manage`. |

The core side of these (`parseImport`, `uniqueName`, the export format) is in
[Core Modules](Core-Modules.md).


## Talking to the background

The editor never imports the engine. Everything goes through storage or messages (types in
`src/shared/messages.ts`, see [Message Protocol](Message-Protocol.md)).

### Messages the editor sends

| Message | Sent by | When |
| --- | --- | --- |
| `bf:run-workflow { workflow }` | `Editor.runNow` | ▶ Run. Sends the **in-memory** `active` workflow, so unsaved edits run. Error toast if the worker cannot be reached. Clears `inspectedRunId` to follow the new run. |
| `bf:stop-run { runId }` | `Editor.stopRun` | ■ Stop, for the newest `running` run of the active workflow. |
| `bf:start-recording { workflowId, url }` | `Editor.startRecording` | ● Record, after a `promptDialog` for an `http(s)` URL (checked in the dialog; suggests the first Open URL block's URL if it has no template). |
| `bf:stop-recording` | header button | While `recording.status === 'recording'`. |
| `bf:start-pick { url?, mode }` | [ConfigPanel](Editor-Components.md#configpanel) | 🎯 Pick on page / Detect fields. |
| `bf:answer-prompt { runId, ok }` | [PromptBanner](Editor-Components.md#promptbanner) | Continue / Fail the run on a Manual Step. |

### Messages the editor receives

Only `bf:pick-result` and `bf:pick-error`, broadcast by `src/browser/picking.ts` with
`runtime.sendMessage` and handled by ConfigPanel. See [Picker and Recorder](Picker-and-Recorder.md).

### Storage the editor touches

Keys are in `src/shared/keys.ts`; see [Storage Keys](Storage-Keys.md).

| Key / store | Read | Write |
| --- | --- | --- |
| `bf:workflows` | once on load (`loadWorkflows`) | debounced `saveWorkflows`, plus `pagehide` flush |
| `bf:logs` | live (`useLogs`) | `clearLogs()` (Clear in the log panel) |
| `bf:runs` | live (`useRuns`) | `clearRuns()` (keeps runs still `running`) |
| `bf:prompts` | live (`usePrompts`) | never (answers go by message) |
| `bf:recording` | live (`useStorageValue`) | removed after a stopped recording is turned into blocks |
| `bf:secrets` | live (Editor for suggestions, SecretsPage) | SecretsPage |
| `bf:onboarding` | once ([TryItCard](Editor-Components.md#tryitcard)) | TryItCard, when closed |
| IndexedDB screenshots | `loadScreenshot` (Screenshot, ReportsPage HTML export) | never |
| IndexedDB datasets | `listDatasets` (DataPage, polled every 3 s) | `deleteDataset` |

### Recording → blocks

When `bf:recording` changes to `status: 'stopped'`, an effect in `Editor`:

1. drops the recording if its workflow no longer exists;
2. if that workflow is not open, opens it and returns (the effect runs again once it is on the canvas);
3. converts the steps with `recordingToBlocks` (core), adds them as new nodes/edges at x = 60, below the
   lowest existing block (or at y = 120 on an empty canvas), then removes `bf:recording`;
4. shows a toast if passwords were replaced by secrets that need creating on the Secrets page.

Because the new blocks go through the normal canvas → workflow → save loop, they are undoable and saved
like any edit. The recorder itself is described in [Picker and Recorder](Picker-and-Recorder.md).

## hooks.ts

Small hooks that mirror a `storage.local` key into state: load once, then follow `storage.onChanged`
(area `local` only), with an `alive` flag so a late load after unmount is ignored.

| Hook | Returns | Key |
| --- | --- | --- |
| `useLogs()` | `LogEntry[]` (oldest first, max 300) | `bf:logs` (via `loadLogs`) |
| `useRuns()` | `RunRecord[]` (newest last, max 40) | `bf:runs` (via `loadRuns`) |
| `useStorageValue<T>(key, fallback)` | `[value, save]` | any |
| `usePrompts()` | `PendingPrompt[]` | `bf:prompts` |

`useStorageValue` gotchas: `fallback` is deliberately not an effect dependency (pass a constant per call
site); a removed key resets to `fallback`; `save` sets state optimistically, then writes, and the write
echoes back through `onChanged` harmlessly. There is no merge: two pages saving the same key race, last
write wins.

## flow/convert.ts

Pure functions (no React) between the saved model (`Workflow`, `src/core/types.ts`) and React Flow's
shapes, unit-tested in `tests/editor/convert.test.ts`.

| Export | Purpose |
| --- | --- |
| `BlockNodeData` | `{ blockType, config, step? }`, the `data` of every canvas node. **Must stay a `type` alias**: React Flow requires `Record<string, unknown>`, which interfaces do not satisfy. |
| `FlowNode`, `FlowEdge` | Structural copies of React Flow's `Node`/`Edge` so this file need not import React Flow. `BlockFlowNode` (in BlockNode.tsx) is the real `Node<BlockNodeData, 'block'>`. |
| `toFlow(workflow, portOf?)` | Workflow → `{ nodes, edges }`. Copies everything; every node gets `type: 'block'`; edge `sourceHandle = portOf(edge)`. |
| `fromFlow(base, nodes, edges)` | Canvas → workflow, keeping `base`'s id, name, enabled, schemaVersion. Rounds positions; omits empty `step`; omits `sourcePort` when it is the default `out`. |
| `sameGraph(a, b)` | `JSON.stringify([nodes, edges])` equality. Key order matters, which is fine because both sides come from `fromFlow`. |

Invariant: `fromFlow(w, ...toFlow(w))` deep-equals `w`. Two things keep old workflows byte-stable: `out` is
never written as `sourcePort`, and positions are integers.

`portOf` matters for edges saved before blocks had several outputs: `Editor` passes `portOfEdge`, which
uses `edgePort(edge, nodePorts(def, node))` from `src/core/ports.ts` so a legacy edge attaches to the
block's **first** port (for If, `true`), not to a nonexistent `out` handle. The default `portOf`
(`sourcePort ?? 'out'`) is only safe when the edges already have ports (paste, recording).

## registry.ts

`export const registry = createDefaultRegistry()`: one block registry for the page, the same set the
background builds. Used by BlockNode (icon, label, summary, ports), Sidebar (palette), ConfigPanel (fields,
outputs, permissions), Editor (validation, suggestions, log labels, Playwright export), WorkflowsPage and
ReportsPage (labels). Adding a block to `src/core/blocks/index.ts` makes it appear everywhere with no editor
change; see [Adding a Block](Adding-a-Block.md) and [Block Internals](Block-Internals.md).

## templates.ts

"+ New → From a template" uses the guide's example files, so templates and documentation never drift:

```ts
import.meta.glob('../../../docs/guide/examples/*.blockflow.json', { eager: true, import: 'default' })
```

Vite bundles them at build time. Each becomes a `Template { id, name, text, workflows }`: `id` is the file
name, `name` is the **last** workflow's name (a file may hold a reusable sub-workflow plus the one that
calls it), `text` is the JSON for `parseImport`. Sorted by name. `tests/core/guideExamples.test.ts` checks
every example imports cleanly. Adding a template = adding an example to `docs/guide/examples`.

## files.ts

| Function | What it does |
| --- | --- |
| `downloadText(filename, text, type = 'application/json')` | Blob → object URL → synthetic `<a download>` click; revokes the URL after 1 s. Used for workflow export, Playwright specs, reports (HTML/JUnit/JSON) and datasets (CSV/JSON). |
| `fileNameFor(name)` | Slug + `.blockflow.json` (`workflow.blockflow.json` if the slug is empty). Callers `.replace('.blockflow.json', ...)` for other extensions. |
| `readFiles(files)` | `FileList \| null` → texts, via `File.text()`. |

The import format itself (`format`, `version`, `workflows`) is defined and validated in
`src/core/library.ts`.

## Styling

All CSS is in `style.css`, plain CSS with a `bf-` class prefix (no CSS modules, no framework).

- **Tokens** on `:root`: `--bg`, `--panel`, `--border`, `--text`, `--muted`, `--primary`, `--danger`,
  `--ok`, redefined under `@media (prefers-color-scheme: dark)`. React Flow follows with
  `colorMode="system"`.
- **Layout**: `.bf-app` is a CSS grid, areas `header` / `sidebar canvas config` / `logs`, columns
  `250px 1fr 340px` (`200px 1fr 260px` under 1000 px), rows `48px 1fr 190px`. The manage-style pages
  (`.bf-manage`) span the canvas and config areas.
- **Blocks**: `.bf-node` with modifiers `selected`, `has-problem`, `disabled`, `multi-port`,
  `run-<status>`; the block's colour arrives as the `--accent` custom property set inline by BlockNode.
- **Ports**: `.port-true`, `.port-false`, `.port-error` colour handles, labels and (for `error`) edges,
  overriding React Flow's `.react-flow__handle` / `.react-flow__edge` classes.
- Run statuses share `.bf-run-status <status>` and `.bf-run-badge <status>` across header, log panel and
  reports.

## Gotchas

- **One editor tab at a time.** The editor loads `bf:workflows` once and overwrites it on every save. Two
  editor tabs would clobber each other's edits. The toolbar button reuses an existing editor tab, which
  avoids this in practice.
- **Alerts and prompts.** `window.alert`, `confirm` and `prompt` are used for notices, delete confirmation
  and the recording URL. Fine in an extension page; replace them if the editor ever moves into an iframe.
- **Run uses the canvas, triggers use storage.** ▶ Run sends the in-memory workflow; background triggers
  use what was saved (at most 400 ms later).
- **Don't put derived display data in `nodes`/`edges`.** Anything added there is written back by
  `fromFlow`. Edge labels are added in `shownEdges` for that reason, and run status and issues travel via
  context.
- **Callbacks read refs.** Most actions read `latest.current` / `activeIdRef.current` rather than closing
  over state, so they can be `useCallback(..., [])`. Keep that pattern when adding actions.

## See also

- [Editor Components](Editor-Components.md): every component in `components/`
- [Message Protocol](Message-Protocol.md), [Storage Keys](Storage-Keys.md)
- [Background Worker](Background-Worker.md): the other side of the messages and storage
- [Picker and Recorder](Picker-and-Recorder.md)
- [Core Modules](Core-Modules.md): `library`, `validate`, `ports`, `recording`, `playwright`, `report`
- [Testing](Testing.md): `tests/editor/convert.test.ts`
- [ARCHITECTURE.md](../ARCHITECTURE.md)
