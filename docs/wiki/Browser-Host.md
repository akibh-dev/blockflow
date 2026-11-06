# Browser Host

`src/browser` is the real implementation of the engine's `Host` interface (`src/core/types.ts`) plus the
background-side halves of picking and recording. It is the only layer that calls extension APIs on
behalf of blocks. Read this page when a block misbehaves only in a real browser, when you add a `Host`
capability, or when you need to know which permission or browser a feature depends on.

**Source:** [host.ts](../../src/browser/host.ts), [tabs.ts](../../src/browser/tabs.ts),
[ownTabs.ts](../../src/browser/ownTabs.ts), [navigation.ts](../../src/browser/navigation.ts),
[pageDriver.ts](../../src/browser/pageDriver.ts), [pageReader.ts](../../src/browser/pageReader.ts),
[htmlParse.ts](../../src/browser/htmlParse.ts), [cdp.ts](../../src/browser/cdp.ts),
[popups.ts](../../src/browser/popups.ts), [prompts.ts](../../src/browser/prompts.ts),
[picking.ts](../../src/browser/picking.ts), [recording.ts](../../src/browser/recording.ts),
[blobStore.ts](../../src/browser/blobStore.ts), [stores.ts](../../src/browser/stores.ts)
(the schedulers, [scheduler.ts](../../src/browser/scheduler.ts) and
[hybridScheduler.ts](../../src/browser/hybridScheduler.ts), have their own page:
[Scheduling and Timers](Scheduling-and-Timers.md))

Rules: `src/browser` may use browser APIs and import pure `src/core` / `src/dom` modules; `src/core` must
never import from here. `browser` comes from `wxt/browser`. Polling with `sleep` inside one step is fine;
workflow timing goes through the scheduler.

## Module map

| Module | Role | Main exports | Used by |
| --- | --- | --- | --- |
| `host.ts` | Assembles the `Host` | `createExtensionHost(scheduler)` | background |
| `tabs.ts` | Tab primitives | `requireTabId`, `waitForTabComplete`, `reloadAndWait`, `tabExists`, `sleep` | most modules |
| `ownTabs.ts` | Tabs BlockFlow opened (session storage) | `addOwnTab`, `isOwnTab` | host, pageReader, recording, background |
| `navigation.ts` | Load / network idle / URL / response waits | `tabInfo`, `waitForLoad`, `waitForUrl`, `waitForNetworkIdle`, `watchNetwork`, `waitForResponse`, `statusMatches` | host |
| `pageDriver.ts` | Sends requests to the page agent | `act`, `actInTab` | host, pageReader, picking |
| `pageReader.ts` | Watch Element / Read Element with a URL | `readElement` | host |
| `htmlParse.ts` | Agent on an HTML string | `actOnHtml`, `runOnHtml` | host, offscreen document |
| `cdp.ts` | Real input and background screenshots via `debugger` | `withDebugger`, `mouseClick`, `pressKey`, `typeInto`, `captureWithDebugger`, `hasDebugger` | pageDriver, host |
| `popups.ts` | Tabs opened by pages | `recordPopup`, `waitForPopup` | background, host |
| `prompts.ts` | Manual Step | `askUser`, `answerPrompt`, `promptRunId`, `clearStalePrompts`, `PendingPrompt` | host, background, editor |
| `picking.ts` | Background side of the element picker and the editor's 📸 Snapshot page | `startPicking`, `finishPicking`, `cancelPicking`, `relayPickerSync`, `snapshotForEditor` | background |
| `recording.ts` | Background side of the recorder | `startRecording`, `recordStep`, `onRecordedPopup`, `onRecordedTabUpdated`, `relayRecorderSync`, `stopRecording`, `loadRecording`, `RecordingState` | background, editor (type) |
| `blobStore.ts` | IndexedDB: screenshots, datasets | `saveScreenshot`, `loadScreenshot`, `readDataset`, `writeDataset`, `listDatasets`, `deleteDataset`, … | host, editor |
| `stores.ts` | `storage.local` for workflows, logs, runs | `loadWorkflows`, `saveWorkflows`, `appendLog`, `saveRun`, `updateRuns`, … | background, editor |

## host.ts: the `Host`

`createExtensionHost(scheduler: Scheduler): Host` returns:

| `Host` member | Implementation | APIs / permissions |
| --- | --- | --- |
| `sleep(ms)` | `tabs.ts` `sleep` (`setTimeout`) | none |
| `http.fetch(opts)` | `fetch(url, {method, headers, body})`; returns `{status, ok, body}` with body cut to 200 000 chars | host permissions (`<all_urls>`) bypass CORS |
| `http.download(url)` | `fetch` → base64 in 32 KB chunks; `mime` from `content-type`, `name` from the URL path | same |
| `notify({title, message})` | `notifications.create` basic, icon `/icon/128.png` | `notifications` |
| `tabs.open(opts)` | `openTab`: reuse `reuseTabId` if it exists → else navigate the active tab when `newTab` is false → else `windows.create` (`newWindow`) or `tabs.create`. Then `addOwnTab`, `watchNetwork`, and if `waitUntil !== 'none'` sleep 100 ms and `waitForLoad`. | `tabs`, `webRequest` |
| `tabs.navigate(tabId, opts)` | `tabs.update` / `goBack` / `goForward` / `reload`, sleep 100 ms, `waitForLoad`; returns the final URL | `tabs` |
| `tabs.close(tabId)` | `tabs.remove` if it still exists | `tabs` |
| `tabs.info`, `waitForLoad`, `waitForUrl`, `waitForResponse` | `navigation.ts` | `tabs`, `webRequest` |
| `tabs.current()` | Active http(s) tab of the last focused window, else the most recently accessed http(s) tab (when the editor is focused) | `tabs` |
| `tabs.waitForPopup` | `popups.ts` | `webNavigation`, `storage` |
| `page.act` | `pageDriver.act` | `scripting`, host permissions; `debugger` for real input |
| `page.readElement` | `pageReader.readElement` | `tabs`, `scripting` |
| `page.dialogs(tabId, opts)` | `executeScript` in `world: 'MAIN'`: installs `window.alert/confirm/prompt` overrides once per page (state in `window.__blockflowDialogs`), updates mode/text, returns the dialog log. `{read: true}` only reads. | `scripting` (Chrome 102+, Firefox 128+ for `world`) |
| `page.runScript(tabId, code, data)` | `browser.userScripts.execute({ js: [{code}], world: 'USER_SCRIPT' })` with the code wrapped in an async IIFE and `const data = <JSON>`. Throws a long "needs Chrome 135…" message when the API is missing or blocked. | optional `userScripts`, Chrome 135+, "Allow User Scripts" toggle |
| `scheduler` | the one passed in | `alarms`, `storage` |
| `state` | `StorageState`: `storage.local` under `bf:state:<key>` (a deleted workflow's keys are removed by `clearWorkflowState` in `stores.ts`) | `storage` |
| `workflows.get(id)` | `loadWorkflows()` and find | `storage` |
| `secrets.all()` | `bf:secrets` | `storage` |
| `screenshots.capture(tabId, runId)` | Active tab: `tabs.captureVisibleTab` (JPEG 60). Background tab: `captureWithDebugger` (null without the permission). Saved with `saveScreenshot`; returns the id. | `<all_urls>`; `debugger` for background tabs |
| `prompt.ask` | `prompts.askUser` | `notifications`, `storage` |
| `datasets.read/write` | `blobStore` | IndexedDB, `unlimitedStorage` |
| `downloads.save(filename, content, mime)` | `downloads.download` with a `blob:` URL where `URL.createObjectURL` exists (Firefox), else a `data:` URL (Chrome's worker). `conflictAction: 'uniquify'`; `\ / : * ? " < > |` in names become `-`. | `downloads` |
| `html.act` | `htmlParse.actOnHtml` | `offscreen` (Chrome) |
| `now()` | `new Date()` | none |

## tabs.ts

| Function | Behaviour |
| --- | --- |
| `requireTabId(tab): number` | The id, or throws "The browser did not return a tab id". |
| `waitForTabComplete(tabId, timeoutMs = 30 000)` | Arms a `tabs.onUpdated` listener *first*, then returns at once if `status === 'complete'`, else waits for the next `complete`. |
| `reloadAndWait(tabId, timeoutMs = 30 000)` | Same listener trick around `tabs.reload`. |
| `tabExists(tabId)` | `tabs.get` succeeds. |
| `sleep(ms)` | Promise around `setTimeout`. For polling only. |

## ownTabs.ts

`storage.session` key `bf:own-tabs`: a `number[]` of tab ids, last 200. `addOwnTab` (called by Open Tab,
watch tabs, recording) and `isOwnTab` (Page Visited filter). Session storage because tab ids are
meaningless after a restart. Note: the picker's tab is **not** added. See
[Architecture: Triggers and the recorder](../ARCHITECTURE.md#triggers-and-the-recorder).

## navigation.ts

| Function | Behaviour |
| --- | --- |
| `tabInfo(tabId): Promise<TabInfo \| null>` | `{url (or pendingUrl), title, loading}`; null if the tab is gone. |
| `waitForLoad(tabId, until, timeoutMs)` | `'none'`: return. `'load'`: poll `tabInfo` every 100 ms until not loading. `'networkidle'`: then `waitForNetworkIdle(tabId, 500, remaining ≥ 1 s)`. Polling, not events, so a `complete` that already happened is not missed and each poll keeps the worker alive. |
| `waitForNetworkIdle(tabId, idleMs, timeoutMs)` | Temporary `webRequest.onBeforeRequest/onCompleted/onErrorOccurred` listeners filtered by `tabId`; resolves after `idleMs` with nothing in flight. Requests started before the call are invisible. |
| `waitForUrl(tabId, pattern, timeoutMs)` | Polls the URL every 150 ms with `urlMatches`; catches `pushState`. |
| `watchNetwork(tabId)` | Per-tab in-memory log (last 300 completed/failed responses: url, status, method, time). Listeners filtered by tab so normal browsing never wakes the worker; removed on `tabs.onRemoved`. Lost on worker restart. |
| `statusMatches(status, wanted)` | `""` any, `"200"`, `"2xx"`, `"200,201"`. |
| `waitForResponse(tabId, pattern, status, lookBackMs, timeoutMs)` | Starts `watchNetwork` if needed, then polls the log every 150 ms for an unused entry since `now - lookBackMs`. Matched entries are marked `used`. Timeout message lists statuses seen for that URL. |

`webRequest` is observe-only (no blocking listeners: MV3 forbids them without `webRequestBlocking`).

## pageDriver.ts

The bridge between `Host.page.act` and the [Page Agent](Page-Agent.md). Request/response types are in
[Page Protocol](Page-Protocol.md); the flow diagram is in
[Architecture: Page blocks and the page agent](../ARCHITECTURE.md#page-blocks-and-the-page-agent).

```ts
act(tabId, request: AgentRequest, timeoutMs, options?: { realInput?: boolean }): Promise<Record<string, unknown>>
actInTab(tabId, request: AgentRequest, timeoutMs): Promise<Record<string, unknown>>
```

`actInTab` loop:

1. Budget for this call: `min(2000 ms, time left − 150 ms)`.
2. `callAgent`: `scripting.executeScript({func})` calls `globalThis.__blockflowAgent.run({request, budgetMs})`.
   `{status:'missing'}` → inject `/content-scripts/agent.js` and call again. No result → `vanished`.
3. Outcomes:

| Outcome | Handling |
| --- | --- |
| `done` | return `result` |
| `error` | throw a `CodedError` with its message and `code` (default `step.failed`), the locator, `url` and `matches` (strict-mode violations, bad locators…) |
| `pending` | remember `reason`, `code` and `url`, ask again immediately |
| `frame` (`src`, `rest`, `offset?`) | `webNavigation.getAllFrames`, pick the frame whose URL equals `src` (or prefixes it), children of the current frame first, then continue with `locator: rest` in that `frameId`; `offset` is added up and added to a `locate` answer's `x`, `y` |
| `vanished` | for actions (`click`, `fill`, `set-field`, `select`, `check`, `press`) return `{navigated: true}` (never repeat: it might submit twice); otherwise retry |
| executeScript threw | tab gone → "The tab was closed" (`tab.closed`); restricted page (`chrome://`, web store, missing host permission) → "The browser does not let extensions work on this page" (`page.restricted`, or `permission.missing` when the message is about a permission); else retry ("the page was busy loading") |

4. Past the deadline: `CodedError` `Timed out after Ns: <last reason>`, with the last pending answer's code
   (`locator.not-found`, `element.covered`…; `frame.unreachable` while a cross-origin frame never showed up,
   `navigation.failed` while the page was busy loading, else `timeout`). Between non-pending outcomes it
   sleeps 250 ms. See [Page Protocol: Error codes](Page-Protocol.md#error-codes).

`actWithRealInput` (when `options.realInput` and the op is an action): asks the agent to `locate` the
element (same auto-wait, returns `x`, `y` in the tab's viewport, frame offsets included, and `kind`), then drives it with `cdp.ts`:
click/hover/right/double via `mouseClick`, fill via `typeInto`, check reads the state first and only clicks
if it differs, press clicks then `pressKey`. `select` and non-text `set-field` fall back to the agent. A
`press` without a locator sends the key to whatever has focus.

## pageReader.ts

`readElement({url, selector, reload, read?}): Promise<ReadElementResult>` for Watch Element and Read
Element with a Page URL. Keeps one background tab per URL in `bf:watch-tabs` (`storage.local`), only ever
reusing tabs it opened (added to `ownTabs` too). Reloads it when `reload` is true, waits for `complete`,
then `actInTab(... {op: 'read', locator, kind}, 6000)`. A timeout becomes `{found: false, text: ''}`; other
errors `{found: false, text: '', error}`. See [Architecture: Watch Element](../ARCHITECTURE.md#watch-element).

## htmlParse.ts

| Function | Where it runs | Behaviour |
| --- | --- | --- |
| `runOnHtml(html, baseUrl, request)` | where a DOM exists | `DOMParser` with a `<base href>` prepended, `createAgent(window, doc).run({request, budgetMs: 0})`. `pending` → "Nothing matches: …"; `frame` → error (frames unsupported here). |
| `actOnHtml(html, baseUrl, request)` | background | `runOnHtml` directly if `DOMParser` exists (Firefox), else ensures the offscreen document and sends `bf:parse-html`. |

Details of the offscreen document: [Background Worker](Background-Worker.md#the-offscreen-document).

## cdp.ts

Chrome DevTools Protocol through `browser.debugger`, an **optional** permission (requested from the
editor when a step ticks "Use real mouse and keyboard"; granted outright in the e2e build). Chromium only:
Firefox's build declares neither `debugger` nor `userScripts`.

| Function | Behaviour |
| --- | --- |
| `hasDebugger()` | `permissions.contains({permissions: ['debugger']})`, false on error. |
| `withDebugger(tabId, fn)` | Attach (protocol `1.3`; "already attached" is tolerated), run `fn(send)`, always detach. Attaching per action keeps Chrome's "started debugging this browser" bar short. |
| `mouseClick(send, x, y, {button, clicks, hoverOnly})` | `Input.dispatchMouseEvent` move, then press/release per click. |
| `pressKey(send, combo)` | `"Control+a"`, `"Shift+Tab"`, `"Enter"`, single characters. Modifier bits alt 1, ctrl 2, meta 4, shift 8. Sends `text` only without non-shift modifiers. |
| `typeInto(send, x, y, text)` | Click, Ctrl+A (`commands: ['selectAll']`), then `Input.insertText` (or Backspace for empty). |
| `captureWithDebugger(tabId)` | `Page.captureScreenshot` JPEG 60, raced against 4 s (background tabs may not paint); null without permission. |

## popups.ts

`storage.session` key `bf:popups`: `{tabId, openerTabId, at}[]`, entries younger than 2 minutes, last 50.

- `recordPopup(tabId, openerTabId)`: from `webNavigation.onCreatedNavigationTarget` in the background.
- `waitForPopup(openerTabId, lookBackMs, timeoutMs)`: polls every 200 ms; the found record is removed
  ("claimed") so a second Wait for Popup waits for the next tab.

Session storage, not memory, because the popup can open while the worker is between events.

## prompts.ts (Manual Step)

| Function | Behaviour |
| --- | --- |
| `askUser({runId, workflowName, message, timeoutMs})` | Adds a `PendingPrompt` to `bf:prompts`, shows notification `bf-prompt:<runId>` (`requireInteraction`; Continue / Fail buttons except on Firefox), then polls the in-memory `answers` map every 500 ms, calling `runtime.getPlatformInfo()` each loop to keep the worker alive. Always removes the prompt and clears the notification. Throws "Nobody answered within Ns". |
| `answerPrompt(runId, ok)` | Sets the answer if that run is waiting in *this* worker; otherwise ignored. |
| `promptRunId(notificationId)` | `runId` for `bf-prompt:` ids, else null. |
| `clearStalePrompts()` | Removes prompts whose run is not waiting in this worker (worker start). |

`import.meta.env.FIREFOX` (WXT build flag) decides whether notification buttons are passed.

## picking.ts

Background half of "Pick on page"; the page half is in [Picker and Recorder](Picker-and-Recorder.md) and the
UX in [Architecture: Element picker](../ARCHITECTURE.md#element-picker).

1. `startPicking(editorTabId, url?, mode = 'action', urlFrom = 'block')`: `findTargetTab` reuses the
   editor's picker tab (`storage.session` `bf:picker-tabs`: `Record<editorTabId, tabId>`), navigating it to a
   block URL unless it shows that page, or to an upstream URL only when it shows another origin; without one,
   an upstream URL takes the last-used tab on that origin, else a new remembered tab; no URL takes the
   last-used web tab. Ends a pick still open in another tab, stores `bf:pending-pick = {editorTabId, mode,
   tabId}`, focuses the tab and its window, sets `__blockflowPickerMode` and injects
   `/content-scripts/picker.js` into **all frames**. Any failure → `bf:pick-error` to the editor.
2. `relayPickerSync(message, tabId)`: `tabs.sendMessage(tabId, message)` to every frame of the tab.
3. `finishPicking(picked, {tabId, frameId, tabUrl})`: take and delete `bf:pending-pick`, stop the pickers in
   every frame. In `form` mode run `actInTab(... {op: 'detect-form', locator: selector}, 5000)` (the selector
   may start with `frame=`). Send `bf:pick-result` (selector, candidates, url (the tab's URL when picked in a
   frame), sample, fields?) and focus the editor tab again.
4. `cancelPicking(tabId?)`: take the pending pick, stop the pickers in every frame, focus the editor tab. No
   message is sent to the editor. Also run for a `bf:pick-error` sent by a picker.
5. `snapshotForEditor(editorTabId, url?)` (`bf:snapshot-page`, the editor's 📸 Snapshot page): the same
   `findTargetTab(editorTabId, url, 'block')`, then `actInTab(tabId, {op: 'snapshot'}, 15000)`, focus the
   editor tab again (it copies to the clipboard, which needs focus) and send `bf:snapshot-result` with
   `snapshotDocument(result)` (title, URL, outline), `lines` and `truncated`, or `error`.

Messages to the editor go through `runtime.sendMessage`; errors (editor closed) are swallowed.

## recording.ts

`bf:recording` holds one `RecordingState {workflowId, tabId, startUrl, lastUrl, steps, status, popups?}`.

| Function | Behaviour |
| --- | --- |
| `startRecording(workflowId, url)` | New active tab (also an own tab), store a fresh `recording` state, wait for load, inject `/content-scripts/recorder.js` into all frames (failures on protected pages ignored). |
| `recordStep(step, fromTabId)` | Append the step if recording and the sender is the recording tab (any frame) or one of its popups (then `tab: 'popup'`). |
| `onRecordedPopup(tabId, openerTabId, url)` | From `webNavigation.onCreatedNavigationTarget`: a tab opened by the recording tab or a popup becomes an own tab, `{kind: 'popup', url}` is appended after 300 ms, and the recorder is injected once it has loaded. |
| `onRecordedTabUpdated(tabId, change)` | A new URL adds `{kind: 'navigated', url}` (`tab: 'popup'` in a popup, not for its first page); `status: 'complete'` re-injects the recorder. |
| `relayRecorderSync(message, tabId)` | The toolbar's assert mode, to every frame of that tab. |
| `stopRecording()` | `status: 'stopped'`; calls `__blockflowRecorder.stop()` in every frame of the recording tab and its popups. The editor then converts the steps and deletes the key. |
| `loadRecording()` | Read the key. |

Writes go through a promise queue (`update`) because steps arrive in bursts.

## blobStore.ts (IndexedDB)

Database `blockflow`, version 2, shared by the worker and extension pages (same origin).

| Store | keyPath | Record | Limits |
| --- | --- | --- | --- |
| `screenshots` | `id` | `Screenshot {id, runId, ts, dataUrl}` | newest 150 kept (pruned on save) |
| `datasets` | `name` | `Dataset {name, rows, updatedAt}` | `unlimitedStorage` |

Helpers: `openDb()` (cached promise, reset on failure), `done(request)`, `store(name, mode)`. Data functions:
`saveScreenshot`, `loadScreenshot`, `readDataset`, `writeDataset(name, rows,
'append' | 'replace') → row count`, `listDatasets`, `deleteDataset`.

## stores.ts (storage.local)

| Function | Key | Notes |
| --- | --- | --- |
| `loadWorkflows()` / `saveWorkflows(list)` | `bf:workflows` | Non-array values read as `[]`. |
| `loadLogs()` / `appendLog(entry)` / `clearLogs()` | `bf:logs` | Appends serialised on `writeQueue`, last 300 kept, errors swallowed. |
| `loadRuns()` / `updateRuns(change)` / `saveRun(run)` / `clearRuns()` | `bf:runs` | All writes on `runQueue`, last 40 kept. `saveRun` coalesces updates into `pendingRuns` and flushes them in one write. `clearRuns` keeps running runs. |

Shapes and lifecycles: [Storage Keys](Storage-Keys.md).

## Browser differences

| Feature | Chrome / Chromium | Firefox | Safari |
| --- | --- | --- | --- |
| Background | service worker, no DOM | event page with DOM | not verified |
| HTML parsing (`html.act`) | offscreen document | in the background page | unknown (the build requests `offscreen`) |
| Downloads | `data:` URL | `blob:` URL | not verified |
| Manual Step notification | Continue / Fail buttons | click = Continue | not verified |
| Real input, background-tab screenshots (`debugger`) | optional permission | not available | not available |
| Run Script (`userScripts.execute`) | Chrome 135+, optional permission + toggle | not available | not available |
| Host access | granted at install | must be granted in `about:addons` (README) | not verified |
| `storage.session`, `webNavigation.onCreatedNavigationTarget` | yes | yes | not verified |

## Gotchas

- `executeScript` with `func` serialises the function: it must not close over anything.
- Chrome sorts object keys of `executeScript` results; the agent returns tables as `{columns, values}`.
- `watchNetwork` logs and the `answers` map are in memory: a worker restart loses them (a run in progress
  keeps the worker alive, so this only matters after a crash).
- `bf:state:*` entries of a block are kept when only that block is removed (they go with the workflow).

## See also

- [Background Worker](Background-Worker.md), [Scheduling and Timers](Scheduling-and-Timers.md)
- [Page Protocol](Page-Protocol.md), [Page Agent](Page-Agent.md), [Locators](Locators.md)
- [Storage Keys](Storage-Keys.md), [Message Protocol](Message-Protocol.md)
- [Core Engine](Core-Engine.md) for the `Host` interface's callers
