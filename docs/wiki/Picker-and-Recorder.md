# Picker and Recorder

The two interactive content scripts: the **element picker** (point at an element, get locators back into a
block's field) and the **recorder** (do the task by hand, get a chain of blocks). Read this page to change
either overlay, the messages they send, or how recorded steps turn into blocks.

**Source:** [picker.ts](../../src/dom/picker.ts), [picker.content.ts](../../src/entrypoints/picker.content.ts),
[recorder.ts](../../src/dom/recorder.ts), [recorder.content.ts](../../src/entrypoints/recorder.content.ts),
[selector.ts](../../src/dom/selector.ts) (`ElementNavigator`, `sampleText`), [framePath.ts](../../src/dom/framePath.ts)
(which iframe a frame is). Background halves:
[picking.ts](../../src/browser/picking.ts), [recording.ts](../../src/browser/recording.ts); conversion:
[core/recording.ts](../../src/core/recording.ts).

Rationale and the uBlock-style interaction are in
[ARCHITECTURE.md: Element picker](../ARCHITECTURE.md#element-picker) and
[Triggers and the recorder](../ARCHITECTURE.md#triggers-and-the-recorder).

## Common shape

Both are WXT content scripts with `registration: 'runtime'` and `matches: ['<all_urls>']`: built to
`/content-scripts/picker.js` and `/content-scripts/recorder.js`, injected by the background with
`scripting.executeScript({ target: { tabId, allFrames: true }, files: [...] })` into **every frame** of the
tab. Only the top frame draws the toolbar (`toolbar: window === window.top`). Each keeps its handle on a
page global so a second injection can find it:

| Script | Global | Second injection |
|---|---|---|
| picker | `window.__blockflowPicker` | stops the old picker (no callbacks) and starts a new one |
| recorder | `globalThis.__blockflowRecorder` | does nothing: this document is already recording (SPA route changes re-inject) |
| agent (for comparison) | `globalThis.__blockflowAgent` | keeps the existing agent, see [Page Agent](Page-Agent.md) |

Both draw their UI in an **open shadow root** with `:host { all: initial; }` so page CSS cannot reach it, and
both listen on `window` in the **capture phase** so they see events before the page does. Events from their
own UI are recognised with `event.composedPath().includes(host)`. The element acted on is
`event.composedPath()[0]`, not `event.target`, so elements inside **open shadow roots** are picked and
recorded themselves (a window listener only sees the outermost shadow host as `target`).

### Frames

Every frame runs its own copy. A frame turns its locators into top-page ones with
[framePath.ts](../../src/dom/framePath.ts): `framePath(window)` returns the CSS selectors of the iframes
from the top page down (`[]` in the top frame) and `withFramePath(path, locator)` writes
`frame=<css> >> … >> <locator>`.

- Same-origin parent: read directly (`window.frameElement`, then `generateSelector` in the parent's document).
- Cross-origin parent: the frame posts `{type: 'blockflow:frame-path?', id}` to `window.parent` (again every
  250 ms, since the parent's script may be injected a moment later; gives up after 3 s with `null`). The
  parent's copy, installed by `answerFramePathQuestions(window)`, finds the `<iframe>` whose `contentWindow`
  is `event.source` (also inside open shadow roots), works out its own path the same way and answers
  `{type: 'blockflow:frame-path', id, path}`.

Frames without a toolbar coordinate with the top frame through the background, which relays
`bf:picker-sync` / `bf:recorder-sync` from one frame to every frame of the same tab
(`tabs.sendMessage(tabId, message)`); see below.

## Element picker

### Lifecycle and messages

```text
editor (ConfigPanel)          background (picking.ts)                         page (picker.content.ts, every frame)
  ── bf:start-pick {url?, urlFrom?, mode} ─▶ findTargetTab (see below)
                                  storage bf:pending-pick = {editorTabId, mode, tabId}
                                  focus tab, set __blockflowPickerMode and inject picker.js
                                  into all frames ───────────────────────────▶ startPicker(...)
                                ◀─▶ bf:picker-sync (relayed to the whole tab)  user hovers, clicks, refines
                                ◀── bf:picked {selector, candidates, url, sample}  (or bf:pick-cancelled)
                                  stop the pickers in every frame
                                  mode 'form': actInTab {op:'detect-form', locator: selector}
  ◀── bf:pick-result {selector, candidates, url, sample, fields?}  (or bf:pick-error)
                                  focus the editor tab again
```

| Message | From → to | Fields | Handler |
|---|---|---|---|
| `bf:start-pick` | editor → background | `url?`, `urlFrom?: 'block' \| 'upstream'`, `mode?: 'watch' \| 'action' \| 'form'` | `startPicking(sender.tab.id, url, mode, urlFrom)` |
| `bf:picker-sync` | picker → background → every frame of the tab | `sync: PickerSync` | `relayPickerSync` |
| `bf:picked` | picker → background | `PickResult` spread: `selector`, `candidates` (already `frame=…`-prefixed inside frames), `url`, `sample` | `finishPicking(message, {tabId, frameId, tabUrl})`: a pick in a frame reports the tab's URL |
| `bf:pick-cancelled` | picker → background | — | `cancelPicking(tabId)`: stops every frame's picker, refocuses the editor (the editor is not told) |
| `bf:pick-result` | background → editor | as `bf:picked`, plus `fields?: FormFieldRow[]` | `ConfigPanel` listener |
| `bf:pick-error` | background → editor, or a picker → editor + background | `message` | `ConfigPanel` shows it; from a picker (frame path unknown) the background also ends the pick |

Types are in [messages.ts](../../src/shared/messages.ts); see [Message Protocol](Message-Protocol.md) and
[Storage Keys](Storage-Keys.md) (`bf:pending-pick`).

**Which tab** (`findTargetTab`). Each editor tab has one picker tab, remembered in `storage.session`
`bf:picker-tabs` (`Record<editorTabId, tabId>`) and reused while it exists and shows a web page:

| URL sent | Picker tab exists | No picker tab yet |
|---|---|---|
| `urlFrom: 'block'` (Watch/Read Element's own URL) | navigated there unless it already shows that page (hash ignored) | new tab, remembered |
| `urlFrom: 'upstream'` (nearest Open Tab before the block, computed by the editor) | navigated only when it shows another origin | the last-used web tab if it is on that origin (never remembered, never navigated), else a new tab, remembered |
| none | reused as it is | last-used web tab |

### `startPicker(options): PickerHandle`

```ts
export interface PickResult { selector: string; candidates: string[]; url: string; sample: string }
export type PickerMode = 'watch' | 'action' | 'form';
export interface PickerOptions {
  onPick(result: PickResult): void; onCancel(): void; document?: Document;
  mode?: PickerMode;          // hint text (PICKER_HINTS), default 'watch'
  toolbar?: boolean;          // false in iframes
  channel?: PickerChannel;    // { post(PickerSync), listen(handler) => unlisten }, links the frames
}
export interface PickerHandle {
  stop(): void;   // remove without calling onPick / onCancel
  state(): { selector: string | null; matches: number; locked: boolean };   // for tests
}
```

Hint per mode: watch "Click the part of the page to watch.", action "Click the element this step should
use.", form "Click any field of the form." (each followed by "Esc to cancel."). The editor sends `form` for
Detect fields, `watch` for fields with `pickPrefers: 'stable'`, `action` otherwise.

| Phase | Input | Effect |
|---|---|---|
| Hover | `mousemove` (not over the bar) | red box follows `composedPath()[0]` (not `html`/`body`); leaving the frame hides it |
| Lock | `click` | swallowed; `new ElementNavigator(target)`; bar shows the CSS selector and its match count; other frames are told `locked` and drop theirs |
| Refine | ▲ Broader / ↑ | `navigator.broaden()`: parent (out of a shadow root to its host), never `body`/`html` |
| | ▼ Narrower / ↓ | `navigator.narrow()`: back down the chain toward the clicked element |
| | click elsewhere | re-locks on the new element |
| Confirm | ✓ Use this / Enter | builds `PickResult`, removes the overlay, `onPick` |
| Cancel | ✕ / Esc | removes the overlay, `onCancel` |
| — | `scroll`, `resize` | box re-measured |

`PickResult` on confirm: `selector = generateSelector(current)`, `candidates = locatorCandidates(current)`
(readable ones first, CSS last; see [Locators: Generated locators](Locators.md#generated-locators)),
`url = location.href`, `sample = sampleText(current)` (collapsed text, up to 120 chars with `…`). Inside
an open shadow root the CSS selector is `<host selector> >>> <selector inside the root>`.

**Across frames** (`PickerSync`): a frame that locks posts `{kind: 'locked'}` (others let go) and, having
no toolbar, `{kind: 'state', selector, matches, canBroaden, canNarrow}`, which the top toolbar shows as
`(in a frame) <selector>`. The toolbar's buttons and Enter / ↑ / ↓ pressed in a frame that does not hold
the pick become `{kind: 'command', action}`; only the frame holding the pick carries them out. Esc (or ✕)
anywhere ends up in the top frame, which cancels. The frame that confirms adds its `frame=` prefix
(content script) and sends `bf:picked`; the background stops the pickers in all frames.

While active, the picker swallows (`preventDefault` + `stopImmediatePropagation`) `click`, `mousedown`,
`mouseup`, `pointerdown`, `pointerup`, `dblclick` and `auxclick` that are not on its own bar, so links and
buttons do not fire. Keyboard: only Esc, and Enter / ↑ / ↓ once locked, are swallowed.

The overlay: `<div id="blockflow-picker-host">` appended to `<html>`, `position: fixed; inset: 0;
z-index: 2147483647; pointer-events: none`; the bar itself has `pointer-events: auto`.

### What the editor does with it

In [ConfigPanel.tsx](../../src/entrypoints/editor/components/ConfigPanel.tsx):

| Pick target | Value written |
|---|---|
| a locator field | `candidates[0]`, unless the field has `pickPrefers: 'stable'` (Watch Element, Read Element), then `selector`. `pickerUrlKey` also gets `url`. All candidates plus the selector are offered as chips. |
| a table cell (Fill Form row) | `candidates[0] ?? selector` |
| `mode: 'form'` (Detect fields) | `fields` from the agent's `detect-form` (a `bestLocator` and a hint per field); values already typed for the same locator are kept |

## Recorder

### Lifecycle and messages

```text
editor ── bf:start-recording {workflowId, url} ─▶ background startRecording
                                                   tabs.create(url), addOwnTab, bf:recording = {status:'recording', steps: [], popups: []}
                                                   wait for load, inject recorder.js into all frames
page   ── bf:recorded {step} ─────────────────▶ recordStep: append if status 'recording' and the sender tab is the
                                                   recording tab (any frame) or one of its popups (then step.tab = 'popup')
page   ◀─▶ bf:recorder-sync {mode} ─────────────▶ relayed to every frame of that tab (assert mode)
webNavigation.onCreatedNavigationTarget ──────▶ onRecordedPopup: opener is the recording tab or a popup → after
                                                   300 ms append {kind:'popup', url}, follow the new tab (own tab)
tabs.onUpdated (url change) ──────────────────▶ append {kind:'navigated', url} (tab 'popup' for a popup's later pages)
tabs.onUpdated (status complete) ─────────────▶ inject recorder.js again (new document), recording tab or popup
toolbar Stop / editor Stop ── bf:stop-recording ▶ stopRecording: status 'stopped', run __blockflowRecorder.stop() in every
                                                   frame of the recording tab and its popups
editor (watches bf:recording) ── status 'stopped' ─▶ recordingIntoWorkflow → nodes + edges on the canvas, remove bf:recording
```

`RecordingState` (`bf:recording` in `storage.local`): `{ workflowId, tabId, startUrl, lastUrl, steps,
status, popups?: {tabId, lastUrl}[] }`. Steps are appended through a promise queue in `recording.ts`, since
several messages can arrive together (input, change, click). The recording tab and its popups are "own
tabs", so they never fire Page Visited triggers. The popup step waits 300 ms so the click that opened it
(a message from the page) is recorded first.

### `startRecorder(options): RecorderHandle`

```ts
export interface RecorderOptions {
  onStep(step: RecordedStep): void; onStop(): void; document?: Document;
  toolbar?: boolean;           // false in iframes
  channel?: RecorderChannel;   // { post(mode), listen(handler) => unlisten }: the assert mode across frames
}
export interface RecorderHandle { stop(): void }   // flush pending fill, remove listeners and toolbar
```

Toolbar (top frame only): `<blockflow-recorder>` (custom element with an open shadow root) bottom right,
pulsing dot, **Assert text**, **Assert visible**, **Stop**. A mode change is posted on the channel, so the
next click in any frame becomes the check, and the frame that takes it posts `record` back. The content
script forwards `onStep` as `bf:recorded`, after prefixing the locator with the frame's `frame=…` path
(worked out once per document; a frame whose path cannot be found records nothing), and `onStop` as
`bf:stop-recording` (send errors ignored).

Listeners on `window`, capture phase: `click`, `input`, `change`, `keydown`, plus `pagehide`. In record
mode the page's events are **not** cancelled.

### What gets recorded

| User does | Event | Step |
|---|---|---|
| Clicks something | `click` | `{kind:'click', locator: bestLocator(closest CLICKABLE ?? target), text}` (text ≤ 60 chars). A pending fill is flushed first. |
| Clicks a text field, select, option, checkbox/radio/switch, or a label for a checkbox or text field | `click` | nothing (recorded by input/change instead) |
| Types in a text field | `input` | remembered as the pending fill (switching to another field flushes the previous one) |
| Leaves the field | `change` | `{kind:'fill', locator, value}` |
| Presses Enter in an input (not textarea) | `keydown` | the fill, then `{kind:'press', locator, key:'Enter'}` |
| Types then navigates away | `pagehide` | the fill |
| Types a password | — | `{kind:'fill', value:'', secret:true, field}` (`field`: accessible name, else `name`, `id`, `placeholder`) |
| Picks in a `<select>` | `change` | `{kind:'select', value: labels joined with ' \| '}` |
| Toggles a checkbox / radio / ARIA switch | `change` | `{kind:'check', checked}` |
| Assert text, then clicks | `click` (swallowed) | `{kind:'assert-text', locator, text}` (collapsed `textContent`); mode returns to record |
| Assert visible, then clicks | `click` (swallowed) | `{kind:'assert-visible', locator}` |
| Page URL changes | `tabs.onUpdated` (background) | `{kind:'navigated', url}` |
| The page opens a tab or window | `webNavigation.onCreatedNavigationTarget` (background) | `{kind:'popup', url}`; later steps in that tab carry `tab: 'popup'` |

`CLICKABLE` = `button, a, [role=button|link|tab|menuitem|option], input[type=submit|button|image], summary`,
so a click on an icon inside a button records the button (`closest` continues from a shadow root to its
host). Text fields are inputs of type `''`, text, email,
password, search, tel, url, number, date, time, datetime-local, month, week, and textareas.

A `WeakMap` of the last value reported per field stops `input` + `change` + Enter from reporting the same
typing twice.

### From steps to blocks (`core/recording.ts`)

`recordingToBlocks({startUrl, steps}, origin)` returns `{ nodes, edges, secrets }`, one straight chain
240 px apart:

1. `tidySteps`: consecutive fills of the same locator (same tab) keep the last; consecutive navigations keep the last.
2. First node: `open-url` (`startUrl`, new tab named `main`, wait for load).
3. A run of fill/select/check steps in one tab containing **≥ 2 fills** becomes one `fill-form` (checks as
   `"true"/"false"`); if the next step is a click in that tab it becomes the form's `submit` and is consumed.
4. Otherwise one block per step. Every block gets `tab: step.tab ?? 'main'`:

| Step | Block | Config |
|---|---|---|
| click | `click` | `action: 'click'`, `force: false` |
| fill | `fill` | `mode: 'fill'`; secret → `{{secret.<name>}}` (below) |
| select | `select-option` | `value` |
| check | `check` | `state: 'check' \| 'uncheck'` |
| press | `press-key` | `key`, `locator` |
| navigated | `wait-for` | `mode: 'url'`, `url` = the path only |
| popup | `wait-for-popup` | `name: 'popup'`, `tab` = the opener |
| assert-text | `assert` | `subject: 'text'`, `operator: 'equals'`, `expected` |
| assert-visible | `assert` | `subject: 'visible'` |

**Secret names**: one per password field (by locator), from `field` or else the locator (`label="…"`,
`[name="…"]`, `#id`), camel-cased (`Admin password` → `adminPassword`), `password` when nothing is left;
two different fields with the same name get `password2`, `password3`…. `secrets` lists them; the editor
tells the user which secrets to create.

**Into an existing workflow** (`recordingIntoWorkflow(workflow, recording, selectedId?)`, what the editor
calls): an empty workflow gets the chain above at (60, 120). Otherwise the anchor is the selected block, or
`lastBlockOfMainPath` (from the leftmost block with no input, follow the leftmost target until a block
with no output). If the workflow has an `open-url` whose URL has the recording's origin, the recorded
Open Tab is dropped and the recorded `tab: 'main'` blocks take that block's `tab`. The chain starts 240 px
right of the anchor at its height (moved down 160 px at a time while existing blocks are in the way) and an
edge connects anchor → first block. See [Editor](Editor.md).

## Gotchas

- **Frames added later.** The picker is injected into the frames present when the pick starts; the
  recorder into the frames present when a page of the recording tab finishes loading. Iframes created
  after that are not covered.
- **Frame paths need an answer.** A frame under a cross-origin parent asks it with `postMessage`; a parent
  page that stops `message` events in the capture phase (rare) makes that frame unpickable (`bf:pick-error`)
  and unrecordable.
- **Closed shadow roots** stay invisible: `composedPath()` stops at their host.
- **One popup name.** Every popup is `popup`; with two open at once, steps in the older one are attributed
  to the newer one when replayed.
- **Restricted pages** (`chrome://`, web store): picker injection fails with `bf:pick-error`; recorder
  injection fails silently.
- Tests: [tests/dom/picker.test.ts](../../tests/dom/picker.test.ts),
  [tests/dom/recorder.test.ts](../../tests/dom/recorder.test.ts), [tests/dom/framePath.test.ts](../../tests/dom/framePath.test.ts)
  (jsdom), [tests/core/recordingSchedule.test.ts](../../tests/core/recordingSchedule.test.ts), and the
  e2e spec `frames-recording`; see [Testing](Testing.md).

## See also

- [Locators](Locators.md): `bestLocator`, `locatorCandidates`, `generateSelector`
- [Page Agent](Page-Agent.md): `detect-form`, the third content script
- [Message Protocol](Message-Protocol.md), [Storage Keys](Storage-Keys.md)
- [Background Worker](Background-Worker.md): where the messages are routed
- [Editor Components](Editor-Components.md): `ConfigPanel` pick handling
