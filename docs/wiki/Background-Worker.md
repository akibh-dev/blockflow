# Background Worker

The background entrypoint is the only place workflows run. It wires the engine to the real browser
`Host`, registers every browser event listener, and turns those events (alarms, storage changes, messages,
navigations, menu clicks) into calls on a fresh `WorkflowRunner`. Read this page before changing what
starts a run, adding a listener, or debugging "my workflow did not fire".

**Source:** [background.ts](../../src/entrypoints/background.ts),
[offscreen/index.html](../../src/entrypoints/offscreen/index.html),
[offscreen/main.ts](../../src/entrypoints/offscreen/main.ts)

The design reasons (why nothing lives in memory, why `start()` is not re-run on wake-up) are in
[Architecture: Surviving the background worker sleeping](../ARCHITECTURE.md#surviving-the-background-worker-sleeping).

## Runtime shape per browser

| Browser | Background kind (generated manifest) | Consequences |
| --- | --- | --- |
| Chrome / Edge / Brave | MV3 `service_worker` | No DOM (`DOMParser`, `URL.createObjectURL` missing), stopped after ~30 s idle. HTML parsing goes to the [offscreen document](#the-offscreen-document). |
| Firefox | MV3 `background.scripts` (event page) | Has a DOM; no `offscreen` permission requested (`wxt.config.ts`). Can still be suspended when idle. |
| Safari | MV3 build from `npm run build:safari` | Never run end to end (README "What has been verified"). Treat behaviour as unknown. |

## Start-up, in order

Everything in `defineBackground(() => { … })` runs on **every** worker start (browser start, install,
and every wake-up after Chrome stopped the worker), not just once.

| Step | Code | Why |
| --- | --- | --- |
| 1 | `createBrowserScheduler(key => onAlarm(key))` | Real [HybridScheduler](Scheduling-and-Timers.md); short timers firing from memory go down the same path as alarms. |
| 2 | `createExtensionHost(scheduler)` | The real `Host` ([Browser Host](Browser-Host.md)). |
| 3 | `createDefaultRegistry()` | All built-in blocks. |
| 4 | `liveRuns`, `cancelRequests` | In-memory: runs going on in *this* worker, and run ids the user asked to stop. |
| 5 | `updateRuns(markInterrupted(…))` | Any run still `running` in `bf:runs` that this worker does not own can never finish: mark it `interrupted`. |
| 6 | `clearStalePrompts()` | Manual Steps listed in `bf:prompts` by a dead worker can no longer be answered. |
| 7 | Register all listeners (below), synchronously | MV3 rule: listeners added later miss the event that woke the worker. |
| 8 | `scheduler.restoreAll()` (between the alarm and onStartup listeners) | Recreate alarms the browser dropped, re-arm short in-memory timers. |

> Step 5 runs with `liveRuns` empty. That is safe because `updateRuns` and `saveRun` share one write queue in
> `stores.ts`: the mark-interrupted write is queued before the event that woke the worker can save its
> first run, so a brand-new run is never marked interrupted.

## The runner factory

```ts
const newRunner = (workflow: Workflow) => new WorkflowRunner({
  workflow, registry, host,
  log: (entry) => void appendLog(entry),   // bf:logs
  onRun,                                    // liveRuns bookkeeping + saveRun → bf:runs
  isCancelled: (runId) => cancelRequests.has(runId),
});
```

A new runner is built for every event. Runners hold nothing that must survive between events; see
[Core Engine](Core-Engine.md) for `start`, `runOnce`, `handleTimer`, `handleEvent`.

`onRun(run)` is called on every run update: a `running` run is added to `liveRuns`; any other status removes it
from `liveRuns` and `cancelRequests`. Then `saveRun(run)` coalesces it into `bf:runs`
([Storage Keys](Storage-Keys.md)).

## Internal helpers

| Function | What it does | Called from |
| --- | --- | --- |
| `startWorkflow(id)` | Loads workflows; if `id` is enabled, `newRunner(wf).start()` (which first clears that workflow's timers). | `storage.onChanged` |
| `stopWorkflow(id)` | `scheduler.clearPrefix(workflowTimerPrefix(id))`, then adds every live **non-manual** run of that workflow to `cancelRequests`. Runs started with the Run button keep going. | `storage.onChanged` |
| `startAllEnabled()` | `start()` on every enabled workflow. | `onStartup`, `onInstalled` |
| `onAlarm(name)` | `parseTimerKey(name)`; ignores keys that are not ours; clears the timer if its workflow is gone or disabled; else `newRunner(wf).handleTimer(name)`. | alarm listener, and the scheduler's `fire` for short timers |
| `eventRoots(type)` | Every node of `type` with no incoming edge, in every enabled workflow. | Page Visited, Context Menu |
| `onPageVisited(tabId, url, kind)` | Skips non-http(s) URLs and tabs in `ownTabs`. For each `page-visited` root whose `config.url` pattern matches (`urlMatches`; `kind: 'route'` only if `config.when === 'any'`), runs `handleEvent(nodeId, withSessionTab({url, title, tabId}, 'main', tabId))`. | `webNavigation.onCompleted`, `onHistoryStateUpdated` |
| `syncContextMenus()` | Serialised through `menuSync`: `contextMenus.removeAll()`, then one item per `context-menu` root of an enabled workflow. Id `bf-menu::<workflowId>::<nodeId>`, title `config.title` or the workflow name, contexts `config.contexts` (`all`/`page`/`selection`/`link`/`image`). | `onStartup`, `onInstalled`, workflow changes that start or stop something |
| `onMenuClicked(id, info, tabId)` | Parses the item id, runs `handleEvent(nodeId, {url, selection, link, src, tabId})`, with `$session.tabs.main` set when there is a tab. | `contextMenus.onClicked` |
| `openEditor()` | Focuses an existing `editor.html` tab (and its window) or opens one. | `action.onClicked` |
| `report(what)` | `console.error('[BlockFlow] <what> failed', error)`. Every listener's promise ends in it. | everywhere |

## Listeners

All registered synchronously at the top level of `defineBackground`.

| Event | Handler | Notes |
| --- | --- | --- |
| `alarms.onAlarm` | `scheduler.handleAlarm(name)`; if that returns true (only a short timer's heartbeat) stop, else `onAlarm(name)` | See [Scheduling and Timers](Scheduling-and-Timers.md). |
| `runtime.onStartup` | `startAllEnabled()`, `syncContextMenus()` | Browser start (profile load). Not fired on a plain worker wake-up. |
| `runtime.onInstalled` | On `reason === 'install'` with no workflows: `saveWorkflows(sampleWorkflows())`. Then `migrateStoredWorkflows()` (rewrites `bf:workflows` once when a workflow has an older `schemaVersion`, see [Core Modules: migrate](Core-Modules.md#migrate)), `startAllEnabled()`, `syncContextMenus()` | Also fires on extension update and on reload in developer mode. |
| `webNavigation.onCompleted` | `onPageVisited(tabId, url, 'load')`, top frame only (`frameId === 0`) | Page Visited trigger. |
| `webNavigation.onHistoryStateUpdated` | `onPageVisited(tabId, url, 'route')`, top frame only | SPA route changes; only for `when: any`. |
| `webNavigation.onCreatedNavigationTarget` | `recordPopup(tabId, sourceTabId)`, `onRecordedPopup(tabId, sourceTabId, url)` | For Wait for Popup, and so the recorder follows popups. Not `tabs.onCreated`: its `openerTabId` is empty for popup windows and names the active tab for links opened from a background tab. |
| `tabs.onUpdated` | `onRecordedTabUpdated(tabId, change)` when `change.url` or `status === 'complete'` | Recorder: adds `navigated` steps and re-injects the recorder after a load. |
| `contextMenus.onClicked` | `onMenuClicked(...)` | Context Menu trigger. |
| `storage.onChanged` (area `local`, key `bf:workflows`) | `diffWorkflows(migrated old, migrated new)` (so the one-time schema rewrite restarts nothing) → `stopWorkflow` for `stop`; for `removed` (deleted, on or off) also `scheduler.clearPrefix` of its timers and `clearWorkflowState` (its `bf:state:<id>::*` keys); then `startWorkflow(id, true)` for `start` (plain start blocks run) and `startWorkflow(id, false)` for `restart` (triggers re-armed only); `syncContextMenus()` if any list is non-empty | The editor never messages the worker to start or stop: saving is enough. Position/name edits produce an empty diff. |
| `notifications.onButtonClicked` | Manual Step: button 0 = Continue (`answerPrompt(runId, true)`), button 1 = Fail | Only for notification ids `bf-prompt:<runId>`. |
| `notifications.onClicked` | Manual Step: Continue | Firefox has no notification buttons, so a click means Continue. |
| `action.onClicked` | `openEditor()` | Toolbar button. No popup is defined. |
| `runtime.onMessage` | Dispatch on `message.type` (below) | Never sends a response; results come back through storage or a separate message. |

### Runtime messages handled

Full payloads in [Message Protocol](Message-Protocol.md).

| `type` | Action |
| --- | --- |
| `bf:start-pick` | `startPicking(sender.tab?.id, url, mode, urlFrom)`; the sender's tab is remembered as the editor tab. |
| `bf:picked` | `finishPicking(message, {tabId, frameId, tabUrl})` from `sender` |
| `bf:pick-cancelled` | `cancelPicking(sender.tab?.id)` |
| `bf:pick-error` | from a picker in a page: `cancelPicking(sender.tab.id)` (the editor shows the message itself) |
| `bf:picker-sync` / `bf:recorder-sync` | `relayPickerSync` / `relayRecorderSync`: passed on to every frame of the sender's tab |
| `bf:run-workflow` | `newRunner(migrateWorkflow(message.workflow)).runOnce()`: runs the workflow **as sent** (the canvas, possibly unsaved), enabled or not. |
| `bf:stop-run` | `cancelRequests.add(runId)` and `answerPrompt(runId, false)` (a run waiting on a Manual Step stops right away). |
| `bf:answer-prompt` | `answerPrompt(runId, ok)` |
| `bf:start-recording` / `bf:stop-recording` / `bf:recorded` | `startRecording` / `stopRecording` / `recordStep(step, sender.tab?.id)` |
| anything else | ignored (`bf:pick-result` is for the editor; `bf:parse-html` fails `isExtensionMessage`). |

## How workflows start and stop

| Situation | What happens |
| --- | --- |
| Install (first time) | Samples saved → `storage.onChanged` starts the enabled ones, **and** `onInstalled` calls `startAllEnabled()`. Both call `start()`, which clears timers first, so the second call replaces the first's timers. |
| Browser start | `onStartup` → `startAllEnabled()`. Timers also come back through `restoreAll()`. |
| Worker wakes up (alarm, message, navigation) | Nothing is restarted. Only the event's handler runs, on a fresh runner. |
| Editor saves a workflow | `diffWorkflows`: newly enabled or behaviour-changed → `start()`; disabled or deleted → `stopWorkflow()`; deleted → its timers and block state are removed too. |
| Run button | `bf:run-workflow` → `runOnce()` with trigger `manual`; schedules nothing. |
| Stop button | `bf:stop-run` → run id in `cancelRequests`; the engine checks `isCancelled` between steps. |
| Timer due | `onAlarm` → `handleTimer(key)`; disabled/deleted workflow → timer cleared. |
| Page Visited / Context Menu | `handleEvent(nodeId, payload)` with the tab as `$session.tabs.main`. |

## Run lifecycle, from the worker's side

1. A runner method creates a `RunRecord` (`status: 'running'`) and reports it via `onRun` → added to `liveRuns`,
   written to `bf:runs`.
2. Each step update calls `onRun` again; `saveRun` merges updates that arrive while a write is in flight
   into one write.
3. Log lines go to `bf:logs` through `appendLog` (serialised, capped at 300).
4. On finish/fail/cancel `onRun` removes the run from `liveRuns` and `cancelRequests`.
5. If the worker dies first, the next worker start marks the run `interrupted` (`markInterrupted`).

The editor follows all of this by watching `bf:runs` and `bf:logs` (see [Editor](Editor.md)).

## The offscreen document

Chrome's service worker has no DOM, but Extract List / Extract Table on fetched HTML need `DOMParser`.
`Host.html.act` (`actOnHtml` in [htmlParse.ts](../../src/browser/htmlParse.ts)) therefore:

- parses in place when `DOMParser` exists (Firefox's event page);
- otherwise calls `ensureOffscreen()`: `offscreen.createDocument({ url: '/offscreen.html', reasons: ['DOM_PARSER'] })`
  if `offscreen.hasDocument()` is false (parallel callers share one creation; a "single offscreen" error
  from a race is ignored), then `runtime.sendMessage({ type: 'bf:parse-html', html, baseUrl, request })`.

[offscreen/main.ts](../../src/entrypoints/offscreen/main.ts) answers only `bf:parse-html`: it calls
`runOnHtml(html, baseUrl, request)` (parse with a `<base href>`, run the [page agent](Page-Agent.md) on the
parsed document with `budgetMs: 0`) and replies `{ ok: true, result }` or `{ ok: false, error }`, returning
`true` to answer asynchronously. The document is never closed; it stays until the browser drops it.
Background: [Architecture: Data and scraping](../ARCHITECTURE.md#data-and-scraping).

## Gotchas

- **Add listeners at the top level only**, synchronously, inside `defineBackground`. Never inside an
  `await` or a helper called later.
- **No `setTimeout` for workflow timing** here; use the scheduler. In-step polling in `src/browser` is fine.
- **Do not cache workflows in memory.** Every handler reloads them with `loadWorkflows()`.
- `liveRuns` is per worker. A Stop for a run owned by a worker that died does nothing (the run is
  already marked interrupted on the next start).
- `onMenuClicked` does not re-check `workflow.enabled`; it relies on menus existing only for enabled
  workflows.

## See also

- [Scheduling and Timers](Scheduling-and-Timers.md): `HybridScheduler`, alarms, heartbeat.
- [Browser Host](Browser-Host.md): every `src/browser` module the worker uses.
- [Message Protocol](Message-Protocol.md), [Storage Keys](Storage-Keys.md).
- [Core Engine](Core-Engine.md): what the runner does with these calls.
- [Picker and Recorder](Picker-and-Recorder.md): the page side of picking and recording.
