# Page Protocol

The plain-data contract between page blocks (in the engine) and the page agent (inside web pages):
every request op, its fields, the result it answers with, and which agent function carries it out. Read
this before adding a page ability or changing what a page block sends. The flow itself
(driver, injection, retry slices) is explained in
[ARCHITECTURE: Page blocks and the page agent](../ARCHITECTURE.md#page-blocks-and-the-page-agent).

**Source:** [page.ts](../../src/core/page.ts) (types), handled by
[agent.ts](../../src/dom/agent.ts) (`attempt()` dispatch), driven by
[pageDriver.ts](../../src/browser/pageDriver.ts)

## The path of one request

```text
block ── inPage()/ctx.host.page.act(tabId, request, timeoutMs, {realInput?}) ──▶ pageDriver.act
pageDriver ── executeScript: agent.run({ request, budgetMs ≤ 2s }) ──▶ agent (isolated world)
agent: attempt(request) every 50 ms until done / error / budget spent
       ◀── AgentResponse ──
pageDriver: done → result · error → throw · pending → ask again until timeoutMs · frame → re-target
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
| `AgentResponse` | `{ status: 'done', result }` · `{ status: 'pending', reason }` (not possible yet; the driver asks again) · `{ status: 'error', message }` (will never work) · `{ status: 'frame', src, rest }` (locator crosses into a cross-origin iframe; run `rest` in the frame showing `src`). |
| `ReadKind` | `text`, `value`, `attribute`, `has-class`, `exists`, `count`, `visible`, `checked`, `enabled`. |
| `WaitState` | `visible`, `hidden`, `attached`, `detached`, `enabled`, `text`, `no-text`. |
| `WaitUntil` | `load`, `networkidle`, `none` (tab operations, not agent ops). |
| `UploadFile` | `{ name, type, base64 }`. |
| `ExtractField` | `{ name, locator?, attribute? }`. |
| `FormFieldRow` | `{ locator, value, hint? }`: a Fill Form row and what Detect fields returns. |

Inside the agent, `Pending` errors become `pending` (retried), `Fatal` and any other error become `error`,
`FrameBoundaryError` becomes `frame`. The driver adds two outcomes of its own: `missing` (agent not
injected yet: inject `agent.js`, ask again) and `vanished` (no answer because the page navigated). After
`vanished`, an action op (`click`, `fill`, `set-field`, `select`, `check`, `press`) returns
`{ navigated: true }` instead of repeating, so a form is never submitted twice.

## Readiness ("auto-wait")

Action ops find their element with `one(locator)` (exactly one match, else `pending` for none, `error` for
several, with a `>> nth=0` hint) and call `ready(element, needs)`:

| Check | Pending reason |
| --- | --- |
| visible | `waiting for … to be visible` |
| enabled (`needs.enabled`) | `… to be enabled` |
| editable (`needs.editable`) | `… to be editable (it is read-only)` |
| stable (same box on two looks 50 ms apart) | `… to stop moving` |
| hit target (`needs.hit`): `elementFromPoint` at the center is the element (or its label) | `… is covered by …` |

Geometry checks (stable, hit) are skipped where there is no layout (jsdom, `Host.html.act`).

## Ops

| Op | Fields | Agent handler | Ready checks | `result` | Sent by |
| --- | --- | --- | --- | --- | --- |
| `click` | `locator`, `action: click \| double \| right \| hover`, `force?` | inline → `click()` | visible, enabled (not for hover), stable, hit; all skipped with `force` | `{ clicked, url }` | Click, Fill Form submit, Paginate |
| `fill` | `locator`, `value`, `mode: fill \| type` | inline → `fill()` | visible, enabled, editable | `{ value }` | Fill |
| `set-field` | `locator`, `value` | `setField()` | visible, enabled, editable for text fields | select: as `select` (value split on `\|`); checkbox/radio/switch: as `check` (`true/yes/on/1/checked`); text: `{ value }`. File inputs → error. | Fill Form |
| `select` | `locator`, `values: string[]` | `select()` | visible, enabled | `{ selected: string[] }` (option values). Not a `<select>` → error; missing option → pending. | Select Option |
| `check` | `locator`, `checked` | `check()` | visible, enabled | `{ changed, checked }`. Unchecking a radio → error. | Check |
| `press` | `key` (combo like `Control+a`), `locator?` | `press()` | with a locator: visible, enabled, then focus | `{ key }`. Without a locator the focused element (or body) gets the keys. | Press Key |
| `read` | `locator`, `kind: ReadKind`, `name?` | `read()` | none | `{ found: true, text, count }`. `count`/`exists`/`visible`/`checked`/`enabled` answer even with no match; other kinds wait for a match. `text` is raw `textContent`. | Read Element, Assert, Paginate, `pageReader` (Watch Element), driver (real-input check) |
| `wait` | `state: WaitState`, `locator?`, `text?` | `wait()` | n/a | `{ state, count? }`; pending until the state holds. `text`/`no-text` search `innerText` of the locator's matches or the body. | Wait For |
| `detect-form` | `locator` | `detectForm()` | n/a | `{ fields: FormFieldRow[], form }`: visible fields of the enclosing `<form>` (or the element), skipping hidden/submit/button/reset/image/file inputs. | `src/browser/picking.ts` (Detect fields) |
| `info` | none | inline | n/a | `{ url, title }` | nothing currently |
| `extract` | `locator`, `fields: ExtractField[]`, `limit?` | `extract()` | n/a | `{ columns, values, count }` (rows of cells; no fields = one `text` column). `href`/`src`/`action`/`poster`/`data-src` attributes are made absolute. Pending while nothing matches. | Extract List (`tableToObjects` rebuilds objects) |
| `table` | `locator` | `table()` | n/a | `{ columns, values, count }`; header = `<thead>` row, else first row with `<th>`, else first row. Not a table → error. | Extract Table |
| `page-info` | none | `pageInfo()` | n/a | `{ url, title, description, canonical, lang, meta, jsonLd, links }` | Page Info |
| `storage` | `area: local \| session \| cookies`, `key?` | `storage()` | n/a | `{ value }`: one item (or null) or all of them. Cookies are those visible to the page (no HttpOnly). | Page Info (storage mode) |
| `scroll` | `to: bottom \| top \| element`, `locator?` | `scroll()` | n/a | `{ height, y }` | Scroll |
| `upload` | `locator`, `files: UploadFile[]` | `upload()` | enabled (a hidden input is fine) | `{ files: string[] }`. Accepts the input, a label, or an element containing the input. | Upload File |
| `locate` | `locator`, `purpose: click \| fill \| set-field \| check \| press` | `locate()` | visible, enabled, stable, hit; editable for `fill` (and `set-field` on text) | `{ x, y, kind: select \| check \| text \| other }` (viewport center) | `pageDriver.actWithRealInput` only |

### Real input

When the step has `realInput` and the op is an action, `pageDriver.act` first sends `locate`, then drives
the mouse/keyboard through the debugger (`src/browser/cdp.ts`). Results then carry `real: true`; `select`
and non-text `set-field` fall back to the normal agent path. See [Browser Host](Browser-Host.md).

## Adding an op

1. Add the variant to `AgentRequest` in `page.ts` (plain data only).
2. Handle it in `attempt()` in `src/dom/agent.ts`; throw `Pending` for "not yet", `Fatal` for "never".
   Add a jsdom test in `tests/dom/agent.test.ts`.
3. If it is an action that may navigate, add it to `ACTIONS` in `pageDriver.ts`.
4. Use it from a block via `inPage`, and teach `tests/helpers/fakeHost.ts` if block tests need it.

## See also

- [Page Agent](Page-Agent.md): the agent's implementation (events, values, keys)
- [Locators](Locators.md): locator syntax and resolution
- [Browser Host](Browser-Host.md): `pageDriver`, frames, real input
- [Core Engine](Core-Engine.md#the-host-interface): `Host.page`
- [Adding a Block](Adding-a-Block.md)
