# BlockFlow usage guide (for people and AI tools)

BlockFlow is a browser extension (Chrome/Brave/Edge, Firefox; Safari later) for building browser
automations from connected blocks, n8n style: monitoring pages, filling forms, end-to-end tests,
scraping. Everything runs inside the user's own browser, with their logins.

This guide is written so that an AI assistant can **generate correct workflow files** and **explain
how to use BlockFlow** without reading the source code. Read it top to bottom once; then use:

| File | What it is |
| --- | --- |
| [`blocks.md`](blocks.md) | Every block: type id, settings (`config` keys), defaults, outputs. **Generated from the code.** |
| [`blocks.json`](blocks.json) | The same, machine-readable. |
| [`workflow.schema.json`](workflow.schema.json) | JSON Schema of an import file, with every block's config. |
| [`examples/`](examples) | Importable workflow files. A test checks they import without errors. |

If you are changing BlockFlow's code rather than using it, read `CLAUDE.md` and `docs/ARCHITECTURE.md`.

---

## Rules for AI tools generating workflows (read first)

1. Output a JSON file in the **export format** (section 2). Users import it with **Import** in the
   sidebar or the All workflows page. Imported workflows always arrive **off**, with new ids.
2. Block `type` values and `config` keys must come from [`blocks.md`](blocks.md). Unknown keys are
   ignored; unknown types are an error. Missing keys take the block's default.
3. Every page block (Click, Fill, Fill Form, Select Option, Check, Press Key, Wait For, Assert on the
   page, Read Element without a URL, Navigate, Close Tab) needs an **Open Tab** (`type: "open-url"`)
   **earlier on the same path**, with the same `tab` name (default `"main"`).
4. Connect blocks with `edges`. A block with no incoming edge is a **start block**. Use
   `sourcePort` only for blocks with several outputs: `"true"`/`"false"` on If, `"error"` when the
   source has `step.onError: "port"`.
5. Prefer readable locators: `role=button[name="Sign in"]`, `label=Email`, `text=Welcome`,
   `testid=…`; fall back to CSS. A locator that matches two elements makes actions fail (strict).
6. Put passwords and tokens in **secrets** (`{{secret.name}}`), never in the workflow. Tell the user
   which secret names to create (Secrets tab).
7. Do not add waits "just in case": every action already waits for its element. Add **Wait For** only
   for page changes that no later action waits for (a URL change, a message appearing, a spinner
   going away).
8. For tests, check results with **Assert**; for monitoring, with **If** + **Notify**.
9. Values in templates are **strings**. Compare numbers with the numeric operators (`greater`,
   `less`…), which parse `1,250` and `$9.99`.

---

## 1. Concepts

- **Workflow**: a graph of blocks (`nodes`) and connections (`edges`), saved in the extension.
- **Block**: one step: open a tab, click, read a value, compare, notify… Each has settings (`config`).
- **Data (payload)**: a JSON object that flows along connections. Every block receives the data from
  the block before it, and passes data on, usually the same object plus a few keys it adds
  (Read Element adds `value`, `previous`, `changed`, `count`, `url`). Later blocks use it in
  settings with `{{key}}`.
- **Start block**: a block nothing feeds. Timer and Watch Element have their own schedule. Any other
  block at the start runs once with empty data.
- **Run**: one trip of data through the workflow, started by the **▶ Run** button (once, now,
  workflow on or off), by a start block's schedule when the workflow is **On**, or by a Run Workflow
  block. Each block it passes is a **step** with a status: passed, failed, handled (error dealt with),
  skipped.
- **Outputs (ports)**: most blocks have one output, `out`. If has `true` and `false`. A block whose
  step setting `onError` is `"port"` gets an extra `error` output.
- **Tabs of a run**: Open Tab gives its tab a name (`main`); page blocks act on the tab with that name.
  The mapping travels in the data as `$session` (do not set it by hand).

## 2. Workflow file format

```json
{
  "format": "blockflow-workflows",
  "version": 1,
  "workflows": [
    {
      "schemaVersion": 1,
      "id": "any-unique-string",
      "name": "Login test",
      "enabled": false,
      "nodes": [
        { "id": "open", "type": "open-url", "position": { "x": 0, "y": 0 },
          "config": { "url": "https://example.com/login", "where": "window" } },
        { "id": "form", "type": "fill-form", "position": { "x": 260, "y": 0 },
          "config": {
            "fields": [
              { "locator": "label=Email", "value": "me@example.com" },
              { "locator": "label=Password", "value": "{{secret.loginPassword}}" }
            ],
            "submit": "role=button[name=\"Sign in\"]"
          } },
        { "id": "check", "type": "assert", "position": { "x": 520, "y": 0 },
          "config": { "subject": "text", "locator": "role=heading[level=1]", "operator": "contains", "expected": "Welcome" } }
      ],
      "edges": [
        { "id": "e1", "source": "open", "target": "form" },
        { "id": "e2", "source": "form", "target": "check" }
      ]
    }
  ]
}
```

- `id`s: any unique strings within the file (node ids unique within a workflow). Import replaces
  them; Run Workflow references between workflows in the same file are kept working.
- `position`: canvas coordinates; about 260 px apart left to right reads well. Branches: ±140 px in y.
- `step` (optional, per node): see section 7.
- A single workflow object (without the `format` wrapper) also imports.
- Validation the editor applies: required settings present, URLs valid (templates allowed), every
  edge points at existing nodes, no block connected to itself, at least one start block, no block
  that cannot take input placed after another block. Unreachable blocks and loops are warnings.

## 3. Data and templates

Any setting marked "supports `{{…}}`" in [`blocks.md`](blocks.md) is rendered against the incoming
data just before the block runs:

| Template | Gives |
| --- | --- |
| `{{value}}` | key `value` of the data |
| `{{$json.value}}` | same thing, n8n style |
| `{{data.items[0].title}}` | nested keys and array indexes |
| `{{secret.loginPassword}}` | a secret (section 9) |
| `{{error}}` | the error text, on the `error` output |

| `{{ price * 1.1 }}`, `{{ upper(name) }}` | an expression (below) |

Missing keys render as an empty string; objects render as JSON. The result is always a string.
Secrets are available to templates and expressions as `secret.name` but never enter the data.

### Expressions

Used inside `{{ }}`, and **without** braces in fields that expect an expression: For Each / Filter
`list`, Transform `expression`, Save to Dataset / Download `value`. Safe: no JavaScript is executed.

| Kind | Syntax |
| --- | --- |
| values | `12`, `3.5`, `'text'`, `"text"`, `true`, `false`, `null`, `[1, 2]` |
| data | `price`, `item.title`, `rows[0].name`, `items[index]`, `$json.x` |
| math | `+ - * / %`. `+` adds when both sides read as numbers (`"1,250" + 10` → `1260`), else joins text |
| compare | `== != < <= > >=` (compare as numbers when both are numbers, else as text) |
| logic | `&& \|\| !`, `a ? b : c`, `a ?? fallback` |

Functions: `upper lower trim len number string round(x, digits) floor ceil abs min max sum avg count
join(list, sep) split(text, sep) replace(text, find, with)` (find may be `'/regex/'`) `contains
startsWith endsWith slice(x, from, to) first last keys values pluck(list, 'key') unique sort(list,
'key'?) reverse json parseJson now() today() default(x, fallback) matches(text, '/re/i')
extract(text, '/re(group)/')`.

Examples: `sum(pluck(items, 'price'))` · `first(sort(items, 'price')).title` ·
`extract(value, '/#(\d+)/')` · `len(rows) > 0 ? 'some' : 'none'` · `default(name, 'anonymous')`.

## 4. Elements: locators

Every "Element"/"Field" setting is a locator, Playwright style:

| Locator | Finds |
| --- | --- |
| `#save`, `form .primary`, `css=…` | CSS selector (the default) |
| `my-widget >>> button` | inside an open shadow root (web components) |
| `text=Sign in` | element whose text contains "Sign in", any case (smallest such element) |
| `text="Sign in"` | exact text (whitespace normalized) |
| `text=/sign\s?in/i` | regular expression |
| `role=button[name="Save"]` | ARIA role + accessible name (name: contains, any case) |
| `role=button[name="Save"][exact]` | exact name |
| `role=checkbox[checked]`, `role=heading[level=2]` | state / heading level |
| `label=Email`, `label="Email"` | form control by its `<label>`, `aria-label` or `aria-labelledby` |
| `placeholder=you@example.com` | input by placeholder |
| `testid=submit` | `data-testid`, `data-test-id`, `data-test`, `data-cy` or `data-qa` |
| `alt=Logo`, `title=Close` | by `alt` / `title` attribute |
| `xpath=//form//button`, `//form//button` | XPath |
| `#cart >> text=Remove` | the second inside the first |
| `li >> nth=0`, `li >> nth=-1` | first / last match |

Common roles: `button`, `link`, `textbox`, `checkbox`, `radio`, `combobox` (a `<select>`), `heading`,
`listitem`, `row`, `cell`, `dialog`, `switch`, `tab`, `img`.

**Strict**: actions (Click, Fill, Select, Check…) fail if the locator matches more than one element,
with a message listing the matches. Add `>> nth=0` or make it more specific. Reads (Read Element,
Assert text) use the first match.

## 5. Waiting and timeouts

- Each action **auto-waits** until its element: exists exactly once, is visible, enabled (and
  editable for Fill), has stopped moving, and is not covered by something else (a cookie banner, a
  modal). A timeout tells you which of these failed ("is covered by div#overlay").
- Default timeouts: page actions 30 s, Open Tab and Navigate 45 s, Assert 10 s, Manual Step 600 s,
  Run Workflow 300 s, everything else 60 s. Change per block with `step.timeoutSeconds`.
- **Assert** on the page retries until it passes or the timeout ends, like Playwright's `expect`.
- **Wait For** modes: `visible`, `hidden`, `attached`, `detached`, `enabled` (need `locator`);
  `text`, `no-text` (need `text`; `locator` optional to look only inside it); `url` (needs `url`
  pattern); `load`; `networkidle`.
- URL patterns: plain text = "URL contains"; `*` = any characters except `/`, `**` = anything;
  `/regex/flags`.

## 6. Branching

```json
"edges": [
  { "source": "check", "target": "ok",  "sourcePort": "true" },
  { "source": "check", "target": "bad", "sourcePort": "false" }
]
```

If operators (also used by Assert): `equals`, `not-equals`, `contains`, `not-contains`,
`starts-with`, `ends-with`, `matches` (regex, write `/…/flags`), `greater`, `greater-equal`, `less`,
`less-equal` (numbers), `empty`, `not-empty`, `true`, `false` (`true`/`yes`/`on`/`1`).

A block's output goes to **every** block connected to that output, one branch after the other, each
with its own copy of the data.

## 7. Step settings (every block)

```json
"step": { "timeoutSeconds": 15, "retries": 2, "onError": "port", "screenshot": "always", "disabled": false, "note": "flaky on Mondays" }
```

| Key | Meaning |
| --- | --- |
| `onError` | `stop` (default): this path stops, the run fails. `continue`: pass the input on as if it worked. `port`: send `{...input, error, errorBlock}` out of the `error` output (connect it with `"sourcePort": "error"`). |
| `retries` | 0 to 5 extra attempts, waiting 1 s, 2 s, 4 s… |
| `timeoutSeconds` | the step fails after this long |
| `screenshot` | `error` (default), `always`, `never`. Of the run's tab, only while that tab is showing in its window (Open Tab with `"where": "window"` is best for tests) |
| `disabled` | skip the block, pass the data through |
| `note` | text shown on the block |

## 8. Starting a workflow

| Start block | Starts when | On ▶ Run |
| --- | --- | --- |
| `start` (Start) | only by hand, or when called by Run Workflow; gives named starting values (a caller's values win) | yes |
| `timer` | every N seconds while On (or once) | fires once now |
| `schedule` | at set times while On: `every: "day"` + `at: "09:00"` + `days: "weekdays"` / `"mon,fri"`; `every: "hour"` + `minute`; `every: "minutes"` + `minutes` (on the clock) | fires once now |
| `page-visited` | while On, when any tab loads a page whose URL matches `url` (`when: "any"` also on SPA route changes). Tabs BlockFlow opened never trigger it. The tab becomes `main`. | uses the tab you are on |
| `context-menu` | while On, when you choose its item (`title`) in the right-click menu; gives `url`, `selection`, `link`, `src` | uses the tab you are on |
| `watch-element` | while On, when an element's text changes | reads once now |
| any other block | once when switched On (with empty data) | runs once |

A workflow may have several start blocks; each starts its own runs.

## 9. Running, results, reports

- **▶ Run** (header): runs the workflow once, now. A Timer at the start fires immediately; Watch
  Element reads once. **■ Stop** cancels before the next block.
- **On/Off** switch: background mode. Start blocks run on their schedules until switched off.
- After a run, blocks show ✓ / ✕ / ↪; click a block to see its **input and output** for that run.
- **Runs** tab (bottom panel) and **Reports** page (header): last 40 runs, filter, step details with
  screenshots, the run of a called workflow, exports: **HTML** (self-contained, screenshots
  embedded), **JUnit XML** (for CI dashboards), **JSON**.
- If the browser stops the extension's background worker during a run, the run is marked
  **interrupted**.

## 10. Building workflows in the editor

- **● Record**: opens a page in a new tab and turns what you do into blocks: typing (one Fill per
  field; two or more fields + a click become Fill Form with that click as submit), selects,
  checkboxes, clicks, Enter, page changes (Wait For URL). The on-page toolbar adds **Assert text** /
  **Assert visible** for the next element you click. Passwords are never recorded: the blocks use
  `{{secret.password}}`.
- **🎯 Pick on page**: click the element; Enter confirms. Action fields get the most readable
  unique locator (`role=…`, `label=…`, `testid=…`); Watch/Read Element get a structural CSS selector
  (stable when the text changes). Other ways to find it are offered as one-click alternatives.
- **🎯 Detect fields** (Fill Form): click any field of a form; all its fields are listed with hints.
- Typing `{{` in a setting suggests names: outputs of earlier blocks, keys seen in the last run,
  `secret.*`.
- **+ New ▾** → templates (the files in [`examples/`](examples)).
- Keys on the canvas: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl+Y redo, Ctrl+C / Ctrl+V copy and
  paste blocks (also into another workflow), Ctrl+D duplicate, Delete/Backspace remove.

## 11. Secrets

Header → **Secrets**: name/value pairs, e.g. `loginPassword`. Use as `{{secret.loginPassword}}` in
any templated setting. Their values are replaced by `•••` in the run log, step inspector, run records
and reports, and are never part of exported workflows. They are stored unencrypted in the browser
profile's extension storage.

## 12. Testing patterns

- **Test = workflow** starting with Open Tab, ending with Asserts. Run with ▶ Run; read the result in
  Reports.
- **Reuse** a login (or any setup) with **Run Workflow**: the called workflow receives the caller's
  data (including the tab), and its last block's data comes back. Its run appears separately, linked.
- **Soft assert** (`"soft": true`): record a failure, keep checking the rest.
- **Expected failure path**: `step.onError: "port"` on the block that may fail, then handle the
  `error` output (Notify, Stop, Log).
- **Stop** block: end a path as passed or failed with a message.
- **Manual Step**: the run waits for a person (CAPTCHA, 2FA) until they press Continue in the
  notification or the editor banner.
- **Data-driven tests**: Data Table (CSV/JSON) → For Each (`each` output) → the test steps using
  `{{row.email}}`. Use `step.onError: "continue"` or soft Asserts so one bad row does not stop the rest.

## 13. Scraping and data

- **One page**: `Open Tab → Extract List` with an item locator (`.product-card`) and fields
  (`name`, `locator` inside the item, optional `attribute` such as `href`). Result: `{{items}}`, a list
  of objects in field order; links come back absolute.
- **Many pages**: `Paginate` (Next locator) with Extract List + Save to Dataset on its `each` output,
  and Download on `done`.
- **Infinite lists**: `Scroll` with `to: "end"` before Extract List.
- **Tables**: `Extract Table` (rows keyed by header text).
- **Without a tab** (static pages, faster): `HTTP Request → Extract List/Table` with
  `source: "html"`, `html: "{{body}}"`, `baseUrl: "{{url}}"`.
- **Lists**: `For Each` (runs `each` per item, then `done`), `Filter` (per-item condition with
  `{{item.x}}`), `Transform` (typed values from expressions), `Repeat` (N times).
- **Keeping data**: `Save to Dataset` (append/replace, kept in the browser; see the **Data** page,
  which downloads CSV/JSON) and `Download` (CSV, JSON or text file into Downloads).
- **The page itself**: `Page Info` (title, meta, canonical, JSON-LD) or its localStorage /
  sessionStorage / cookies.

## 14. Monitoring patterns

- `Timer (repeat) → Read Element (Page URL) → If → Notify`: Read Element with a Page URL uses
  BlockFlow's own background tab and reloads it each time. `{{previous}}` and `{{changed}}` compare
  with the last run: `If {{value}} less {{previous}}` = "price dropped".
- `Watch Element → Notify`: fires only when the text changes.
- `Timer → HTTP Request → Assert {{status}} equals 200 (onError: port) → Notify`: uptime check.

## 15. Examples

| File | Shows |
| --- | --- |
| [`login-test`](examples/login-test.blockflow.json) | Fill Form with a secret, Wait For URL with an error branch, Assert |
| [`reusable-login`](examples/reusable-login.blockflow.json) | two workflows: a reusable login and a test that calls it |
| [`price-watch`](examples/price-watch.blockflow.json) | monitoring with `{{previous}}` |
| [`api-uptime`](examples/api-uptime.blockflow.json) | HTTP Request + Assert + error output |
| [`dark-mode-watch`](examples/dark-mode-watch.blockflow.json) | reading a class on `<html>`, `{{changed}}` |
| [`scrape-to-csv`](examples/scrape-to-csv.blockflow.json) | Paginate + Extract List + dataset + CSV download |
| [`data-driven-login`](examples/data-driven-login.blockflow.json) | Data Table + For Each + soft Assert, a secret chosen by an expression |
| [`api-to-dataset`](examples/api-to-dataset.blockflow.json) | HTTP Request + Transform + dataset history + If |

## 16. Limits (what a browser extension cannot do, or BlockFlow does not do yet)

- Page events are synthetic (`isTrusted: false`); a few sites (anti-bot checks, some payment
  widgets) ignore them.
- Not reachable yet: iframes, closed shadow roots, native file pickers (file upload), browser dialogs
  (`alert`/`confirm`).
- Pages browsers protect: `chrome://`, the extension stores, other extensions, PDF viewer. `file://`
  only after the user enables "Allow access to file URLs".
- CAPTCHAs and 2FA are not bypassed: use Manual Step.
- Background tabs are throttled by the browser; use `"where": "window"` for tests that need
  animations, lazy loading or screenshots.
- Runs stop after 1000 blocks (loop guard). Run history keeps 40 runs; payloads over 3 KB are stored
  as a preview.
- Firefox: grant site access in `about:addons` → BlockFlow → Permissions.
