# Message Protocol

Every `runtime` message that travels between the editor, the background worker, content scripts and the
offscreen document, plus the non-message channels (storage, `executeScript` calls into page globals) that
carry the rest. Read this when you add a message or need to know who answers what.

**Source:** [messages.ts](../../src/shared/messages.ts), and the senders/receivers:
[background.ts](../../src/entrypoints/background.ts), [picking.ts](../../src/browser/picking.ts),
[htmlParse.ts](../../src/browser/htmlParse.ts), [offscreen/main.ts](../../src/entrypoints/offscreen/main.ts),
[picker.content.ts](../../src/entrypoints/picker.content.ts),
[recorder.content.ts](../../src/entrypoints/recorder.content.ts),
[Editor.tsx](../../src/entrypoints/editor/Editor.tsx),
[ConfigPanel.tsx](../../src/entrypoints/editor/components/ConfigPanel.tsx),
[PromptBanner.tsx](../../src/entrypoints/editor/components/PromptBanner.tsx)

## Design in one paragraph

Messages are **commands and one-shot replies only**. Nothing the user needs to see later travels as a
message: run progress, logs, prompts and recordings go through `storage.local` (the editor subscribes with
`storage.onChanged`), and starting/stopping workflows is done by saving `bf:workflows`. That keeps the
editor working even when the worker was asleep or restarted. All messages use `browser.runtime.sendMessage`
(a broadcast to every extension page and the worker; content scripts send this way too). There are no
`tabs.sendMessage`, ports or `window.postMessage` channels.

## Typed messages (`ExtensionMessage`)

`isExtensionMessage(value)` accepts an object whose `type` is in the `TYPES` set; it does not validate the
rest. Every listener calls it first.

| `type` | Interface | Sender | Receiver | Payload | Response |
| --- | --- | --- | --- | --- | --- |
| `bf:start-pick` | `StartPickMessage` | Editor (`ConfigPanel.startPick`) | Background → `startPicking(sender.tab.id, url, mode, urlFrom)` | `url?: string` page to pick on; `urlFrom?: 'block' \| 'upstream'` (the block's own URL, or the nearest Open Tab's); `mode?: 'watch' \| 'action' \| 'form'` | none; later `bf:pick-result` or `bf:pick-error` |
| `bf:picked` | `PickedMessage` | Picker content script (`onPick`) | Background → `finishPicking(msg, sender.tab.id)` | `selector`, `candidates?: string[]`, `url`, `sample` | none |
| `bf:pick-cancelled` | `PickCancelledMessage` | Picker content script (`onCancel`, Esc) | Background → `cancelPicking()` | none | none (the editor is not told) |
| `bf:pick-result` | `PickResultMessage` | Background (`finishPicking`) | Editor (`ConfigPanel` listener) | `selector`, `candidates?` (best first), `url`, `sample`, `fields?: FormFieldRow[]` (form mode) | n/a |
| `bf:pick-error` | `PickErrorMessage` | Background (`startPicking`, `finishPicking`) | Editor (`ConfigPanel`) | `message` | n/a |
| `bf:run-workflow` | `RunWorkflowMessage` | Editor Run button | Background → `newRunner(workflow).runOnce()` | `workflow: Workflow` (the canvas as is, saved or not) | none; progress via `bf:runs` |
| `bf:stop-run` | `StopRunMessage` | Editor Stop button | Background → `cancelRequests.add`, `answerPrompt(runId, false)` | `runId` | none |
| `bf:answer-prompt` | `AnswerPromptMessage` | Editor `PromptBanner` | Background → `answerPrompt(runId, ok)` | `runId`, `ok` (true = Continue) | none |
| `bf:start-recording` | `StartRecordingMessage` | Editor Record button | Background → `startRecording(workflowId, url)` | `workflowId`, `url` | none; state via `bf:recording` |
| `bf:stop-recording` | `StopRecordingMessage` | Editor (Stop in the recording bar) **or** recorder toolbar in the page (`onStop`) | Background → `stopRecording()` | none | none |
| `bf:recorded` | `RecordedMessage` | Recorder content script (`onStep`, any frame; locators already `frame=…`-prefixed) | Background → `recordStep(step, sender.tab.id)` | `step: RecordedStep` | none |
| `bf:picker-sync` | `PickerSyncMessage` | Picker content script, any frame | Background → `relayPickerSync`: `tabs.sendMessage` to every frame of the sender's tab | `sync: PickerSync` (`locked` / `state` / `command`) | none |
| `bf:recorder-sync` | `RecorderSyncMessage` | Recorder content script, any frame | Background → `relayRecorderSync`: to every frame of the sender's tab | `mode: 'record' \| 'assert-text' \| 'assert-visible'` | none |
| `bf:snapshot-page` | `SnapshotPageMessage` | Editor (`SnapshotButton`, 📸 Snapshot page on Open Tab) | Background → `snapshotForEditor(sender.tab.id, url)` in `picking.ts`: opens or reuses the editor's picker tab like `bf:start-pick` (or the last-used web tab without a URL), runs the `snapshot` page op, focuses the editor again | `url?: string` (the block's URL, when it has no `{{…}}`) | none; later `bf:snapshot-result` |
| `bf:snapshot-result` | `SnapshotResultMessage` | Background (`snapshotForEditor`) | Editor (`SnapshotButton` listener; acts only while it is waiting) | `text?` (`snapshotDocument(result)`: title, URL, outline), `lines?`, `truncated?`, or `error?` | n/a |

Notes:

- The background's `onMessage` listener never returns `true` or calls `sendResponse`; every typed message
  is fire-and-forget. Senders `.catch` the promise only to detect "worker unreachable" (the editor shows
  "Could not reach the background worker").
- `sender.tab?.id` matters: it identifies the editor tab for `bf:start-pick` (to return to it later), the
  picked tab for `bf:picked` (form detection runs there), and filters `bf:recorded` to the recording tab and its popups.
- `bf:pick-result` / `bf:pick-error` are broadcasts: every open editor tab's `ConfigPanel` receives them, but
  only one with a pending pick (`pending.current`) acts.

## Ad-hoc message (not in `messages.ts`)

| `type` | Sender | Receiver | Payload | Response |
| --- | --- | --- | --- | --- |
| `bf:parse-html` | Background (`actOnHtml`, Chrome only) | Offscreen document (`offscreen/main.ts`) | `html: string`, `baseUrl: string`, `request: AgentRequest` | `{ok: true, result: Record<string, unknown>}` or `{ok: false, error: string}`; listener returns `true` (async) |

It is deliberately outside `ExtensionMessage`: the background and editor ignore it because
`isExtensionMessage` returns false, and the offscreen document ignores everything else.

## Flows

```text
Pick:    editor ──bf:start-pick──▶ bg ──executeScript(picker.js)──▶ page
         page ──bf:picked / bf:pick-cancelled──▶ bg ──bf:pick-result / bf:pick-error──▶ editor
Snapshot: editor ──bf:snapshot-page──▶ bg ──agent snapshot op──▶ page; bg ──bf:snapshot-result──▶ editor (clipboard)
Run:     editor ──bf:run-workflow──▶ bg          bg ──storage bf:runs, bf:logs──▶ editor
Stop:    editor ──bf:stop-run──▶ bg
Prompt:  bg ──storage bf:prompts + notification──▶ user/editor ──bf:answer-prompt / notification click──▶ bg
Record:  editor ──bf:start-recording──▶ bg ──executeScript(recorder.js)──▶ page
         page ──bf:recorded / bf:stop-recording──▶ bg ──storage bf:recording──▶ editor
Parse:   bg ──bf:parse-html──▶ offscreen ──sendResponse──▶ bg
```

## Non-message channels

| Channel | Between | Used for |
| --- | --- | --- |
| `storage.local` + `storage.onChanged` | worker ↔ editor | workflows (editor → worker), runs, logs, prompts, recording, secrets. See [Storage Keys](Storage-Keys.md). |
| `scripting.executeScript({func})` calling `globalThis.__blockflowAgent.run(call)` | worker → page agent | every page block ([Page Protocol](Page-Protocol.md), [Page Agent](Page-Agent.md)) |
| `executeScript({files})` | worker → page | injecting `agent.js`, `picker.js`, `recorder.js` (content scripts with `registration: 'runtime'`) |
| `executeScript` calling `__blockflowRecorder.stop()` | worker → page | ending a recording |
| `executeScript({world: 'MAIN'})` on `window.__blockflowDialogs` | worker → page main world | Dialogs block |
| `userScripts.execute` | worker → page | Run Script |
| `chrome.debugger.sendCommand` | worker → tab | real input, background screenshots ([Browser Host](Browser-Host.md#cdpts)) |
| notifications (`bf-prompt:<runId>`) | worker ↔ user | Manual Step buttons/clicks |
| context menu items (`bf-menu::<workflowId>::<nodeId>`) | user → worker | Context Menu trigger |

## Adding a message

1. Add an interface to `messages.ts`, add it to `ExtensionMessage`, and add its `type` to `TYPES`.
2. Handle it in the receiver's `switch` / listener (background: `runtime.onMessage` in `background.ts`).
3. Prefer storage for anything long-lived or that the editor must still see after a reload.
4. Keep payloads JSON-serialisable (structured clone).

## See also

- [Background Worker](Background-Worker.md): the message switch in context.
- [Storage Keys](Storage-Keys.md): the storage half of the protocol.
- [Picker and Recorder](Picker-and-Recorder.md), [Editor](Editor.md), [Editor Components](Editor-Components.md).
- [Page Protocol](Page-Protocol.md): the agent request/response types.
