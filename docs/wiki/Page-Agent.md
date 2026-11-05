# Page Agent

The page agent is the content script that carries out page blocks inside a web page: it finds the element,
waits until it is ready, dispatches the events and answers with plain data. Read this page when you add a
page op, debug a "waiting for…" timeout, or need to know what an action really does to the DOM.

**Source:** [agent.ts](../../src/dom/agent.ts), [agent.content.ts](../../src/entrypoints/agent.content.ts). Request/response types live in
[page.ts](../../src/core/page.ts) (see [Page Protocol](Page-Protocol.md)); the extension side is
[pageDriver.ts](../../src/browser/pageDriver.ts) (see [Browser Host](Browser-Host.md)).

Design rationale (why short calls, why synthetic events) is in
[ARCHITECTURE.md: Page blocks and the page agent](../ARCHITECTURE.md#page-blocks-and-the-page-agent) and
[Harder pages](../ARCHITECTURE.md#harder-pages-phase-f).

## Injection and addressing

| Step | Where | What happens |
|---|---|---|
| Build | `agent.content.ts` | WXT content script with `registration: 'runtime'`, `matches: ['<all_urls>']`. Bundled to `/content-scripts/agent.js`; never auto-injected. |
| Install | `main()` | `globalThis.__blockflowAgent ??= createAgent()`. Re-injecting into the same document keeps the existing agent (and its `lastRects`). |
| Call | `pageDriver.callOnce` | `scripting.executeScript({ func, args: [call] })` in the default ISOLATED world, so it sees the content script's `globalThis`. The func returns `__blockflowAgent.run(call)` or `{status: 'missing'}`. |
| Missing | `pageDriver.callAgent` | On `missing`, injects `agent.js` with `files:` and calls once more. A navigation gives a fresh document, so the next call re-injects. |
| Vanished | `pageDriver.callOnce` | `executeScript` returned no result: the page went away mid-call. For actions (`click`, `fill`, `set-field`, `select`, `check`, `press`) the driver returns `{navigated: true}` rather than repeat the action. |
| Frames | `pageDriver.actInTab` | Target is the top frame unless the agent answered `{status: 'frame'}`; then the driver looks the frame up with `webNavigation.getAllFrames` (exact URL, else prefix match) and sends `rest` to that `frameIds: [id]`, re-injecting there if needed. |

There is one agent per document (per frame). Same-origin iframes are entered by the top-frame agent
itself through `contentDocument` (see [Locators: frames](Locators.md#frames)); only cross-origin frames
need their own agent.

### `createAgent(win?, doc?)`

```ts
export function createAgent(win: PageWindow = window as PageWindow, doc: Document = win.document): Agent;
export interface Agent { run(call: AgentCall): Promise<AgentResponse> }
export type PageWindow = Window & typeof globalThis;
```

| Caller | `win` / `doc` | Notes |
|---|---|---|
| `agent.content.ts` | page window / its document | The normal case. |
| [htmlParse.ts](../../src/browser/htmlParse.ts) `runOnHtml` | offscreen (or Firefox background) window / a `DOMParser` document | `budgetMs: 0`; no layout, so geometry checks are skipped. A `frame` answer becomes an error. |
| `tests/dom/agent.test.ts` | jsdom window / document | jsdom has no layout either. |

Constructors (`MouseEvent`, `HTMLInputElement`, `DataTransfer`…) are taken from `win`, never from the
global scope, so an agent can drive a document of another window.

`hasLayout()` is `doc.documentElement.getBoundingClientRect().width > 0`. When false (jsdom, parsed
HTML): visibility is style-only, `isStable` is always true, `coveredBy` always null, and event
coordinates are `0,0`.

## The run loop

```ts
async run({ request, budgetMs }) {
  const deadline = Date.now() + Math.max(0, budgetMs);
  for (;;) {
    try { return { status: 'done', result: attempt(request) }; }
    catch (error) { /* map, or retry if Pending and before deadline */ }
    await sleep(50);   // RETRY_EVERY_MS, via win.setTimeout
  }
}
```

`attempt` is one synchronous try. It communicates by throwing:

| Thrown | Meaning | Answer |
|---|---|---|
| — (returns) | Success | `{status: 'done', result}` |
| `Pending(reason)` | Not possible yet | Retry every 50 ms; at the deadline `{status: 'pending', reason}` (the last reason). |
| `Fatal(message)` | Never going to work | `{status: 'error', message}` immediately. |
| `FrameBoundaryError` | Locator crosses into a cross-origin iframe | `{status: 'frame', src, rest}` immediately. |
| `LocatorError` | Bad locator syntax/CSS/XPath/regex | Wrapped into `Fatal` by `all()`, so `error`. |
| anything else | Bug or page oddity | `{status: 'error', message}`. `run` never rejects. |

`budgetMs` comes from the driver: `min(2000, timeLeft − 150)`. The driver keeps calling until the
block's timeout and then throws `Timed out after Ns: <last reason>`. With `budgetMs: 0` the agent makes
exactly one attempt.

Results must survive `executeScript` structured cloning. Chrome sorts object keys on the way back, which
is why scraping ops return `{columns, values}` arrays (see
[ARCHITECTURE.md: Data and scraping](../ARCHITECTURE.md#data-and-scraping)).

## Dispatch

Field-level details of each request are in [Page Protocol](Page-Protocol.md). This table is what the
agent does with them.

| Op | Finds with | Readiness (`ready(...)`) | Result |
|---|---|---|---|
| `click` | `one` (strict) | visible, enabled (not for `hover`), stable, hit. All skipped with `force`. | `{clicked: describeElement, url}` |
| `fill` | `one` | visible, enabled, editable, stable | `{value}` |
| `set-field` | `one` | visible, enabled, stable; editable only for text fields | depends on field kind, see below |
| `select` | `one` | visible, enabled, stable | `{selected: values[]}` |
| `check` | `one` | visible, enabled, stable | `{changed, checked}` |
| `press` | `one` if `locator`, else `document.activeElement` (or body) | visible, enabled, stable (with locator); focuses it | `{key}` |
| `read` | `all` (first match) | none | `{found: true, text, count}` |
| `wait` | `all` | none (the state is the wait) | `{state, count?}` |
| `detect-form` | `all` (first) | none | `{fields: FormFieldRow[], form: locator \| null}` |
| `info` | — | — | `{url, title}` |
| `extract` | `all`, per field `resolveLocator(field.locator, item)[0]` | none; Pending only if no items | `{columns, values, count}` |
| `table` | `one` | none | `{columns, values, count}` |
| `page-info` | — | — | `{url, title, description, canonical, lang, meta, jsonLd, links}` |
| `storage` | — | — | `{value}` |
| `scroll` | `one` for `to: 'element'` | none | `{height, y}` |
| `upload` | `one`, then input / `label.control` / nested `input[type=file]` | enabled only (hidden inputs allowed) | `{files: names[]}` |
| `locate` | `one` | visible, enabled, editable (fill, or set-field on a text field), stable, hit | `{x, y, kind: 'text' \| 'select' \| 'check' \| 'other'}` |

### Strictness

`one(locator)` is Playwright's strict mode: zero matches is `Pending("waiting for X: no element
matches")`, two or more is `Fatal` listing up to three matches with `describeElement` and suggesting
`>> nth=0`. Reads, waits, extract and detect-form use `all` and are not strict.

`describeElement(el)` (from [locator.ts](../../src/dom/locator.ts)) produces `button#save.primary "Save
changes"`: tag, id, first two classes, and up to 40 chars of accessible name or text. It appears in most
messages.

## Actionability waits

`ready(element, { enabled?, editable?, hit? })` runs these checks in order and throws `Pending` with the
first failing reason:

| Check | Rule | Reason text |
|---|---|---|
| Visible | connected; no `[hidden]` ancestor; no `display:none` on it or an ancestor; not `visibility: hidden/collapse` on itself; non-empty box (layout only). Opacity is not checked. | `waiting for X to be visible` |
| Enabled | not `.disabled`; not in `fieldset[disabled]` (unless inside its `legend`); no `[aria-disabled="true"]` ancestor | `waiting for X to be enabled` |
| Editable | not `readOnly`; not `aria-readonly="true"` | `waiting for X to be editable (it is read-only)` |
| Scroll | if the box is outside the viewport, `scrollIntoView({block: 'center', inline: 'center'})` | — |
| Stable | same rounded `x,y,w,h` as at the previous look (kept in a `WeakMap` per agent) | `waiting for X to stop moving` |
| Hit | `elementFromPoint(center)` (descending into shadow roots) is the element, inside it, a `<label>` for it, or in a shadow tree hosted by it | `X is covered by Y` |

Gotchas:

- Stability needs two looks, so the first attempt on a never-seen element is always Pending; an action
  takes at least one 50 ms retry when there is layout. A scroll-into-view also causes one "stop moving".
- Hit-testing uses the element's own document, so coordinates are those of its frame.
- `check` and `select` do not require `hit`, so a native checkbox covered by a custom styled box still
  works (it is clicked synthetically).

## Synthetic input

All events are created with `win`'s constructors and are `isTrusted: false`. Mouse and keyboard events
are `composed: true`, so they cross shadow boundaries.

| Action | Events (in order) | Default action done by the agent |
|---|---|---|
| hover | pointerover, pointerenter, mouseover, mouseenter, pointermove, mousemove | — |
| click | hover set, then pointerdown, mousedown, (focus unless mousedown cancelled), pointerup, mouseup, click | The browser runs `click`'s default action for dispatched clicks (follow link, toggle checkbox, submit). |
| double | the press sequence twice (`detail` 1, 2), then dblclick | — |
| right | press sequence with `button: 2`, `contextmenu` instead of `click` | — |
| fill (`mode: 'fill'`) | focus, native value setter, `input` (InputEvent `insertText`), `change` | value set |
| fill (`mode: 'type'`) | clear (`input` deleteContentBackward), then per char keydown, keypress, value += char, input, keyup; then `change` | char added only if keydown and keypress were not cancelled |
| fill (contenteditable) | select contents, `execCommand('insertText')`, else `textContent =` + `input` | — |
| select | focus, native setter (or `option.selected` for multiple), `input`, `change` | — |
| check | a full `click`, then verifies `checkedState` changed (Fatal if not) | — |
| press | keydown, keypress (printable or Enter), keyup | printable char typed into inputs/textarea; Enter adds `\n` in textarea, `form.requestSubmit()` in inputs, `.click()` on a/button; Backspace deletes; Tab / Shift+Tab focus the next/previous tabbable; Ctrl+A selects |
| upload | `input.files = DataTransfer.files`, `input`, `change` | — |

**Native setter.** `setNativeValue` calls the `value` setter from `HTMLInputElement.prototype` (or
TextArea/Select), bypassing the instance-level property React installs to track value. That makes React,
Vue and Angular see the following `input` event as a change.

**Key names.** `parseKey('Control+Shift+a')` splits on `+`; modifiers are `ctrl`/`control`, `shift`,
`alt`, `meta`/`cmd`/`command` (case-insensitive). `code` is `KeyA` / `Digit1` for single characters,
else the key name itself.

**Text fields.** `textKind`: `textarea`; `input` of type `''`, text, email, password, search, tel, url,
number, date, time, datetime-local, month, week, color, range; or contenteditable. Anything else makes
`fill` Fatal ("cannot be typed into. Use Select Option, Check or Click instead").

**set-field** picks by element: `<select>` → `select` with the value split on `|`; checkbox / radio /
ARIA switch → `check` with `true/yes/on/1/checked` meaning checked; file input → Fatal; otherwise
`fill`.

### Real input

With `step.realInput`, [pageDriver.ts](../../src/browser/pageDriver.ts) sends `{op: 'locate'}` first (same
waits as the action), takes `{x, y}` and drives `chrome.debugger` `Input.*` events instead
([cdp.ts](../../src/browser/cdp.ts)). The agent's only role is waiting and reporting the center and field
kind; `set-field` on non-text fields and all non-action ops fall back to the synthetic path. See
[Browser Host](Browser-Host.md).

## Shadow DOM

| Area | Behaviour |
|---|---|
| Finding | CSS needs `>>>` to step into open shadow roots; text/role/label/placeholder/alt/title/testid engines search shadow trees automatically (`allElements`). XPath does not. Closed roots are invisible. |
| Hit test | `coveredBy` descends through `shadowRoot.elementFromPoint` and accepts hits inside a shadow tree hosted by the target. |
| Events | `composed: true`, dispatched on the found element itself. |
| Tab order | `tabbables()` uses `doc.querySelectorAll`, so shadow content is skipped. |

## Reading

`read` takes the first match and is not strict:

| `kind` | No match | Value |
|---|---|---|
| `count`, `exists` | answers (`0` / `false`) | `String(count)` / `String(count > 0)` |
| `visible` | answers `false` | any match visible |
| `checked` | answers `false` | first match `checkedState === true` |
| `enabled` | answers `false` | first match enabled and visible |
| `text` | Pending | raw `textContent` (not normalized: Watch Element compares like with like) |
| `value` | Pending | `.value` if the element has one, else `''` |
| `attribute` | Pending | `getAttribute(name) ?? ''` |
| `has-class` | Pending | `classList.contains(name)` |

`wait` text states use `innerText` (falling back to `textContent`) of each match, or of `body`, through
`textMatcher` (substring, `"exact"` or `/regex/`).

Scraping helpers: `textOf` collapses whitespace; `attributeOf` resolves `href`, `src`, `action`, `poster`,
`data-src` against `doc.baseURI`. `table` uses `<thead>`'s first row, else the first row with a `<th>`,
else the first row as headers (empty header → `columnN`).

## Error shapes

What a block ends up seeing (after [pageDriver.ts](../../src/browser/pageDriver.ts)):

| Source | Example message |
|---|---|
| Fatal: strict | `#list li matches 3 elements (li "One", li "Two", li "Three"). Make it more specific, or add ">> nth=0" for the first one.` |
| Fatal: locator | `Invalid CSS selector: ##`, `Unknown role option [bogus]. Use name, exact, checked, level.`, `nth needs a whole number: nth=x` |
| Fatal: wrong element | `select#x is not a <select>. Use Click to open custom dropdowns.`, `… is not a checkbox, radio or switch`, `A radio button cannot be unchecked; check another one instead` |
| Pending at timeout | `Timed out after 30s: waiting for button "Save" to be enabled` |
| Driver | `The tab was closed`, `The browser does not let extensions work on this page: …`, `Timed out after Ns: the page navigated` |

## Gotchas

- `src/dom/*` runs inside web pages: only `import type` from the extension, plus pure `src/core` modules
  ([locatorSyntax.ts](../../src/core/locatorSyntax.ts)). No `browser.*`.
- `isTrusted` is false for everything; sites that check it need real input.
- Opacity-0 and off-screen-clipped elements count as visible.
- `select` only drives native `<select>`; custom dropdowns are clicks.
- New op checklist: add it to `AgentRequest` in `page.ts`, a `case` in `attempt`, a jsdom test in
  `tests/dom/agent.test.ts`, then the block. See [Adding a Block](Adding-a-Block.md).

## See also

- [Page Protocol](Page-Protocol.md): request and response fields
- [Locators](Locators.md): what `one` / `all` resolve
- [Browser Host](Browser-Host.md): `pageDriver.ts`, real input, offscreen HTML parsing
- [Picker and Recorder](Picker-and-Recorder.md): the other two content scripts
- [Testing](Testing.md): jsdom tests and e2e
