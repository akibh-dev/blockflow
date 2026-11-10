# Browser Host

`src/browser` is the real implementation of the engine's `Host` interface (`src/core/types.ts`) plus the
background-side halves of picking and recording. It is the only layer that calls extension APIs on
behalf of blocks. Read this page when a block misbehaves only in a real browser, when you add a `Host`
capability, or when you need to know which permission or browser a feature depends on.

**Source:** [host.ts](../../src/browser/host.ts), [tabs.ts](../../src/browser/tabs.ts),
[ownTabs.ts](../../src/browser/ownTabs.ts), [navigation.ts](../../src/browser/navigation.ts),
[pageDriver.ts](../../src/browser/pageDriver.ts), [pageReader.ts](../../src/browser/pageReader.ts),
[htmlParse.ts](../../src/browser/htmlParse.ts), [cdp.ts](../../src/browser/cdp.ts),
[cdpSessions.ts](../../src/browser/cdpSessions.ts), [m3Host.ts](../../src/browser/m3Host.ts),
[m3Runtime.ts](../../src/browser/m3Runtime.ts), [routes.ts](../../src/browser/routes.ts),
[environment.ts](../../src/browser/environment.ts), [telemetry.ts](../../src/browser/telemetry.ts),
[popups.ts](../../src/browser/popups.ts), [prompts.ts](../../src/browser/prompts.ts), [debugChannel.ts](../../src/browser/debugChannel.ts),
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
| `navigation.ts` | Load / network idle / URL / request / response waits | `tabInfo`, `waitForLoad`, `waitForUrl`, `waitForNetworkIdle`, `watchNetwork`, `waitForResponse`, `waitForRequest`, `statusMatches`, `methodMatches` | host |
| `pageDriver.ts` | Sends requests to the page agent | `act`, `actInTab` | host, pageReader, picking |
| `pageReader.ts` | Watch Element / Read Element with a URL | `readElement` | host |
| `htmlParse.ts` | Agent on an HTML string | `actOnHtml`, `runOnHtml` | host, offscreen document |
| `cdp.ts` | Real input and background screenshots via `debugger` | `withDebugger`, `mouseClick`, `mouseDrag`, `modifierMask`, `pressKey`, `insertText`, `typeInto`, `captureWithDebugger`, `hasDebugger` | pageDriver, host |
| `m3Host.ts` | Per-run network, environment and console features; tab claims; run cleanup | `createRunHost(base, runId)` (also returns `traceTelemetry`), `TraceTelemetry` | host |
| `trace.ts` | M5.1 `Host.trace`: pictures before/after a traced step, element box, URL, network summary | `createTrace(deps)`, `TraceDeps`, `TRACE_AGENT_MS` | host |
| `m3Runtime.ts` | The interface features use to reach the run's CDP session | `M3Runtime` (type) | routes, environment, telemetry |
| `routes.ts` | Route block: CDP `Fetch` interception or `declarativeNetRequest` session rules | `createRoutes(runtime, dnr?)`, `initialiseRoutes(port?)`, `DnrPort` | m3Host, background |
| `environment.ts` | Emulate (CDP `Emulation.*`) and Clear Site Data (`browsingData`) | `createEnvironment(runtime)`, `DEVICE_PRESETS` | m3Host |
| `telemetry.ts` | Console / exception capture, HAR recording, per-step network summary (M5.1) | `createTelemetry(runtime)`, `MAX_CONSOLE_ENTRIES`, `MAX_STEP_CONSOLE_ENTRIES`, `MAX_HAR_ENTRIES`, `MAX_STEP_REQUESTS`, `STEP_SLOWEST` | m3Host |
| `popups.ts` | Tabs opened by pages | `recordPopup`, `waitForPopup` | background, host |
| `screenshots.ts` | Step screenshots, the Screenshot block, trace pictures | `capture`, `take`, `captureForTrace` | host |
| `visual.ts` | M5.3 visual comparison (`Host.visual`): baselines, comparisons, PNG decode/encode, mask placement | `createVisual(deps?)`, `acceptBaseline`, `findComparison`, `getBaseline`, `deleteBaselines`, `decodeImage`, `encodeImage`, `VISUAL_DB`, `Baseline`, `Comparison`, `VisualDeps` | host, background, editor (`VisualComparePanel`) |
| `downloads.ts` | Wait for Download | `waitForDownload`, `readDownloadText` | host |
| `cookies.ts` | Cookies & Storage (cookie jar) | `getCookies`, `setCookie`, `removeCookies` | host |
| `prompts.ts` | Manual Step | `askUser`, `answerPrompt`, `promptRunId`, `clearStalePrompts`, `PendingPrompt` | host, background, editor |
| `debugChannel.ts` | M5.2 debug pauses (`Host.debug`) | `createDebugChannel`, `debugChannel`, `pauseForDebug`, `answerDebug`, `clearStaleDebugPauses`, `highlightRequest`, `DEBUG_PAUSE_KEY`, `PausedRun`, `DebugAction` | host, background, editor (`DebugBanner`) |
| `picking.ts` | Background side of the element picker and the editor's 📸 Snapshot page | `startPicking`, `finishPicking`, `cancelPicking`, `relayPickerSync`, `snapshotForEditor` | background |
| `recording.ts` | Background side of the recorder | `startRecording`, `recordStep`, `onRecordedPopup`, `onRecordedTabUpdated`, `relayRecorderSync`, `stopRecording`, `loadRecording`, `RecordingState` | background, editor (type) |
| `blobStore.ts` | IndexedDB: screenshots, trace pictures, datasets | `saveScreenshot`, `saveTraceImage`, `loadScreenshot`, `traceEvictions`, `readDataset`, `writeDataset`, `listDatasets`, `deleteDataset`, … | host, editor |
| `bridge.ts` | M4 bridge: the native port's lifecycle and the browser side of its methods | `createBridgeConnection`, `backoffMs`, `MAX_RECONNECTS`, `loadBridgeSettings`, `hasNativeMessaging`, `appendBridgeLog`, `writeBridgeStatus`, `bridgeSnapshot`, `connectNativeHost`, `nativeDisconnectReason`, `after` | background |
| `bridgeHandlers.ts` | M4 bridge: every JSON-RPC method, on injected deps (no `browser.*`) | `createBridgeHandlers(deps)`, `withRunOverlay`, `BridgeRpcError`, `BlobCache`, `boundedLog`, `RunWorkflowOptions` | background, tests |
| `bridgeStatus.ts` | The connection state shown on the Settings page | `BRIDGE_STATUS_KEY`, `BridgeStatus` | bridge, editor |
| `stores.ts` | `storage.local` for workflows, logs, runs | `loadWorkflows`, `saveWorkflows`, `appendLog`, `saveRun`, `updateRuns`, … | background, editor |

## host.ts: the `Host`

`createExtensionHost(scheduler: Scheduler): Host` returns:

| `Host` member | Implementation | APIs / permissions |
| --- | --- | --- |
| `sleep(ms)` | `tabs.ts` `sleep` (`setTimeout`) | none |
| `http.fetch(opts)` | `fetch(url, {method, headers, body})`; returns `{status, ok, body, mime?}` with body cut to 200 000 chars. With `responseType: 'base64'`: `body: ''` and the whole body as `base64` (32 KB chunks, up to 20 MB) | host permissions (`<all_urls>`) bypass CORS |
| `http.download(url)` | `fetch` → base64 in 32 KB chunks; `mime` from `content-type`, `name` from the URL path | same |
| `notify({title, message})` | `notifications.create` basic, icon `/icon/128.png` | `notifications` |
| `tabs.open(opts)` | `openTab`: reuse `reuseTabId` if it exists → else navigate the active tab when `newTab` is false → else `windows.create` (`newWindow`) or `tabs.create`. Then `addOwnTab`, `watchNetwork`, and if `waitUntil !== 'none'` sleep 100 ms and `waitForLoad`. | `tabs`, `webRequest` |
| `tabs.navigate(tabId, opts)` | `tabs.update` / `goBack` / `goForward` / `reload`, sleep 100 ms, `waitForLoad`; returns the final URL | `tabs` |
| `tabs.close(tabId)` | `tabs.remove` if it still exists | `tabs` |
| `tabs.info`, `waitForLoad`, `waitForUrl`, `waitForResponse`, `waitForRequest` | `navigation.ts` | `tabs`, `webRequest`; `debugger` for `waitForResponse(…, {captureBody: true})` |
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
| `screenshots.capture(tabId, runId)` | `screenshots.ts`. Firefox: `tabs.captureTab` (any tab, JPEG 60). Chromium: active tab `tabs.captureVisibleTab` (JPEG 60), background tab `captureWithDebugger` (null without the permission). Saved with `saveScreenshot`; returns the id. | `<all_urls>`; Chromium `debugger` for background tabs |
| `screenshots.take(tabId, {runId, area, locator, format, quality, timeoutMs})` | `screenshots.ts`, Screenshot block. Firefox: `tabs.captureTab` with `rect` in document CSS pixels (full page = `{0, 0, pageWidth, pageHeight}`, element = its box + scroll, from the agent's `measure` op). Chromium: visible = `captureVisibleTab` (showing tab) or `Page.captureScreenshot`; full = `Page.getLayoutMetrics` + `captureScreenshot` with `captureBeyondViewport` and a `clip`; element = `measure` box + scroll as `clip`, or, without the debugger on a showing tab, cut out of a `captureVisibleTab` with `OffscreenCanvas`. Sides capped at 16 000 px. Saved like step screenshots; returns `{id, width, height}`. Throws `permission.missing` when Chromium needs the debugger. | `<all_urls>`; Chromium `debugger` (optional) for full page and tabs not showing |
| `cookies.get(url, name?)` / `set(options)` / `remove(url, name?)` | `cookies.ts`: `cookies.getAll({url, name})`, `cookies.set` (`expires` → `expirationDate`, `sameSite` `None` → `no_restriction`), and remove = `getAll` + `cookies.remove({url: scheme://domain+path, name, storeId})` per cookie (clearing a site = without `name`). A refused cookie (Chrome: null, Firefox: throws) → `step.failed`. Without the permission → `permission.missing`. | `cookies` (optional; granted in e2e builds) |
| `prompt.ask` | `prompts.askUser` | `notifications`, `storage` |
| `debug.pause(info)` | `debugChannel.pauseForDebug` (M5.2, [below](#debugchannelts-m52)); run-scoped hosts inherit it | `storage` (session), `scripting` (highlight) |
| `visual.compare(request)` | `visual.ts` `createVisual()` (M5.3, [below](#visualts-m53)); run-scoped hosts inherit it | IndexedDB; `scripting` (mask `box` ops) |
| `datasets.read/write` | `blobStore` | IndexedDB, `unlimitedStorage` |
| `downloads.save(filename, content, mime)` | `downloads.download` with a `blob:` URL where `URL.createObjectURL` exists (Firefox), else a `data:` URL (Chrome's worker). `conflictAction: 'uniquify'`; `\ / : * ? " < > |` in names become `-`. | `downloads` |
| `downloads.waitFor(pattern, lookBackMs, timeoutMs)` | `downloads.ts`: polls `downloads.search({startedAfter: now - lookBackMs})` every 250 ms for an unclaimed download that is not BlockFlow's own (`byExtensionId`, or a `blob:` URL of the extension's origin) whose URL, final URL or file name matches `pattern`; claims it (`storage.session` `bf:downloads-claimed`), then polls until `state: complete` (`interrupted` → `download.failed`). Returns `{downloadId, url, filename, path, size, mime}`. The browser's own download list is the look-back, so nothing is recorded while the worker sleeps and no listener is needed. | `downloads` |
| `downloads.readText(download, tabId?)` | `downloads.ts`: extensions cannot read files on disk, so the content is fetched again: `data:` decoded, http(s) `fetch` from the background with cookies, `blob:` fetched in the tab by `executeScript` (only while the page still holds it). Cut to 2 000 000 chars. Errors → `download.failed`. | host permissions, `scripting` |
| `html.act` | `htmlParse.actOnHtml` | `offscreen` (Chrome) |
| `forRun(runId)` / `finishRun(runId)` | `m3Host.createRunHost` (below), plus the run id injected into `page.act` and response-body waits | see below |
| `network.route` / `har` / `console`, `environment.emulate` / `clearSiteData` | Outside a run: throw `config.invalid` ("… can only be used inside a run"). Inside one: the run's feature set from `createRunHost` | `debugger`, `declarativeNetRequest`, `browsingData` |
| `diagnostics.beginStep` / `finishStep` | Only on the run-scoped Host: per-step console frames from `telemetry.ts` | `debugger` (passive) |
| `trace.before` / `trace.after` | Only on the run-scoped Host: `createTrace` in `trace.ts` (below) | `<all_urls>`; never attaches `debugger` |
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
| `watchNetwork(tabId)` | Per-tab in-memory logs (last 300 completed/failed responses: url, status, method, time; last 300 sent requests with their bodies). Listeners filtered by tab so normal browsing never wakes the worker; removed on `tabs.onRemoved`. Lost on worker restart. |
| `statusMatches(status, wanted)` | `""` any, `"200"`, `"2xx"`, `"200,201"`. |
| `waitForResponse(tabId, pattern, status, lookBackMs, timeoutMs, {method, captureBody})` | Starts `watchNetwork` if needed, then polls the log every 150 ms for an unused entry since `now - lookBackMs` (and `methodMatches`). Matched entries are marked `used`. Timeout message lists statuses seen for that URL. With `captureBody`: `waitForResponseBody` attaches the debugger, `Network.enable`, follows `requestWillBeSent` / `responseReceived` / `loadingFinished` events of the tab for the first match, then `Network.getResponseBody` (`body`, or `bodyBase64` for binary; 200 000 chars). No look-back there: bodies exist only for requests seen while attached. Without the debugger (Firefox) → `permission.missing`. |
| `waitForRequest(tabId, pattern, method, lookBackMs, timeoutMs)` | Same as `waitForResponse` on the request log (`webRequest.onBeforeRequest` with `requestBody`): `{url, method, type, postData}`; `postData` is the raw body as UTF-8 or form fields URL-encoded, 200 000 chars. |
| `methodMatches(method, wanted)` | `""` any, `"POST"`, `"get,post"` (case-insensitive). |

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
| `vanished` | for actions (`click`, `fill`, `set-field`, `select`, `check`, `press`, `drag`, and `focus`, `blur`, `clear`, `dispatch`: the `ONCE` set) return `{navigated: true}` (never repeat: it might submit twice); otherwise retry |
| executeScript threw | tab gone → "The tab was closed" (`tab.closed`); restricted page (`chrome://`, web store, missing host permission) → "The browser does not let extensions work on this page" (`page.restricted`, or `permission.missing` when the message is about a permission); else retry ("the page was busy loading") |

4. Past the deadline: `CodedError` `Timed out after Ns: <last reason>`, with the last pending answer's code
   (`locator.not-found`, `element.covered`…; `frame.unreachable` while a cross-origin frame never showed up,
   `navigation.failed` while the page was busy loading, else `timeout`). Between non-pending outcomes it
   sleeps 250 ms. See [Page Protocol: Error codes](Page-Protocol.md#error-codes).

`actWithRealInput` (when `options.realInput` and the op is an action): asks the agent to `locate` the
element (same auto-wait, returns `x`, `y` in the tab's viewport, frame offsets included, and `kind`), then drives it with `cdp.ts`:
click/hover/right/double via `mouseClick` (with the request's `button`, `modifiers`, `clickCount`; `position`
is passed to `locate`), fill via `typeInto`, check reads the state first and only clicks if it differs, press
clicks then `pressKey`, drag locates the target too (`purpose: 'drop'`, `toPosition`) and calls `mouseDrag`. `select` and non-text `set-field` fall back to the agent. A
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
| `hasDebugger()` | Checks that the API exists and `permissions.contains({permissions: ['debugger']})`, false on error. |
| `withDebugger(tabId, fn, runId?)` | Attach with protocol `1.3` and execute `fn(send)`. With a run id, retain one lease per tab until run cleanup. Without one, release the lease in `finally`. Concurrent owners share an attachment; only its last owner detaches it. Refuse attachments already owned by something else. |
| `mouseClick(send, x, y, {button, clicks, hoverOnly, modifiers})` | `Input.dispatchMouseEvent` move, then press/release per click (`clickCount` counts up, `buttons` set). `button`: left, middle, right; `modifiers` (Playwright names) become the CDP bit mask (`modifierMask`). |
| `mouseDrag(tabId, from, to, {modifiers, runId?})` | A real drag, the way Playwright does it: move to `from`, press, `Input.setInterceptDrags({enabled: true})`, then 5 moves with the left button held. After each early move it waits up to 150 ms for `Input.dragIntercepted` (subscribed through the session manager): when the page started a native HTML5 drag, the rest is `Input.dispatchDragEvent` dragEnter/dragOver, then `drop` at `to` (Chrome sends dragend; no mouse release). Without one, it is a plain pointer drag ending in `mouseReleased`. Returns `'html5'` or `'pointer'`. |
| `pressKey(send, combo)` | `"Control+a"`, `"Shift+Tab"`, `"Enter"`, `"Control+Shift+K"`, `"ControlOrMeta+A"` (Meta on a Mac), single characters. Modifier bits alt 1, ctrl 2, meta 4, shift 8. The modifier keys get their own `rawKeyDown` first and `keyUp` last (each with the bits held so far). Shift uppercases a letter. Sends `text` only without non-shift modifiers. |
| `insertText(send, text)` | `Input.insertText` (Press Key `mode: "text"`; with a locator the driver clicks the element first). |
| `typeInto(send, x, y, text)` | Click, Ctrl+A (`commands: ['selectAll']`), then `Input.insertText` (or Backspace for empty). |
| `captureWithDebugger(tabId, runId?)` | `Page.captureScreenshot` JPEG 60, raced against 4 s (background tabs may not paint); null without permission. |

`withDebugger` is also used by `screenshots.ts` (full page, element clips) and `navigation.ts` (response
bodies). These share the run's attachment with real input. `host.ts` implements optional `Host.forRun`
and `Host.finishRun`; the engine invokes them before running blocks and before publishing the terminal
record. The scoped Host injects the run id into page driver and response-body calls. Screenshots already
carry it in their options. Child runs get separate leases, so child cleanup cannot detach its parent.

`cdpSessions.ts` is the injectable, tested ownership state machine. It serialises attach/detach per tab,
deduplicates default domain enables (`Network.enable` etc.) and invalidates closed sessions. A finished
run cannot acquire another lease or send through a retained callback. A failed attach is never treated
as permission to borrow someone else's debugger.

`initialiseDebuggerSessions` runs synchronously inside `defineBackground`. It installs tab/permission
listeners and one debugger event/detach listener, multiplexed by tab. When the optional debugger API is
absent at startup, the synchronous permission listener installs its API listeners when granted. Removing
the permission invalidates existing connections. Per-operation event subscriptions (drag interception,
response bodies) are local to the manager and removed in `finally`, rather than adding browser listeners.
API-initiated detach may have no `onDetach` event: a "Debugger is not attached" transport error also
invalidates ownership. Closing a tab during cleanup is benign; other cleanup errors are surfaced.

The final record has `usedDebugger: true` after a successful acquisition; HTML and the Reports view
label it. Firefox still returns `permission.missing` for debugger features and ordinary runs never attach.
Response body capture still listens only from the Wait For call (no historical response-body lookup).

`startDebuggerRun(runId, setup?)` takes an optional per-tab setup callback: the first time a run's
`withDebugger` callback reaches a tab, `setup(tabId, send)` runs (once per tab, retried if it failed)
before `fn`. `m3Host.ts` passes `telemetry.attach`, so any CDP use in a run also starts console capture.

## m3Host.ts: per-run network, environment and console

`host.ts`'s `forRun` calls `createRunHost(host, runId)`, which builds one feature set per run, all sharing
the run's CDP session through an `M3Runtime` (`m3Runtime.ts`):

| `M3Runtime` member | Meaning |
| --- | --- |
| `withTab(tabId, fn)` | `withDebugger(tabId, fn, runId)`; rejects once the run is closing |
| `cleanupTab(tabId, fn)` | same, allowed while closing (resetting overrides) |
| `subscribe(tabId, listener)` | `onDebuggerEvent` (the session manager's multiplexer; no new browser listeners) |
| `isClosed()` | true once `finishRun` started; checked in delayed callbacks |
| `claim(tabId, 'route' \| 'emulation')` | module-level `claims` map: a tab's mutable overrides belong to one run. Another run's claim → `config.invalid` "Another run owns network/emulation overrides for this tab. Finish that run before changing …" |

`finishRun` (memoised, idempotent) marks the run closing, runs `routes.finish()`, `environment.finish()`
and `telemetry.finish()` with `Promise.allSettled`, then `finishDebuggerRun(runId)`; in `finally` it drops
the run's claims. The first feature cleanup error is rethrown after the debugger is released, so failed
and stopped runs are cleaned up too. HAR and console capture are passive and do not claim the tab.

### trace.ts (M5.1)

`createTrace(deps)` → `Host.trace`, wired by `forRun` in `host.ts` with `captureForTrace`, `saveTraceImage`,
`act` and the run's `traceTelemetry`. The engine awaits it around a traced step (run option `trace` or step
setting `trace`) with `TraceStepInfo` (`tabId` from the step input's session tab, raw `locator` setting).
Without `tabId` both hooks answer `undefined`.

- `before`: starts the step's network window (`telemetry.beginStepNetwork`), then a picture of the tab.
- `after`: `box` (page op, `TRACE_AGENT_MS` = 1.5 s) and, when the box
  has a size, `measure` for the viewport size; a picture; the tab URL (`tabInfo`); then closes the network window (last, so CDP events that arrive just after the block returned still count). Returns only the parts it
  got (`after`, `box`, `viewport`, `url`, `network`).
- Every part is wrapped: a failure leaves that part out; nothing throws into the step.
- `captureForTrace(tabId, runId, useDebugger)` (screenshots.ts): Firefox `captureTab`; Chromium
  `captureVisibleTab` when the tab is showing, spaced at least 550 ms apart (Chrome allows two calls a
  second); a background tab only through `captureWithDebugger` when `useDebugger` (the run already has a
  session on the tab, `telemetry.hasSession`). Never attaches the debugger for tracing.
- Pictures go to `saveTraceImage` (blobStore, limits below).

### routes.ts

`createRoutes(runtime, dnr?)` → `{apply(tabId, options), finish()}`. Calls per tab are serialised. Rules
come through `parseRouteRules` (from `src/core/blocks/route.ts`, so the browser boundary validates too); a
tab holds at most `MAX_ROUTE_RULES` (100). The newest matching rule wins (`url` with `urlMatches`, optional
`method`). Backend `auto` picks `dnr` when every rule is `abort`/`redirect` without `delayMs`
(`dnrCompatible`), else `cdp`; a tab keeps its first backend until cleared (switching → `config.invalid`).

| Backend | How |
| --- | --- |
| `cdp` | `Fetch.enable` with `{urlPattern: '*', requestStage: 'Request'}` and a `Fetch.requestPaused` subscription. No match / `continue` → `Fetch.continueRequest`; `abort` → `Fetch.failRequest` `BlockedByClient`; `redirect` → `continueRequest` with `url`; `fulfill` → `Fetch.fulfillRequest` (status default 200, `Content-Type: text/plain; charset=utf-8` unless overridden, base64 body); `modify` → `continueRequest` with merged headers / `postData` (`content-length` dropped when the body changes). `delayMs` (≤ 30 000) waits before answering. At most 256 paused requests. An interception error fails the request (never sends an intended mock to the real server). |
| `dnr` | `declarativeNetRequest.updateSessionRules` with ids from the reserved range 1 000 000–1 099 999, `condition.tabIds: [tabId]`, a `regexFilter` built from the glob (or a `/regex/` with only the `i` flag), checked with `isRegexSupported`; `abort` → `block`, `redirect` → `redirect`. Needs the optional `declarativeNetRequest` permission (`permission.missing` otherwise). Works on Firefox. |

Clearing (the `clear` action or run end) aborts still-paused CDP requests before `Fetch.disable` (disable
would let them through) or removes the tab's DNR rule ids. `initialiseRoutes()` runs from
`defineBackground` (not awaited) and removes stale rules in the reserved range: a worker restart ends old
runs without their cleanup.

### environment.ts

`createEnvironment(runtime)` → `{emulate(tabId, options), clearSiteData(options), finish()}`.

- `emulate` re-checks the options, claims the tab (`'emulation'`), resets this run's earlier overrides on
  that tab, then applies: `Emulation.setDeviceMetricsOverride` (preset or width/height; missing size from
  `Page.getLayoutMetrics`) and `setTouchEmulationEnabled` for presets, `setUserAgentOverride` (preset UA and
  `platform`, `acceptLanguage` from the locale), `setLocaleOverride`, `setTimezoneOverride`,
  `setGeolocationOverride` (does not grant the geolocation permission), `setEmulatedMedia` features
  (`prefers-color-scheme`, `prefers-reduced-motion`) and `Network.emulateNetworkConditions` for offline.
  Presets (`DEVICE_PRESETS`): iphone 390×844 @3, pixel 412×915 @2.625, ipad 820×1180 @2, desktop 1440×900 @1.
  A failure part-way rolls back what was applied.
- Resets touch only the groups this run changed (metrics, touch, ua, locale, timezone, geo, media,
  network). `action: 'clear'` and `finish()` reset; a detached/closed tab counts as reset. No
  `Browser.grantPermissions` or other profile-wide changes.
- `clearSiteData` re-parses origins with `parseSiteOrigins`, then `browsingData.remove({origins, since: 0},
  {cookies, localStorage, indexedDB, cacheStorage, serviceWorkers})`. On Firefox (detected by
  `runtime.getBrowserInfo`) or without the `browsingData` permission it throws `permission.missing` and
  clears nothing: it never falls back to an unfiltered removal. Chromium's cookie removal by origin covers
  the whole registrable domain.

### telemetry.ts

`createTelemetry(runtime)` → `{attach, har, console, beginStep, finishStep, finish}`.

- `attach(tabId, send)` (the `startDebuggerRun` setup hook) subscribes once per tab and sends
  `Runtime.enable`. `Runtime.consoleAPICalled` and `Runtime.exceptionThrown` become `ConsoleEntry`
  (`level`: `warning` → `warn`, `assert` and exceptions → `error`; text ≤ 2000 chars from ≤ 16 args; URL
  sanitised). Entries older than the run's start (replayed by `Runtime.enable`) are dropped. Per tab the
  last `MAX_CONSOLE_ENTRIES` (200) are kept; the current step frame keeps up to
  `MAX_STEP_CONSOLE_ENTRIES` (50), handed to the engine by `finishStep`.
- `console(tabId)` returns a copy of the tab's entries for this run (attaching first if needed), used by
  Assert `console-errors`. Capture only starts once the run has used the debugger on that tab.
- `har(tabId, 'start')` sends `Network.enable` and records `Network.requestWillBeSent` /
  `responseReceived` / `loadingFinished` / `loadingFailed`; `'stop'` returns a HAR 1.2 log of at most
  `MAX_HAR_ENTRIES` (500, `truncated: true` past it). Metadata only: headers, cookies and bodies are empty;
  URL credentials and fragments are removed and query values whose names look secret (`token`, `password`,
  `authorization`, `secret`, `session`, `api_key`, `access_key`) become `[redacted]`. Only http(s) requests.
- M5.1: `hasSession(tabId)` is true once `attach` finished for the tab (the run already uses CDP there).
  `beginStepNetwork(tabId, nodeId)` does nothing (false) without a session; with one it sends `Network.enable`
  on that session and counts the tab's requests for that step (several steps may watch one tab).
  `finishStepNetwork(tabId, nodeId)` → `{requests, failed, slowest?}`: failed = `loadingFailed` or status
  ≥ 400; `slowest` the `STEP_SLOWEST` (3) longest finished ones `{url, method, status?, ms}` (sanitised URL);
  at most `MAX_STEP_REQUESTS` (500) counted.
- `finish()` unsubscribes and drops all buffers; it never disables shared CDP domains.

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

## debugChannel.ts (M5.2)

`Host.debug.pause(info: DebugPause)` resolves `'continue' | 'step' | 'stop'`; the engine awaits it in a debug
run before a step with `pause`, before every step after Step, and before a failure is handled with `pauseOnError`.
Built by `createDebugChannel(deps)` (deps injected for tests: storage read/write, highlight, keep-alive, sleep, clock).

| Function | Behaviour |
| --- | --- |
| `pauseForDebug(info)` | Adds a `PausedRun` (`info` + `workflowName` from `bf:workflows`, `pausedAt`) to storage.session `bf:debug-pause` (serialised read-modify-write), outlines `info.locator` in `info.tabId` with the page op `highlight` (skipped without a tab or with a `{{…}}` locator; failures ignored), then polls the in-memory answer every `POLL_MS` (500 ms), calling `runtime.getPlatformInfo()` each loop so the MV3 worker is not stopped (the background's `scheduler.hold('run:<id>')` for live runs does too). After `MAX_PAUSE_MS` (1 h) it answers `stop` and logs a warning. Always removes the entry and clears the highlight. |
| `answerDebug(runId, action)` | Sets the answer if that run is paused in *this* worker and not yet answered; returns whether it did. From `bf:debug-answer`, and `stop` from `cancelRun` (Stop). |
| `clearStaleDebugPauses()` | Removes listed pauses whose run is not waiting in this worker (worker start). |
| `highlightRequest(locator, clear)` | The `highlight` page request (`{op, locator, label}` / `{op, locator, clear: true}`), in one place. |

Editor reopen: the banner reads `bf:debug-pause` when it mounts and follows `storage.onChanged` (area `session`),
so a pause made while no editor was open is shown when one opens.

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
| `screenshots` | `id` | `Screenshot {id, runId, ts, dataUrl}` | newest 150 kept (pruned on save); trace pictures (`~t|…` ids) separately, see below |
| `datasets` | `name` | `Dataset {name, rows, updatedAt}` | `unlimitedStorage` |

Helpers: `openDb()` (cached promise, reset on failure), `done(request)`, `store(name, mode)`. Data functions:
`saveScreenshot`, `loadScreenshot`, `readDataset`, `writeDataset(name, rows,
'append' | 'replace') → row count`, `listDatasets`, `deleteDataset`.

M5.1 trace pictures share the `screenshots` store under ids `~t|<ts base36>|<runId>|<bytes>|<random>`
(`traceKey` / `parseTraceKey`). `~` sorts after every UUID, so `saveScreenshot` prunes only regular
screenshots (`getAll(IDBKeyRange.upperBound('~t|', true))`) and trace pruning reads keys only
(`getAllKeys`). `saveTraceImage(runId, dataUrl, random)` returns null (stores nothing) once the run has
`MAX_TRACE_IMAGES_PER_RUN` (200) pictures; after storing, `traceEvictions` removes whole runs' pictures,
oldest run first and never the current run, until at most `MAX_TRACE_IMAGES` (1 000) and `MAX_TRACE_BYTES`
(120 MB of data URL) remain. `loadScreenshot` reads both kinds.

## visual.ts (M5.3)

`Host.visual.compare(request)` for the Screenshot block's `compare` (request/result types in
[src/core/visual.ts](../../src/core/visual.ts)). The block has already taken and stored the screenshot; this:

1. Loads it (`loadScreenshot`) and decodes it: `fetch(dataUrl).blob()` → `createImageBitmap(blob,
   {colorSpaceConversion: 'none', premultiplyAlpha: 'none'})` → `OffscreenCanvas` `getImageData`. Both exist in
   Chrome's service worker and Firefox's background page (verified in both).
2. No baseline for `"<workflowId>/<nodeId>"`, or `updateBaseline`: stores this picture as the baseline →
   `baseline-saved` / `baseline-updated`.
3. Otherwise places the masks: one `measure` (scroll, `devicePixelRatio` = scale), then the agent's `box` op
   (no waiting, no scrolling, so the page is not moved after the capture) per mask locator and each further
   match (`>> nth=i`, up to 20). Origin of the picture: the viewport (`visible`), the document (`full`: box +
   scroll), or the screenshot's own element (`element`). Rectangles are CSS pixels × scale. Missing elements
   are reported as `missingMasks` (the block logs a warning).
4. Another size → `mismatch` with `baselineSize`, no pixel diff. Else `pixelDiff` (src/core/pixelDiff.ts);
   ratio ≤ `maxDiffRatio` → `match`; above → `mismatch`, and the baseline as compared and the diff picture
   (`encodeImage`: `putImageData` → `convertToBlob('image/png')`) are saved as screenshots (`saveScreenshot`).
5. Every compare writes a `Comparison` record. The block throws `visual.mismatch` for a mismatch.

`acceptBaseline(comparisonId)` (background, `bf:accept-baseline`) makes the comparison's actual picture the
baseline and sets `acceptedAt`. `findComparison(step)` (editor) finds a step's comparison: by
`output.visual.comparisonId` when it passed, else by node id and the step's time window (a failed step has no
output). All storage functions take injectable `VisualDeps` for tests/browser/visual.test.ts.

Database `blockflow-visual` (version 1, separate from `blockflow` so its upgrades never race):

| Store | keyPath | Record | Limits |
| --- | --- | --- | --- |
| `baselines` | `key` = `"<workflowId>/<nodeId>"` | `Baseline {key, workflowId, nodeId, dataUrl, width, height, updatedAt, runId}` | not pruned; `deleteBaselines(workflowId)` |
| `comparisons` | `id`, index `nodeId` | `Comparison {id, runId, workflowId, nodeId, ts, status, width, height, diffPixels, diffRatio, threshold, maxDiffRatio, actualId, baselineId?, diffId?, baselineSize?, acceptedAt?}` | newest 300 kept |

## bridge.ts and bridgeHandlers.ts (M4 outside access)

The extension end of the protocol in `src/core/bridgeProtocol.ts` (the native host is [Bridge](Bridge.md)).
While `bf:settings.outsideControl` is on and `nativeMessaging` is granted, the worker keeps one
`runtime.connectNative('dev.akibh.blockflow')` port open; an open native port also keeps the MV3 worker alive.

`createBridgeConnection(deps)`: `enable()` opens the port (state `connecting`, `connected` after 1 s open or
the first message); requests (`{id, method, params}`) go to `deps.respond`, whose notifications and answer
are posted back on the same port. A close while on → `waiting` and a reconnect after 1, 2, 4 … 30 s; after
`MAX_RECONNECTS` (5) closes in a row (host not installed, or it exits at once with code 3 because another
browser's host owns the socket) → `failed`, with the browser's reason in `error`; switching off and on retries.
`disable()` posts `bridge.disabled` (the host closes its clients) and disconnects. Every change is written to
`bf:bridge-status` (storage.session). Its timers use `after` (`setTimeout`), which is not workflow timing.

`createBridgeHandlers(deps).respond(request, notify)` never throws: it refuses everything with `disabled`
while outside control is off, maps a `BridgeRpcError` (or `CodedError('config.invalid')` → `invalidWorkflow`,
any other error → `internal` with `data.code`) to an `RpcFailure`, and logs `{at, method, ok, detail}` via
`deps.appendLog` (bounded `bf:bridge-log`; no params, payloads or secrets).

| Method | What it does |
| --- | --- |
| `hello` | `version` error unless `protocol` is `BRIDGE_PROTOCOL_VERSION`; returns version, `import.meta.env.BROWSER`, `runtime.id`. |
| `validate` | `parseImport` (script or graph, JSON text or parsed) against the saved workflows and secret names; `{ok, issues, workflows: [{name, nodes}]}`. Saves nothing. |
| `import` | Same, then saves with `importedVia: 'bridge'` (disabled, fresh ids). `replace: true` replaces a bridge workflow of the same name in place, keeping its id (never a workflow the user made). Invalid → `invalidWorkflow` with `data.issues`. |
| `list` | `{id, name, enabled, viaBridge?}` per workflow. |
| `run` | A saved `workflowId` or the first workflow of an inline `source` (its others go along unsaved for Run Workflow). Calls the worker's `runWorkflow(wf, {secrets, workflows, onRun})`; sends `run.started` and a `run.step` per step status change of the top run, with the request's id. `timeoutSeconds` → `cancelRun` (the Stop path); the answer's `error` becomes "Timed out after N s"; a run still busy 15 s later is answered with its latest copy. |
| `report` | Stored runs by `runIds` / `workflowId` / `limit` (default last 50) → `toJsonReport` / `toJUnitXml` / `toHtmlReport` (screenshots embedded). |
| `snapshot` | `bridgeSnapshot`: the `snapshot` page op on `tabId`, or on `url` opened in a background tab (own tab, closed after); `outline` is `snapshotDocument(result)`. |
| `stop` | `cancelRun` for a live run (`stopped: true`); `false` for a finished one; `notFound` otherwise. |
| `blob.get` | Chunks of `BLOB_CHUNK_BYTES`, base64. Results whose JSON is over `INLINE_RESULT_BYTES` (`run`, `report`, `snapshot`, `suite.run`) come back as `{blobId, size}`; `screenshot:<id>` reads a step screenshot from IndexedDB (`mime` set). |
| `suite.list` / `suite.run` | `loadSuites` / `runSuite` (`suites.ts`) with `runWorkflow` streaming `run.*` and `onProgress` → `suite.progress`. |

`withRunOverlay(host, {secrets, workflows})` wraps a Host for one run (`Object.create`, so class hosts keep
their methods): `secrets.all()` returns stored secrets plus the overlay (so the engine uses and masks them),
`workflows.get` also finds unsaved ones, and `forRun` hosts get the same overlay. Nothing is written.

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
| Screenshot block | visible: `captureVisibleTab` (showing tab); full page, background tabs: `debugger`; element: `debugger`, or cut from the visible area | `tabs.captureTab` with `rect`: all areas, any tab, no extra permission | not verified |
| Response bodies (Wait For `captureBody`) | `debugger` | not available (`permission.missing`) | not available |
| Route, `cdp` backend; Emulate; HAR Record; Assert `console-errors` | `debugger` | not available (`permission.missing`) | not available |
| Route, `dnr` backend (block / redirect) | optional `declarativeNetRequest`, session rules | optional `declarativeNetRequest` (e2e verified) | not verified |
| Clear Site Data (`browsingData` by origin) | optional `browsingData` | refused (`permission.missing`): no exact-origin filter | not verified |
| Cookies (`cookies` API) | optional permission | optional permission | not verified |
| Wait for Download | `downloads.search`; `byExtensionId` filters our own | same (own = `blob:moz-extension://…`) | not verified |
| Run Script (`userScripts.execute`) | Chrome 135+, optional permission + toggle | not available | not available |
| Drag, drop zones (synthetic) | `new DataTransfer()` + `DragEvent` | same; CustomEvent `detail` objects go through `cloneInto` | not verified |
| Host access | granted at install | must be granted in `about:addons` (README) | not verified |
| `storage.session`, `webNavigation.onCreatedNavigationTarget` | yes | yes | not verified |
| Bridge (`nativeMessaging`, M4) | optional permission; host manifest per browser (`blockflow-bridge install`); e2e verified (Chromium) | optional permission, manifest with `allowed_extensions`; not verified | not available |

## Gotchas

- `executeScript` with `func` serialises the function: it must not close over anything.
- Chrome sorts object keys of `executeScript` results; the agent returns tables as `{columns, values}`.
- Under Playwright (e2e), Chromium saves downloads under GUID file names: `download.filename` is then
  that GUID; a normal browser keeps the real name (the Firefox e2e checks it).
- `watchNetwork` logs and the `answers` map are in memory: a worker restart loses them (a run in progress
  keeps the worker alive, so this only matters after a crash).
- `bf:state:*` entries of a block are kept when only that block is removed (they go with the workflow).

## See also

- [Background Worker](Background-Worker.md), [Scheduling and Timers](Scheduling-and-Timers.md)
- [Page Protocol](Page-Protocol.md), [Page Agent](Page-Agent.md), [Locators](Locators.md)
- [Storage Keys](Storage-Keys.md), [Message Protocol](Message-Protocol.md)
- [Core Engine](Core-Engine.md) for the `Host` interface's callers
