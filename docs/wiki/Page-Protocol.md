# Page Protocol

The plain-data contract between page blocks (in the engine) and the page agent (inside web pages):
every request op, its fields, the result it answers with, and which agent function carries it out. Read
this before adding a page ability or changing what a page block sends. The flow itself
(driver, injection, retry slices) is explained in
[ARCHITECTURE: Page blocks and the page agent](../ARCHITECTURE.md#page-blocks-and-the-page-agent).

**Source:** [page.ts](../../src/core/page.ts) (types), handled by
[agent.ts](../../src/dom/agent.ts) (`attempt()` dispatch) and [snapshot.ts](../../src/dom/snapshot.ts)
(the `snapshot` op), driven by [pageDriver.ts](../../src/browser/pageDriver.ts); error codes in
[errors.ts](../../src/core/errors.ts)

## The path of one request

```text
block ── inPage()/ctx.host.page.act(tabId, request, timeoutMs, {realInput?}) ──▶ pageDriver.act
pageDriver ── executeScript: agent.run({ request, budgetMs ≤ 2s }) ──▶ agent (isolated world)
agent: attempt(request) every 50 ms until done / error / budget spent
       ◀── AgentResponse ──
pageDriver: done → result · error → throw CodedError · pending → ask again until timeoutMs
            (then throw CodedError with the last pending code) · frame → re-target
```

Blocks almost always call `inPage(ctx, input, request)` from `src/core/blocks/pageCommon.ts`, which finds
the tab with `requireSessionTab(input, ctx.config.tab)` and waits `pageWaitMs(ctx)` (step timeout minus
500 ms, at least 1 s). Extract List / Extract Table use `inSource()` (in `blocks/extractList.ts`), which
can also send the request to `Host.html.act` for fetched HTML.

Everything here must stay JSON-serialisable: it crosses `scripting.executeScript`.

## Types

| Type | Definition |
| --- | --- |
| `AgentCall` | `{ request: AgentRequest; budgetMs: number }`: how long the agent may retry inside the page before answering. |
| `AgentResponse` | `{ status: 'done', result }` · `{ status: 'pending', reason, code?, url? }` (not possible yet; the driver asks again) · `{ status: 'error', message, code?, url?, matches? }` (will never work) · `{ status: 'frame', src, rest, offset? }` (locator crosses into a cross-origin iframe; run `rest` in the frame showing `src`; for `locate` and `measure`, `offset` is where that frame's content starts in this frame's viewport). |
| `AgentErrorInfo` | `{ code?, url?, matches? }`: the machine-readable part of `pending` / `error` (see [Error codes](#error-codes)). |
| `SnapshotResult` | `{ snapshot, elements, url, title, lines, truncated }`: the `snapshot` op's result (see [The snapshot op](#the-snapshot-op)). |
| `SnapshotElement` | `{ ref, role, name, tag, locator?, value?, checked?, disabled?, level?, url?, inFrame?, inShadow? }`: one targetable element of a snapshot. |
| `ReadKind` | `text`, `value`, `attribute`, `has-class`, `exists`, `count`, `visible`, `checked`, `enabled`, `class`, `css`, `focused`, `editable`, `in-viewport`, `accessible-name`, `accessible-description`. |
| `WaitState` | `visible`, `hidden`, `attached`, `detached`, `enabled`, `text`, `no-text`. |
| `WaitUntil` | `load`, `networkidle`, `none` (tab operations, not agent ops). |
| `UploadFile` | `{ name, type, base64 }`. |
| `ExtractField` | `{ name, locator?, attribute? }`. |
| `FormFieldRow` | `{ locator, value, hint? }`: a Fill Form row and what Detect fields returns. |

Inside the agent, `Pending` errors become `pending` (retried), `Fatal` and any other error become `error`,
`FrameBoundaryError` becomes `frame`. `Pending` and `Fatal` carry an error code; both answers carry the
document's URL, and strict-mode errors the first 5 matches (`describeElement`). The driver adds two outcomes of its own: `missing` (agent not
injected yet: inject `agent.js`, ask again) and `vanished` (no answer because the page navigated). After
`vanished`, an action op (`click`, `fill`, `set-field`, `select`, `check`, `press`, `insert-text`, `drag`, and the
Element Action ops `focus`, `blur`, `clear`, `dispatch`) returns `{ navigated: true }` instead of repeating, so a
form is never submitted twice.

## Readiness ("auto-wait")

Action ops find their element with `one(locator)` (exactly one match, else `pending` for none, `error` for
several, with a `>> nth=0` hint) and call `ready(element, needs)`:

| Check | Pending reason | Code |
| --- | --- | --- |
| found (`one()`) | `waiting for …: no element matches` | `locator.not-found` |
| visible | `waiting for … to be visible` | `element.not-visible` |
| enabled (`needs.enabled`) | `… to be enabled` | `element.disabled` |
| editable (`needs.editable`) | `… to be editable (it is read-only)` | `element.not-editable` |
| stable (same box on two looks 50 ms apart) | `… to stop moving` | `element.unstable` |
| hit target (`needs.hit`): `elementFromPoint` at the center is the element (or its label) | `… is covered by …` | `element.covered` |

Several matches is an `error` at once with code `locator.strict` and `matches`.

Geometry checks (stable, hit) are skipped where there is no layout (jsdom, `Host.html.act`).

## Ops

| Op | Fields | Agent handler | Ready checks | `result` | Sent by |
| --- | --- | --- | --- | --- | --- |
| `click` | `locator`, `action: click \| double \| right \| hover`, `force?`, `button?: left \| middle \| right`, `modifiers?: ('Alt' \| 'Control' \| 'Meta' \| 'Shift')[]`, `position?: {x, y}` (from the padding box's top-left corner, as Playwright), `clickCount?` | inline → `click()` | visible, enabled (not for hover), stable, hit; all skipped with `force` | `{ clicked, url }`. `action: right` = right button; `double` = at least 2 presses. Left presses end in `click` (+ `dblclick` after the 2nd), middle in `auxclick`, right in `contextmenu` | Click, Fill Form submit, Paginate |
| `focus` | `locator` | inline → `focus()` | visible | `{ focused }` | Element Action |
| `blur` | `locator` | inline | none | `{ blurred }` (only blurs when the element or something inside it has focus) | Element Action |
| `clear` | `locator` | `clear()` → `fill(…, '')` | visible, enabled, editable | `{ value: '' }`; `element.wrong-type` when not a text field / contenteditable | Element Action |
| `dispatch` | `locator`, `eventType`, `detail?` | `dispatch()` | none | `{ dispatched, defaultPrevented }`. Bubbles, cancelable, composed. Built-in types get their class (MouseEvent, PointerEvent, KeyboardEvent, FocusEvent, DragEvent, WheelEvent, InputEvent, TouchEvent) with `detail` (an object) as the init; any other type is a `CustomEvent` with `detail` as `event.detail` (`cloneInto` on Firefox) | Element Action |
| `drag` | `locator` (source), `to`, `fromPosition?`, `toPosition?`, `modifiers?` | `drag()` | source: visible, stable, hit; target: visible, stable | `{ dragged, to, mode: 'html5' \| 'pointer', dropped }`. See [Page Agent: drag](Page-Agent.md#drag-and-drop) | Drag |
| `fill` | `locator`, `value`, `mode: fill \| type` | inline → `fill()` | visible, enabled, editable | `{ value }` | Fill |
| `set-field` | `locator`, `value` | `setField()` | visible, enabled, editable for text fields | select: as `select` (value split on `\|`); checkbox/radio/switch: as `check` (`true/yes/on/1/checked`); text: `{ value }`. File inputs → error. | Fill Form |
| `select` | `locator`, `values: string[]` | `select()` | visible, enabled | `{ selected: string[] }` (option values). Not a `<select>` → error; missing option → pending. | Select Option |
| `check` | `locator`, `checked` | `check()` | visible, enabled | `{ changed, checked }`. Unchecking a radio → error. | Check |
| `press` | `key` (combo like `Control+a`, `Control+Shift+K`, `ControlOrMeta+A`), `locator?` | `press()` | with a locator: visible, enabled, then focus | `{ key }`. Without a locator the focused element (or body) gets the keys. Modifier keys go down first and up last. | Press Key |
| `insert-text` | `text`, `locator?` | `insertText()` | with a locator: visible, enabled, editable, then focus (unless already focused) | `{ text }`. Replaces the selection at the caret with one `input` event, no key events (`execCommand('insertText')` when it works, else the native value setter). Not a text field → `error` `element.wrong-type`. | Press Key (`mode: "text"`) |
| `read` | `locator`, `kind: ReadKind`, `name?` | `read()` | none | `{ found: true, text, count }`. `count`/`exists`/`visible`/`checked`/`enabled`/`focused`/`editable`/`in-viewport` answer even with no match; other kinds wait for a match. `text` is raw `textContent`. `css` needs `name` (the property; missing → `error` `config.invalid`). `in-viewport` is the only asynchronous read (an IntersectionObserver, ≤ 500 ms). | Read Element, Assert, Paginate, `pageReader` (Watch Element), driver (real-input check) |
| `wait` | `state: WaitState`, `locator?`, `text?` | `wait()` | n/a | `{ state, count? }`; pending until the state holds. `text`/`no-text` search `innerText` of the locator's matches or the body. | Wait For |
| `detect-form` | `locator` | `detectForm()` | n/a | `{ fields: FormFieldRow[], form }`: visible fields of the enclosing `<form>` (or the element), skipping hidden/submit/button/reset/image/file inputs. | `src/browser/picking.ts` (Detect fields) |
| `info` | none | inline | n/a | `{ url, title }` | nothing currently |
| `extract` | `locator`, `fields: ExtractField[]`, `limit?` | `extract()` | n/a | `{ columns, values, count }` (rows of cells; no fields = one `text` column). `href`/`src`/`action`/`poster`/`data-src` attributes are made absolute. Pending while nothing matches. | Extract List (`tableToObjects` rebuilds objects) |
| `table` | `locator` | `table()` | n/a | `{ columns, values, count }`; header = `<thead>` row, else first row with `<th>`, else first row. Not a table → error. | Extract Table |
| `page-info` | none | `pageInfo()` | n/a | `{ url, title, description, canonical, lang, meta, jsonLd, links }` | Page Info |
| `storage` | `area: local \| session \| cookies`, `key?`, `action?: get \| set \| delete \| clear` (default get), `value?` | `storage()` | n/a | get: `{ value }`, one item (or null) or all of them; set: `{ value }`; delete: `{ deleted: 0 \| 1 }`; clear: `{ cleared: n }`. set/delete need `key` (else `error` `config.invalid`). Cookies are read only here: those visible to the page (no HttpOnly); changing cookies goes through `Host.cookies`. | Page Info (storage mode), Cookies & Storage (local / session) |
| `measure` | `locator?` | `measure()` | visible, stable; scrolled into view (also the same-origin frames around it) | With `locator`: `{ x, y, width, height }`, the element's box in the tab's viewport (frame offsets added, like `locate`). Without: `{ scrollX, scrollY, viewportWidth, viewportHeight, pageWidth, pageHeight, devicePixelRatio }` | `screenshots.ts` (Screenshot block: element and full page) |
| `scroll` | `to: bottom \| top \| element`, `locator?` | `scroll()` | n/a | `{ height, y }` | Scroll |
| `upload` | `locator`, `files: UploadFile[]`, `dropzone?` | `upload()`, `dropFiles()` with `dropzone` | input: enabled (a hidden input is fine); drop zone: visible, stable | `{ files: string[] }` (+ `dropped: true`). Accepts the input, a label, or an element containing the input. With `dropzone`: dragenter, dragover, drop on the element with a DataTransfer carrying the files; `pending` (`element.wrong-type`) while nothing cancels its `dragover` | Upload File |
| `locate` | `locator`, `purpose: click \| fill \| set-field \| check \| press \| drop`, `position?` | `locate()` | visible, enabled, stable, hit; editable for `fill` (and `set-field` on text); only visible and stable for `drop` (a drag's target) | `{ x, y, kind: select \| check \| text \| other }` (center, or `position` from the padding box's corner, in the tab's viewport: frame offsets added) | `pageDriver.actWithRealInput` only |
| `snapshot` | `locator?` (only that part, first match), `maxLines?` (default `SNAPSHOT_MAX_LINES` = 1,500) | `snapshot()` → `takeSnapshot()` in `snapshot.ts` | n/a (pending while `locator` matches nothing) | `SnapshotResult` | Page Snapshot, `src/browser/picking.ts` (editor's 📸 Snapshot page) |

### The snapshot op

An outline of the accessibility tree, one line per element, indented by nesting. Part of the snapshot of
`tests/fixtures/site/snapshot.html` (some lines left out):

```text
- banner
  - heading "Snapshot shop" [level=1] [ref=e1] locator=role=heading[name="Snapshot shop"]
  - navigation "Main" [ref=e2] locator=role=navigation[name="Main"]
    - link "Prices" [url="/table.html"] [ref=e3] locator=role=link[name="Prices"]
- main
  - form "Search" [ref=e5] locator=role=form[name="Search"]
    - textbox "Query" [value="lamps"] [ref=e6] locator=label="Query"
    - combobox "Sort" [value="Cheapest"] [options="Newest | Cheapest"] [ref=e7] locator=label="Sort"
    - checkbox "In stock only" [checked] [ref=e8] locator=label="In stock only"
    - button "Reset" [disabled] [ref=e10] locator=role=button[name="Reset"]
  - list
    - listitem
      - text: Lamp
      - button "Add to cart" [ref=e12] locator=#results > li:nth-of-type(1) > button
  - shop-badge [shadow]
    - button "Badge action" [ref=e14] locator=role=button[name="Badge action"]
  - iframe "Payment" [frame] [ref=e15] locator=frame=#pay
    - textbox "Card number" [ref=e16] locator=frame=#pay >> label="Card number"
  - paragraph: Hello, shopper!
- … truncated at 1499 lines: snapshot one part of the page (a locator) to see the rest
```

Two "Add to cart" buttons share their role and name, so their locators fall back to generated CSS.

- **Line:** `- role "name" [flags] [ref=eN] locator=…`, or `- role: text` for structural roles whose content
  is only text, or `- text: …` for loose text. Flags: `level=N`, `checked` / `checked=mixed`, `disabled`,
  `expanded` / `expanded=false`, `selected`, `pressed`, `required`, `value="…"` (never for passwords:
  `password`), `options="a | b | …"` (selects, first 10), `url="…"` (links), `type=…` (date, number, file…).
- **Targets** (interactive roles, headings, images, dialogs, tables, forms, named landmarks, anything with
  a test id) get a `ref` and a `locator`, and an entry in `elements`. The locator is the first readable
  idea of [bestLocator.ts](../../src/dom/bestLocator.ts) that finds exactly that element
  (`firstLocator`), else the generated CSS; inside frames it is prefixed with `frame=… >> `. Refs are
  numbered per snapshot and mean nothing to other ops.
- **Hidden** (`display:none`, `hidden`, `aria-hidden`) subtrees are skipped; `visibility:hidden` hides an
  element and its text, but a child made visible again is kept. A `<label>`'s own text is skipped when it
  labels a field (the field's name says it).
- **Shadow DOM:** open shadow roots are walked as rendered (slots filled with their assigned nodes); the
  host line gets `[shadow]` (a host without a role is shown by tag name).
- **Frames:** same-origin frames are walked (`[frame]`); frames the page cannot read are one line,
  `[cross-origin] [src="…"]`, whose `locator=frame=…` still works as a prefix (the driver crosses into it).
- **Cap and speed:** the walk stops at three times the line cap; rendering stops at the cap and adds the
  `truncated` note line. Names and hidden states are remembered for the whole snapshot (`withAriaMemo`
  in `aria.ts`), locator lookups are cached per document, and after 4 s of locator work the remaining
  elements get generated CSS. About 1.3 s for a 2,000-element page in Chromium.

`snapshotDocument(result)` in `page.ts` adds a title/URL header; it is what the editor copies.

## Error codes

Every failed step records a `code` from [errors.ts](../../src/core/errors.ts) (`ERROR_CODES` holds the
meaning and the fix of each; the [usage guide](../guide/README.md#error-codes) lists them). Page errors get
theirs here:

| Where | Code |
| --- | --- |
| Agent `Pending` (then the driver's timeout) | `locator.not-found`, `element.not-visible`, `element.disabled`, `element.not-editable`, `element.unstable`, `element.covered`, `option.not-found`, otherwise `timeout` (text waits, `hidden`, `detached`) |
| Agent `Fatal` | `locator.strict` (+ `matches`), `locator.invalid`, `element.wrong-type` (typing into a button, select on a non-select, check on a non-checkbox, upload on a non-file input, table on a non-table), `config.invalid` (a Wait For without text or element) |
| Agent, unexpected exception | none (the engine records `step.failed`) |
| Driver | `tab.closed`; `permission.missing` (no host access) or `page.restricted` (chrome://, the web store); `frame.unreachable` (a cross-origin frame never showed up); `navigation.failed` (the page stayed busy loading) |

The driver throws a `CodedError` with the code, the request's `locator`, the page `url` and `matches`. A
timeout keeps the code of the last `pending` answer, so "Timed out after 9s: waiting for #save to be
enabled" is `element.disabled`, not `timeout`.

### Real input

When the step has `realInput` and the op is an action, `pageDriver.act` first sends `locate`, then drives
the mouse/keyboard through the debugger (`src/browser/cdp.ts`). Results then carry `real: true`; `select`
and non-text `set-field` fall back to the normal agent path. `drag` locates both elements (the target with
`purpose: 'drop'`) and runs `mouseDrag`. A `drag` whose source locator crosses into a cross-origin frame has the
same `frame=…` prefix removed from `to`, so both must be in the same frame. See [Browser Host](Browser-Host.md).

## Adding an op

1. Add the variant to `AgentRequest` in `page.ts` (plain data only).
2. Handle it in `attempt()` in `src/dom/agent.ts`; throw `Pending` for "not yet", `Fatal` for "never",
   each with the [error code](#error-codes) that fits. Add a jsdom test in `tests/dom/agent.test.ts`.
3. If it is an action that may navigate, add it to `ACTIONS` in `pageDriver.ts`.
4. Use it from a block via `inPage`, and teach `tests/helpers/fakeHost.ts` if block tests need it.

## See also

- [Page Agent](Page-Agent.md): the agent's implementation (events, values, keys)
- [Locators](Locators.md): locator syntax and resolution
- [Browser Host](Browser-Host.md): `pageDriver`, frames, real input
- [Core Engine](Core-Engine.md#the-host-interface): `Host.page`
- [Adding a Block](Adding-a-Block.md)
