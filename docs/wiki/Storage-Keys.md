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
| `bf:workflows` | `Workflow[]` (see [Core Engine](Core-Engine.md)) | Editor autosave (`saveWorkflows`, debounced); background on first install (`sampleWorkflows()`) | Background (`loadWorkflows` in every handler; `storage.onChanged` → `diffWorkflows`), `Host.workflows.get` (Run Workflow), editor on load | Permanent. Every write is a start/stop signal to the worker. |
| `bf:logs` | `LogEntry[]`, newest last, max `MAX_LOG_ENTRIES` = 300 | Background (`appendLog`, serialised queue) | Editor `useLogs()` | Trimmed on append; editor Clear → `clearLogs()` removes the key. |
| `bf:runs` | `RunRecord[]`, newest last, max `MAX_RUNS` = 40 | Background (`saveRun` coalesced, `updateRuns`; `markInterrupted` at worker start) | Editor `useRuns()` (run list, inspector, Reports) | Trimmed on write; editor Clear → `clearRuns()` keeps only `running` runs. Big payloads and secrets are masked by the engine before they get here. |
| `bf:secrets` | `Record<string, string>` | Editor Secrets page (`useStorageValue`) | `Host.secrets.all()` (`{{secret.x}}`), editor (masking, suggestions) | Permanent, plain text in the profile (not encrypted). |
| `bf:prompts` | `PendingPrompt[]` `{runId, workflowName, message, askedAt}` | Background `askUser` (add; remove when answered/timed out) | Editor `usePrompts()` → `PromptBanner` | Short-lived; `clearStalePrompts()` drops orphans at worker start. |
| `bf:recording` | `RecordingState` `{workflowId, tabId, startUrl, lastUrl, steps, status}` | Background (`startRecording`, `recordStep`, `onRecordedTabUpdated`, `stopRecording`) | Editor (`useStorageValue`: live bar, converts on `status: 'stopped'`) | One at a time. Removed by the editor after converting (or if the workflow is gone). |
| `bf:pending-pick` | `{editorTabId?: number, mode?: 'element' \| 'form'}` | Background `startPicking` | Background `finishPicking` / `cancelPicking` (read and delete) | Seconds to minutes; a pick abandoned without Esc leaves it until the next pick overwrites it. |
| `bf:timer:<timerKey>` | `StoredTimer` `{data?, periodic, delayMs, periodMs?, dueAt, short}`; `timerKey` = `bf::<workflowId>::<nodeId>::<name>` | `HybridScheduler.set` | `HybridScheduler` (`take`, `handleAlarm`, `restoreAll`) | Removed by `clear`/`clearPrefix` (workflow start/stop), and by `take` for one-shots. See [Scheduling and Timers](Scheduling-and-Timers.md). |
| `bf:state:<workflowId>::<nodeId>::<key>` | any JSON (`ctx.state`) | Blocks via `Host.state.set` (`StorageState`) | Blocks via `ctx.state.get` | **Never deleted**, even when the block or workflow is. E.g. Timer `count`, Watch Element's last value. |

The prefixes `timerPrefix` and `statePrefix` are the only keys built dynamically. `HybridScheduler`'s
`keys()` scans all of `storage.local` (`get(null)`) to find `bf:timer:*`.

## storage.session

Cleared when the browser closes; shared by the worker and extension pages, not by content scripts (default
access level). Keys are local constants, not in `STORAGE_KEYS`.

| Key | Shape | Writer | Reader | Why session |
| --- | --- | --- | --- | --- |
| `bf:own-tabs` | `number[]` tab ids, last 200 | `addOwnTab` (Open Tab, watch tabs, recording tab) | `isOwnTab` (Page Visited ignores these) | Tab ids mean nothing after a restart. |
| `bf:watch-tabs` | `Record<url, tabId>` | Background `pageReader.ensureWatchTab` | same | Session only, so a restart can't leave it pointing at a reused tab id (older versions kept it in `local`; `forgetLegacyWatchTabs` removes that at worker start). Closed tabs are replaced when used. |
| `bf:popups` | `{tabId, openerTabId, at}[]`, last 50, younger than 2 min | `recordPopup` (from `webNavigation.onCreatedNavigationTarget`) | `waitForPopup` (claims and removes) | Must survive the worker sleeping between the popup opening and the block waiting. |

## IndexedDB `blockflow` (version 2)

Same origin for worker and editor, so both open it directly. Large or numerous data lives here because
`storage.local` is small and slow for big values.

| Object store | keyPath | Shape | Writer | Readers | Lifecycle |
| --- | --- | --- | --- | --- | --- |
| `screenshots` | `id` | `{id, runId, ts, dataUrl}` (JPEG data URL) | `Host.screenshots.capture` → `saveScreenshot` | Editor `Screenshot`, `ReportsPage` (`loadScreenshot`) | Newest 150 kept. Run records point at them by id; a pruned id shows nothing. |
| `datasets` | `name` | `{name, rows, updatedAt}` | Save to Dataset (`writeDataset`, append/replace) | Download block with "from dataset" (`Host.datasets.read` → `readDataset`), editor Data page (`listDatasets`, `deleteDataset`) | Permanent until deleted on the Data page. `unlimitedStorage` lifts the quota. |

## In memory only (lost when the worker stops)

| State | Where | Effect of a restart |
| --- | --- | --- |
| `liveRuns`, `cancelRequests` | background.ts | Runs left `running` are marked `interrupted` at the next start. |
| Armed short timers, keep-alive interval | `HybridScheduler` | Re-armed by `restoreAll` / the heartbeat alarm. |
| Manual Step `answers` | prompts.ts | Pending prompts are cleared; the run is already gone. |
| Per-tab response logs | navigation.ts `watchNetwork` | Wait For "response" can't look back past the restart. |
| Write queues (`writeQueue`, `runQueue`, recording `queue`, `menuSync`) | stores.ts, recording.ts, background.ts | Nothing pending survives; writes in flight may be lost on a hard kill. |

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
