# Storage Keys

Every piece of persistent state BlockFlow keeps: `browser.storage.local` keys, `browser.storage.session`
keys, and the IndexedDB database. Read this when you add state, debug "where did that come from", or need
to know what survives a worker restart or a browser restart.

**Source:** [keys.ts](../../src/shared/keys.ts), [stores.ts](../../src/browser/stores.ts),
[host.ts](../../src/browser/host.ts), [scheduler.ts](../../src/browser/scheduler.ts),
[prompts.ts](../../src/browser/prompts.ts), [picking.ts](../../src/browser/picking.ts),
[recording.ts](../../src/browser/recording.ts), [pageReader.ts](../../src/browser/pageReader.ts),
[ownTabs.ts](../../src/browser/ownTabs.ts), [popups.ts](../../src/browser/popups.ts),
[blobStore.ts](../../src/browser/blobStore.ts), [hooks.ts](../../src/entrypoints/editor/hooks.ts)

No code uses `storage.sync`, `localStorage` or cookies for extension state (the Page Info block reads a
*web page's* `localStorage`, which is unrelated). Why state lives in storage at all:
[Architecture: Surviving the background worker sleeping](../ARCHITECTURE.md#surviving-the-background-worker-sleeping).

## storage.local (`STORAGE_KEYS` in keys.ts)

| Key | Shape | Writer | Readers | Lifecycle |
| --- | --- | --- | --- | --- |
| `bf:workflows` | `Workflow[]` (see [Core Engine](Core-Engine.md)) | Editor autosave (`saveWorkflows`, debounced); background on first install (`sampleWorkflows()`) and once after an update that bumps `schemaVersion` (`migrateStoredWorkflows`) | Background (`loadWorkflows`, which returns migrated workflows, in every handler; `storage.onChanged` → `diffWorkflows`), `Host.workflows.get` (Run Workflow), editor on load | Permanent. Every write is a start/stop signal to the worker. |
| `bf:logs` | `LogEntry[]`, newest last, max `MAX_LOG_ENTRIES` = 300 | Background (`appendLog`, serialised queue) | Editor `useLogs()` | Trimmed on append; editor Clear → `clearLogs()` removes the key. |
| `bf:runs` | `RunRecord[]`, newest last, max `MAX_RUNS` = 40 | Background (`saveRun` coalesced, `updateRuns`; `markInterrupted` at worker start) | Editor `useRuns()` (run list, inspector, Reports) | Trimmed on write; editor Clear → `clearRuns()` keeps only `running` runs. Big payloads and secrets are masked by the engine before they get here. |
| `bf:secrets` | `Record<string, string>` | Editor Secrets page (`useStorageValue`) | `Host.secrets.all()` (`{{secret.x}}`), editor (masking, suggestions) | Permanent, plain text in the profile (not encrypted). |
| `bf:prompts` | `PendingPrompt[]` `{runId, workflowName, message, askedAt}` | Background `askUser` (add; remove when answered/timed out) | Editor `usePrompts()` → `PromptBanner` | Short-lived; `clearStalePrompts()` drops orphans at worker start. |
| `bf:recording` | `RecordingState` `{workflowId, tabId, startUrl, lastUrl, steps, status, popups?}` | Background (`startRecording`, `recordStep`, `onRecordedPopup`, `onRecordedTabUpdated`, `stopRecording`) | Editor (`useStorageValue`: live bar, converts on `status: 'stopped'`) | One at a time. Removed by the editor after converting (or if the workflow is gone). |
| `bf:pending-pick` | `{editorTabId?: number, mode?: 'watch' \| 'action' \| 'form', tabId?: number}` | Background `startPicking` | Background `finishPicking` / `cancelPicking` (read and delete) | Seconds to minutes; a pick abandoned without Esc leaves it until the next pick overwrites it. |
| `bf:timer:<timerKey>` | `StoredTimer` `{data?, periodic, delayMs, periodMs?, dueAt, short}`; `timerKey` = `bf::<workflowId>::<nodeId>::<name>` | `HybridScheduler.set` | `HybridScheduler` (`take`, `handleAlarm`, `restoreAll`) | Removed by `clear`/`clearPrefix` (workflow start/stop), and by `take` for one-shots. See [Scheduling and Timers](Scheduling-and-Timers.md). |
| `bf:state:<workflowId>::<nodeId>::<key>` | any JSON (`ctx.state`) | Blocks via `Host.state.set` (`StorageState`) | Blocks via `ctx.state.get` | Removed when the workflow is deleted (background, `diffWorkflows(...).removed` → `clearWorkflowState`); kept when only a block is removed. E.g. Timer `count`, Watch Element's last value. |
| `bf:onboarding` | `OnboardingState` `{tryItDismissed?: boolean}` | Editor `TryItCard` (when closed) | Editor `TryItCard` (once on load) | Permanent. Absent = show the first-run "Try it" card. |
| `bf:settings` | `BridgeSettings` `{outsideControl: boolean}` (`src/core/bridgeProtocol.ts`) | Editor Settings page (`SettingsPage`, after asking for `nativeMessaging`); e2e/CLI set it through the worker | Background (`loadBridgeSettings` at every worker start and on `storage.onChanged`) → connects or disconnects the native port | Permanent. Absent = off. Switching it off sends `bridge.disabled` and closes the port. |
| `bf:bridge-log` | `BridgeLogEntry[]` `{at, method, ok, detail?}`, newest last, max `MAX_BRIDGE_LOG` = 200 | Background (`appendBridgeLog` in `bridge.ts`, serialised queue), one entry per bridge request | Editor Settings page ("Recent requests"; Clear log removes the entries) | Trimmed on append. `detail` is a short summary (workflow name, run id, error message), never params, payloads or secret values. |
| `bf:suites` | `Suite[]` `{id, name, workflowIds, stopOnFailure?}` (`src/core/bridgeProtocol.ts`) | Editor `SuitesPage` (`saveSuites`, `src/browser/suites.ts`) | `SuitesPage`, background (`loadSuites` for `bf:run-suite` and the bridge's `suite.list` / `suite.run`) | Permanent. Read leniently (`normaliseSuites`); ids of deleted workflows stay until removed on the Suites page (running such a suite fails with `config.invalid`). |

The prefixes `timerPrefix` and `statePrefix` are the only keys built dynamically. `HybridScheduler`'s
`keys()` scans all of `storage.local` (`get(null)`) to find `bf:timer:*`.

## storage.session

Cleared when the browser closes; shared by the worker and extension pages, not by content scripts (default
access level). Keys are local constants, not in `STORAGE_KEYS`.

| Key | Shape | Writer | Reader | Why session |
| --- | --- | --- | --- | --- |
| `bf:own-tabs` | `number[]` tab ids, last 200 | `addOwnTab` (Open Tab, watch tabs, recording tab) | `isOwnTab` (Page Visited ignores these) | Tab ids mean nothing after a restart. |
| `bf:watch-tabs` | `Record<url, tabId>` | Background `pageReader.ensureWatchTab` | same | Session only, so a restart can't leave it pointing at a reused tab id (older versions kept it in `local`; `forgetLegacyWatchTabs` removes that at worker start). Closed tabs are replaced when used. |
| `bf:picker-tabs` | `Record<editorTabId, tabId>` | `picking.ts` when it opens a picker tab | `picking.ts` `findTargetTab` (reused while the tab exists) | Session: one picker tab per editor tab. |
| `bf:downloads-claimed` | `number[]`: download ids, last 200 | `waitForDownload` (`downloads.ts`) when it hands a download to a block | `waitForDownload` (skips them) | So each download is returned once; the downloads themselves come from `downloads.search`. |
| `bf:bridge-status` | `BridgeStatus` `{state: 'off' \| 'connecting' \| 'connected' \| 'waiting' \| 'failed', since, error?, attempts?}` (`src/browser/bridgeStatus.ts`) | Background bridge connection (`writeBridgeStatus`) on every state change | Editor Settings page | It describes the live native port, which ends with the browser. |
| `bf:debug-pause` | `PausedRun[]` = `DebugPause` + `{workflowName, pausedAt}` (`src/browser/debugChannel.ts`, `DEBUG_PAUSE_KEY`) | `debugChannel.pause` (add when a debug run pauses; remove when answered, stopped or after `MAX_PAUSE_MS`) | Editor `DebugBanner` (`useDebugPauses`) | The pause is a promise in the worker; it cannot outlive it. `clearStaleDebugPauses()` drops orphans at worker start. |
| `bf:popups` | `{tabId, openerTabId, at}[]`, last 50, younger than 2 min | `recordPopup` (from `webNavigation.onCreatedNavigationTarget`) | `waitForPopup` (claims and removes) | Must survive the worker sleeping between the popup opening and the block waiting. |

## IndexedDB `blockflow` (version 2)

Same origin for worker and editor, so both open it directly. Large or numerous data lives here because
`storage.local` is small and slow for big values.

| Object store | keyPath | Shape | Writer | Readers | Lifecycle |
| --- | --- | --- | --- | --- | --- |
| `screenshots` | `id` | `{id, runId, ts, dataUrl}` (JPEG data URL) | `Host.screenshots.capture` → `saveScreenshot` | Editor `Screenshot`, `ReportsPage` (`loadScreenshot`) | Newest 150 kept. Run records point at them by id; a pruned id shows nothing. |
| `screenshots` (trace pictures, M5.1) | `id` = `~t\|<ts base36>\|<runId>\|<bytes>\|<random>` | same shape | `Host.trace` → `saveTraceImage` | Reports timeline (`TraceTimeline.tsx`), HTML export | Separate from the 150: at most 200 per run (later pictures are not stored), and beyond 1 000 pictures or 120 MB in total the oldest runs' pictures are deleted, whole runs at a time, never the current run. `step.trace.before` / `after` point at them. |
| `datasets` | `name` | `{name, rows, updatedAt}` | Save to Dataset (`writeDataset`, append/replace) | Download block with "from dataset" (`Host.datasets.read` → `readDataset`), editor Data page (`listDatasets`, `deleteDataset`) | Permanent until deleted on the Data page. `unlimitedStorage` lifts the quota. |

## IndexedDB `blockflow-visual` (version 1, M5.3)

Visual comparison (Screenshot `compare`, [Browser-Host](Browser-Host.md#visualts-m53)). Its own database so
its upgrades never race `blockflow`'s.

| Object store | keyPath | Shape | Writer | Readers | Lifecycle |
| --- | --- | --- | --- | --- | --- |
| `baselines` | `key` = `"<workflowId>/<nodeId>"` | `{key, workflowId, nodeId, dataUrl (PNG), width, height, updatedAt, runId}` | `Host.visual.compare` (first run, `updateBaseline`), `acceptBaseline` (`bf:accept-baseline`) | `Host.visual.compare`, editor `VisualComparePanel` | Permanent; replaced, never pruned (`deleteBaselines(workflowId)` exists; deleting a workflow does not call it yet). |
| `comparisons` | `id`, index `nodeId` | `{id, runId, workflowId, nodeId, ts, status, diffPixels, diffRatio, threshold, maxDiffRatio, actualId, baselineId?, diffId?, baselineSize?, acceptedAt?}` | `Host.visual.compare`, `acceptBaseline` | `VisualComparePanel` (`findComparison`) | Newest 300 kept. The picture ids point into `blockflow` `screenshots` (pruned with them). |

## In memory only (lost when the worker stops)

| State | Where | Effect of a restart |
| --- | --- | --- |
| `liveRuns`, `cancelRequests` | background.ts | Runs left `running` are marked `interrupted` at the next start. |
| Armed short timers, keep-alive interval | `HybridScheduler` | Re-armed by `restoreAll` / the heartbeat alarm. |
| Manual Step `answers` | prompts.ts | Pending prompts are cleared; the run is already gone. |
| Debug pause `answers` | debugChannel.ts | Listed pauses (`bf:debug-pause`) are cleared at the next start; the run is marked `interrupted`. |
| Per-tab response logs | navigation.ts `watchNetwork` | Wait For "response" can't look back past the restart. |
| Bridge port, reconnect backoff, result blobs for `blob.get` (10 min after last read, at most 20) | bridge.ts, bridgeHandlers.ts | The port is reopened by `syncBridge()` at the next start when `bf:settings` is on; blobs are gone (`notFound`). The open port normally keeps the worker alive. |
| Write queues (`writeQueue`, `runQueue`, recording `queue`, `menuSync`, bridge `logQueue`) | stores.ts, recording.ts, background.ts, bridge.ts | Nothing pending survives; writes in flight may be lost on a hard kill. |

## Conventions for new state

- Add `storage.local` keys to `STORAGE_KEYS` with a doc comment on shape and owner; prefix everything `bf:`.
- Values must be JSON-serialisable. Use one serialised queue for read-modify-write keys that are written
  often (see `appendLog`, `updateRuns`, recording `update`).
- Anything big or unbounded goes to IndexedDB.
- The editor reads live values with `useStorageValue(key, fallback)` (`hooks.ts`), which listens to
  `storage.onChanged` for area `local` only.

## See also

- [Background Worker](Background-Worker.md), [Browser Host](Browser-Host.md)
- [Scheduling and Timers](Scheduling-and-Timers.md) for `bf:timer:*`
- [Message Protocol](Message-Protocol.md) for the message half of worker ↔ editor traffic
- [Editor](Editor.md) for the hooks that watch these keys
