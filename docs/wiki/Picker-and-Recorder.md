# Picker and Recorder

The two interactive content scripts: the **element picker** (point at an element, get locators back into a
block's field) and the **recorder** (do the task by hand, get a chain of blocks). Read this page to change
either overlay, the messages they send, or how recorded steps turn into blocks.

**Source:** [picker.ts](../../src/dom/picker.ts), [picker.content.ts](../../src/entrypoints/picker.content.ts),
[recorder.ts](../../src/dom/recorder.ts), [recorder.content.ts](../../src/entrypoints/recorder.content.ts),
[selector.ts](../../src/dom/selector.ts) (`ElementNavigator`, `sampleText`). Background halves:
[picking.ts](../../src/browser/picking.ts), [recording.ts](../../src/browser/recording.ts); conversion:
[core/recording.ts](../../src/core/recording.ts).

Rationale and the uBlock-style interaction are in
[ARCHITECTURE.md: Element picker](../ARCHITECTURE.md#element-picker) and
[Triggers and the recorder](../ARCHITECTURE.md#triggers-and-the-recorder).

## Common shape

Both are WXT content scripts with `registration: 'runtime'` and `matches: ['<all_urls>']`: built to
`/content-scripts/picker.js` and `/content-scripts/recorder.js`, injected by the background with
`scripting.executeScript({ target: { tabId }, files: [...] })` into the **top frame only**. Each keeps its
handle on a page global so a second injection can find it:

| Script | Global | Second injection |
|---|---|---|
| picker | `window.__blockflowPicker` | stops the old picker (no callbacks) and starts a new one |
| recorder | `globalThis.__blockflowRecorder` | does nothing: this document is already recording (SPA route changes re-inject) |
| agent (for comparison) | `globalThis.__blockflowAgent` | keeps the existing agent, see [Page Agent](Page-Agent.md) |

Both draw their UI in an **open shadow root** with `:host { all: initial; }` so page CSS cannot reach it, and
both listen on `window` in the **capture phase** so they see events before the page does. Events from their
own UI are recognised with `event.composedPath().includes(host)`.

## Element picker

### Lifecycle and messages

```text
editor (ConfigPanel)          background (picking.ts)                         page (picker.content.ts)
  ── bf:start-pick {url?, mode} ─▶ findTargetTab: open url, or last-used http(s) tab
                                  storage bf:pending-pick = {editorTabId, mode}
                                  focus tab, inject picker.js ───────────────▶ startPicker(...)
                                                                               user hovers, clicks, refines
                                ◀── bf:picked {selector, candidates, url, sample}  (or bf:pick-cancelled)
                                  mode 'form': actInTab {op:'detect-form', locator: selector}
  ◀── bf:pick-result {selector, candidates, url, sample, fields?}  (or bf:pick-error)
                                  focus the editor tab again
```

| Message | From → to | Fields | Handler |
|---|---|---|---|
| `bf:start-pick` | editor → background | `url?`, `mode?: 'element' \| 'form'` | `startPicking(sender.tab.id, url, mode)` |
| `bf:picked` | picker → background | `PickResult` spread: `selector`, `candidates`, `url`, `sample` | `finishPicking(message, sender.tab.id)` |
| `bf:pick-cancelled` | picker → background | — | `cancelPicking()` (refocuses editor only; the editor is not told) |
| `bf:pick-result` | background → editor | as `bf:picked`, plus `fields?: FormFieldRow[]` | `ConfigPanel` listener |
| `bf:pick-error` | background → editor | `message` | `ConfigPanel` shows it |

Types are in [messages.ts](../../src/shared/messages.ts); see [Message Protocol](Message-Protocol.md) and
[Storage Keys](Storage-Keys.md) (`bf:pending-pick`).

### `startPicker(options): PickerHandle`

```ts
export interface PickResult { selector: string; candidates: string[]; url: string; sample: string }
export interface PickerOptions { onPick(result: PickResult): void; onCancel(): void; document?: Document }
export interface PickerHandle {
  stop(): void;   // remove without calling onPick / onCancel
  state(): { selector: string | null; matches: number; locked: boolean };   // for tests
}
```

| Phase | Input | Effect |
|---|---|---|
| Hover | `mousemove` (not over the bar) | red box follows `event.target` (not `html`/`body`) |
| Lock | `click` | swallowed; `new ElementNavigator(target)`; bar shows the CSS selector and its match count |
| Refine | ▲ Broader / ↑ | `navigator.broaden()`: parent, never `body`/`html` |
| | ▼ Narrower / ↓ | `navigator.narrow()`: back down the chain toward the clicked element |
| | click elsewhere | re-locks on the new element |
| Confirm | ✓ Use this / Enter | builds `PickResult`, removes the overlay, `onPick` |
| Cancel | ✕ / Esc | removes the overlay, `onCancel` |
| — | `scroll`, `resize` | box re-measured |

`PickResult` on confirm: `selector = generateSelector(current)`, `candidates = locatorCandidates(current)`
(readable ones first, CSS last; see [Locators: Generated locators](Locators.md#generated-locators)),
`url = location.href`, `sample = sampleText(current)` (collapsed text, up to 120 chars with `…`).

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
                                                   tabs.create(url), addOwnTab, bf:recording = {status:'recording', steps: []}
                                                   wait for load, inject recorder.js
page   ── bf:recorded {step} ─────────────────▶ recordStep: append if status 'recording' and sender tab = recording tab
tabs.onUpdated (url change) ──────────────────▶ append {kind:'navigated', url}
tabs.onUpdated (status complete) ─────────────▶ inject recorder.js again (new document)
toolbar Stop / editor Stop ── bf:stop-recording ▶ stopRecording: status 'stopped', run __blockflowRecorder.stop() in the tab
editor (watches bf:recording) ── status 'stopped' ─▶ recordingToBlocks → nodes + edges on the canvas, remove bf:recording
```

`RecordingState` (`bf:recording` in `storage.local`): `{ workflowId, tabId, startUrl, lastUrl, steps,
status }`. Steps are appended through a promise queue in `recording.ts`, since several messages can arrive
together (input, change, click). The recording tab is an "own tab", so it never fires Page Visited triggers.

### `startRecorder(options): RecorderHandle`

```ts
export interface RecorderOptions { onStep(step: RecordedStep): void; onStop(): void; document?: Document }
export interface RecorderHandle { stop(): void }   // flush pending fill, remove listeners and toolbar
```

Toolbar: `<blockflow-recorder>` (custom element with an open shadow root) bottom right, pulsing dot,
**Assert text**, **Assert visible**, **Stop**. The content script forwards `onStep` as `bf:recorded` and
`onStop` as `bf:stop-recording` (send errors ignored).

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
| Types a password | — | `{kind:'fill', value:'', secret:true}` |
| Picks in a `<select>` | `change` | `{kind:'select', value: labels joined with ' \| '}` |
| Toggles a checkbox / radio / ARIA switch | `change` | `{kind:'check', checked}` |
| Assert text, then clicks | `click` (swallowed) | `{kind:'assert-text', locator, text}` (collapsed `textContent`); mode returns to record |
| Assert visible, then clicks | `click` (swallowed) | `{kind:'assert-visible', locator}` |
| Page URL changes | `tabs.onUpdated` (background) | `{kind:'navigated', url}` |

`CLICKABLE` = `button, a, [role=button|link|tab|menuitem|option], input[type=submit|button|image], summary`,
so a click on an icon inside a button records the button. Text fields are inputs of type `''`, text, email,
password, search, tel, url, number, date, time, datetime-local, month, week, and textareas.

A `WeakMap` of the last value reported per field stops `input` + `change` + Enter from reporting the same
typing twice.

### From steps to blocks (`core/recording.ts`)

`recordingToBlocks({startUrl, steps}, origin)` returns `{ nodes, edges, secrets }`, one straight chain
240 px apart:

1. `tidySteps`: consecutive fills of the same locator keep the last; consecutive navigations keep the last.
2. First node: `open-url` (`startUrl`, new tab named `main`, wait for load).
3. A run of fill/select/check steps containing **≥ 2 fills** becomes one `fill-form` (checks as
   `"true"/"false"`); if the next step is a click it becomes the form's `submit` and is consumed.
4. Otherwise one block per step:

| Step | Block | Config |
|---|---|---|
| click | `click` | `action: 'click'`, `force: false` |
| fill | `fill` | `mode: 'fill'`; secret → `{{secret.password}}` |
| select | `select-option` | `value` |
| check | `check` | `state: 'check' \| 'uncheck'` |
| press | `press-key` | `key`, `locator` |
| navigated | `wait-for` | `mode: 'url'`, `url` = the path only |
| assert-text | `assert` | `subject: 'text'`, `operator: 'equals'`, `expected` |
| assert-visible | `assert` | `subject: 'visible'` |

Any password fill adds `password` to `secrets`; the editor then tells the user to create that secret. See
[Editor](Editor.md) for where the blocks land on the canvas.

## Gotchas

- **Top frame only.** Neither script is injected into iframes, so elements inside frames cannot be picked or
  recorded; write `frame=…` locators by hand ([Locators: Frames](Locators.md#frames)).
- **Shadow DOM.** Window-level listeners see events retargeted to the outermost shadow host, so clicks inside
  web components pick/record the host element, not the inner one.
- **Popups are not followed.** `recordStep` only accepts steps from the recording tab; actions in a tab the
  page opens are dropped.
- **Restricted pages** (`chrome://`, web store): picker injection fails with `bf:pick-error`; recorder
  injection fails silently.
- **Form-mode hint text** still says "Click the part of the page to watch".
- The picker's `stop()` does not notify the background, so `bf:pending-pick` stays until the next pick.
- Tests: [tests/dom/picker.test.ts](../../tests/dom/picker.test.ts),
  [tests/dom/recorder.test.ts](../../tests/dom/recorder.test.ts) (jsdom), and the e2e run; see
  [Testing](Testing.md).

## See also

- [Locators](Locators.md): `bestLocator`, `locatorCandidates`, `generateSelector`
- [Page Agent](Page-Agent.md): `detect-form`, the third content script
- [Message Protocol](Message-Protocol.md), [Storage Keys](Storage-Keys.md)
- [Background Worker](Background-Worker.md): where the messages are routed
- [Editor Components](Editor-Components.md): `ConfigPanel` pick handling
