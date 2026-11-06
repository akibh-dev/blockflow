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
| [`workflow.schema.json`](workflow.schema.json) | JSON Schema of an import file, with every block's config (unknown keys not allowed). |
| [`examples/`](examples) | Importable workflow files. A test checks they import without errors or warnings. |
| [Repair](#repair-what-import-errors-mean) | What each import error code means and how to fix it. |

If you are changing BlockFlow's code rather than using it, read `CLAUDE.md` and `docs/ARCHITECTURE.md`.

---

## Rules for AI tools generating workflows (read first)

1. Output a JSON file in the **export format** (section 2). Users import it with **Import** in the
   sidebar or the All workflows page. Imported workflows always arrive **off**, with new ids.
2. Block `type` values and `config` keys must come from [`blocks.md`](blocks.md). Unknown types,
   unknown config or step keys, wrong value types and options that do not exist are **errors**: the
   whole file is refused, with a list of problems (code, JSON path, did-you-mean). Missing keys take the
   block's default. When you get that list back, fix each path it names (see [Repair](#repair-what-import-errors-mean)).
3. Every page block (Click, Fill, Fill Form, Select Option, Check, Press Key, Upload File, Scroll,
   Dialogs, Wait For, Run Script, Assert on the page, Read Element without a URL, Extract List / Extract
   Table / Page Info / Paginate from a tab, Navigate, Wait for Popup, Close Tab) needs an **Open Tab**
   (`type: "open-url"`) **earlier on the same path**, with the same `tab` name (default `"main"`).
   (Page Visited and Context Menu start blocks also provide `main`.)
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
- **Start block**: a block nothing feeds. Timer, Schedule, Page Visited, Context Menu and Watch
  Element have their own trigger (section 8). Any other block at the start runs once with empty data.
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
      "schemaVersion": 2,
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
  them; Run Workflow references between workflows in the same file are kept working. A file whose
  edges name a missing node id, or that repeats a node id, is refused (`edge.endpoint.missing`,
  `node.id.duplicate`).
- `position`: canvas coordinates; about 260 px apart left to right reads well. Branches: ±140 px in y.
- `step` (optional, per node): see section 7.
- A single workflow object (without the `format` wrapper) also imports.
- Import checks the whole file first and refuses it on any **error**; **warnings** import with a
  notice. Errors: unknown types and keys, wrong types, invalid options, missing required settings
  (including ones another setting needs, e.g. `locator` for an Assert on an element), invalid URLs and
  locators, broken `{{ }}`, connections to missing blocks or from outputs a block does not have, a block
  connected to itself, no start block, Run Workflow calling a workflow not in the file. Warnings:
  unreachable blocks, loops, a page block without an Open Tab on every path to it, unknown secrets.
  Every code is in [Repair](#repair-what-import-errors-mean).

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
| `frame=#pay >> label=Card number` | inside an iframe (same site or another site) |

Common roles: `button`, `link`, `textbox`, `checkbox`, `radio`, `combobox` (a `<select>`), `heading`,
`listitem`, `row`, `cell`, `dialog`, `switch`, `tab`, `img`.

**Strict**: actions (Click, Fill, Select, Check…) fail if the locator matches more than one element,
with a message listing the matches. Add `>> nth=0` or make it more specific. Reads (Read Element,
Assert text) use the first match.

## 5. Waiting and timeouts

- Each action **auto-waits** until its element: exists exactly once, is visible, enabled (and
  editable for Fill), has stopped moving, and is not covered by something else (a cookie banner, a
  modal). A timeout tells you which of these failed ("is covered by div#overlay").
- Default timeouts: page actions 30 s, Open Tab and Navigate 45 s, Assert 10 s, Dialogs 15 s,
  Scroll 120 s, Manual Step 600 s, Run Workflow 300 s, Paginate 1800 s, For Each and Repeat 3600 s
  (a loop's timeout covers all its iterations), everything else 60 s (`blocks.md` lists each block's). Change per block with `step.timeoutSeconds`.
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
| any other block | once when you switch the workflow On (with empty data); not again when you edit it or the browser starts | runs once |

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
  **Assert visible** for the next element you click. It also records inside iframes (locators start
  with `frame=…`) and web components (open shadow roots), and follows tabs the page opens: a **Wait
  for Popup** block, then the steps there with `"tab": "popup"`. Passwords are never recorded: each
  password field gets its own secret named after its label or name (`{{secret.password}}`,
  `{{secret.adminPassword}}`…), and the editor lists the secrets to create. In a workflow that
  already has blocks, the recording continues after the selected block (or the last block of the
  main path), to its right and connected to it; if the workflow already opens that site, no second
  Open Tab is added and the recorded blocks use that Open Tab's tab.
- **🎯 Pick on page**: click the element; Enter confirms. Action fields get the most readable
  unique locator (`role=…`, `label=…`, `testid=…`); Watch/Read Element get a structural CSS selector
  (stable when the text changes). Other ways to find it are offered as one-click alternatives.
  Elements inside iframes get `frame=<iframe css> >> …`, inside open shadow roots `host >>> …` when no
  readable locator fits. The page: the block's own URL (Watch/Read Element), else the URL of the
  nearest Open Tab before the block, else your last-used tab. Each editor keeps one picker tab and
  reuses it: a block's own URL sends it to that page, an Open Tab's URL only when it shows another
  site (so you can log in or go deeper there first, and the next pick stays on that page).
- **🎯 Detect fields** (Fill Form): click any field of a form; all its fields are listed with hints.
- Typing `{{` in a setting suggests names: outputs of earlier blocks, keys seen in the last run,
  `secret.*`.
- **+ New ▾** → templates (the files in [`examples/`](examples)).
- **Try it** card (first run, on the canvas until closed): start the practice page with
  `npm run playground` (serves `docs/manual-test` at `http://localhost:7357`), then **Create the
  Try-it workflow** makes the [`playground-tour`](examples/playground-tour.blockflow.json) workflow;
  press ▶ Run.
- Keys on the canvas: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl+Y redo (each workflow keeps its own
  history while you switch between them), Ctrl+C / Ctrl+V copy and paste blocks (also into another
  workflow; they land where the mouse is, or 40 px further on when it has not moved), Ctrl+D
  duplicate, Delete/Backspace remove.
- Messages appear as small notes in the bottom right corner; deleting asks in a dialog inside the
  editor (Escape cancels).
- The step setting **Use real mouse and keyboard** is only offered on blocks that act on the page
  (Click, Fill, Fill Form, Select Option, Check, Press Key, Paginate; `realInput` in
  [blocks.md](blocks.md)).
- A workflow with problems cannot be switched on: its switch (header and All workflows) is greyed out
  until they are fixed; **Turn all on** leaves such workflows off and names them.

## 11. Secrets

Header → **Secrets**: name/value pairs, e.g. `loginPassword`. Use as `{{secret.loginPassword}}` in
any templated setting. Their values are replaced by `•••` in the run log, step inspector, run records
and reports, and are never part of exported workflows. They are stored unencrypted in the browser
profile's extension storage.

## 12. Harder pages

| Situation | Use |
| --- | --- |
| A site ignores synthetic clicks/typing (checks `event.isTrusted`) | step setting `"realInput": true` on Click / Fill / Fill Form / Check / Press Key. Uses the browser's debugger (Chrome, Edge, Brave; optional permission, asked when ticked; a "debugging" bar shows while it acts). Works inside iframes too, same-site and cross-site. Also lets failed steps in background tabs get screenshots |
| Payment / login widget in an iframe | `frame=<iframe css> >> <locator>` in any locator; cross-origin frames work too. When `frame=` matches several iframes, every same-site one is searched; a cross-site one is used when they find nothing. Pick on page and Record write these locators for you |
| Web components (open shadow roots) | `text=`, `role=`, `label=`… look inside them; CSS needs `host >>> inner`. Pick on page and Record see inside them |
| "Sign in with…" popup, `target=_blank` link | Click, then **Wait for Popup** (`name: "popup"`), then blocks with `"tab": "popup"` |
| `alert` / `confirm` / `prompt` | **Dialogs** (`accept` + prompt `text`, or `dismiss`) **before** the click that opens them; `read` returns `{{dialogs}}` / `{{lastDialog}}` |
| File chooser | **Upload File** on the `<input type="file">` (hidden ones too, or its label): text you write, or a file from a URL |
| Wait for an API call instead of the UI | **Wait For** `mode: "response"`, `url` pattern, optional `status` (`201`, `2xx`). A response that finished during the previous block counts |
| Anything no block does | **Run Script**: async JS body, sees `data`, `return` a JSON value. Needs Chrome 135+, the userScripts permission (Grant button) and "Allow User Scripts" / developer mode for BlockFlow |
| Run the same test in CI | 🎭 **Playwright** export (sidebar row or All workflows): a `.spec.ts` for `npx playwright test`. Templates, expressions and the data blocks (Data Table, Transform, Filter, Set Variable, For Each, Repeat, If) behave as in BlockFlow, because the spec carries BlockFlow's own template/expression/CSV code. Asserts retry (`toHaveText`, `toHaveURL`, `expect.poll` for the other operators; soft → `expect.soft`); Wait For response, Dialogs, Upload File, Wait for Popup, Run Script and Timer delays map to Playwright; step timeouts, retries and error handling (`continue`, error output) are kept. Secrets become environment variables (`{{secret.loginPassword}}` → `LOGINPASSWORD`); Run Workflow calls become functions; what has no equivalent (Notify, Save to Dataset, Download) becomes a `// BlockFlow-only:` comment. Details: [wiki](../wiki/Workflows-as-Scripts.md#export-to-playwright) |

## 13. Testing patterns

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

## 14. Scraping and data

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

## 15. Monitoring patterns

- `Timer (repeat) → Read Element (Page URL) → If → Notify`: Read Element with a Page URL uses
  BlockFlow's own background tab and reloads it each time. `{{previous}}` and `{{changed}}` compare
  with the last run: `If {{value}} less {{previous}}` = "price dropped".
- `Watch Element → Notify`: fires only when the text changes.
- `Timer → HTTP Request → Assert {{status}} equals 200 (onError: port) → Notify`: uptime check.

## 16. Examples

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
| [`playground-tour`](examples/playground-tour.blockflow.json) | the "Try it" workflow: Click, Fill, Select Option and Assert on `docs/manual-test/playground.html` (`npm run playground`) |

## 17. Limits (what a browser extension cannot do, or BlockFlow does not do yet)

- Page events are synthetic (`isTrusted: false`) unless `realInput` is on (Chromium only). Real input
  inside iframes assumes the page is not zoomed or CSS-transformed around the frame.
- The recorder names every popup `popup`: with two popups open at once, steps in the older one are
  attributed to the newer. Iframes added after the page finished loading are not recorded (reload
  or record again); a frame whose parent page does not answer BlockFlow's question about which
  iframe it is (a page that swallows `message` events) records nothing.
- Closed shadow roots, drag and drop, and file *drop zones* (not inputs) are not supported.
- Run Script needs Chrome 135+ with user scripts allowed; Firefox and older Chrome explain that.
- Pages browsers protect: `chrome://`, the extension stores, other extensions, PDF viewer. `file://`
  only after the user enables "Allow access to file URLs".
- CAPTCHAs and 2FA are not bypassed: use Manual Step.
- Background tabs are throttled by the browser; use `"where": "window"` for tests that need
  animations, lazy loading or screenshots.
- Runs stop after 1000 blocks (loop guard). Run history keeps 40 runs; payloads over 3 KB are stored
  as a preview.
- Firefox: grant site access in `about:addons` → BlockFlow → Permissions.

## Repair: what import errors mean

Import reports every problem as `<level> <code> at <path>: <message> <hint>`, for example
`error config.key.unknown at /workflows/0/nodes/1/config/locater: Block "go" (click) has no setting "locater". Did you mean "locator"?`.
`path` is a JSON Pointer into the file as written: `/workflows/0/nodes/1/config/locater` is the key
`locater` in the `config` of the second node of the first workflow (`/nodes/1/...` for a bare workflow).
**Errors** refuse the whole file, **warnings** import with a notice, **info** is a note. The codes are stable.

| Code | Level | Meaning | Fix |
| --- | --- | --- | --- |
| `json.invalid` | error | Not JSON. The message gives the parser's position. | Remove trailing commas and comments, quote keys. |
| `file.shape` | error | Not a workflow file: not an object, `workflows`/`nodes`/`edges` not lists, a node without string `id`/`type`, `config`/`step` not objects, unknown `format`, schema newer than this BlockFlow. | Follow section 2. `edges: []` when there are none. |
| `file.key.unknown` | warning | A key BlockFlow does not read on the file, a workflow, a node or a connection (ignored). | Use the hinted key (`config`, not `settings`; `source`, not `from`; `sourcePort`, not `sourceHandle`). |
| `node.id.duplicate` | error | Two nodes in one workflow share an `id`. | Give each node its own id. |
| `node.type.unknown` | error | `type` is not a block. | Use the hinted type, or one from [`blocks.md`](blocks.md) (Open Tab is `open-url`). |
| `config.key.unknown` | error | A `config` key (or a column in a list setting like Fill Form's `fields`) the block does not have. | Use the hinted key; the hint lists valid keys when nothing is close. |
| `config.key.renamed` | info | An old key name (`selector` on Read/Watch Element, `next` on Paginate). It is moved on import. | Use the new name (`locator`). |
| `config.type` | error | Wrong JSON type: text as a number, `"true"` in quotes, a list setting that is not a list. | Strings in quotes, numbers and `true`/`false` without. |
| `config.required` | error | A required setting is missing or empty, or a setting another one needs (Assert on an element → `locator`; Wait For `text` mode → `text`; Upload File from a URL → `url`; Download a dataset → `dataset`; Navigate `goto` → `url`; a list row without its first column). | Fill in the setting at the path. |
| `config.enum` | error | A choice that is not one of the options. | Use the hinted value; the hint lists the options. |
| `config.value` | error | A value of the right type that is not allowed: a number out of range, a Schedule time that is not `HH:MM`. | See the setting's notes in [`blocks.md`](blocks.md). |
| `config.locator.invalid` | error | A locator that cannot work: unclosed quote or bracket, an unknown `engine=` (`rol=button`), `nth=` without a number. | Fix the syntax (section 4). Templated locators are checked when the block runs. |
| `config.url.invalid` | error | Not an http(s) URL (`javascript:`, `file:`, garbage). | A full `https://…` address, or a `{{template}}`. |
| `config.template.invalid` | error | A broken `{{ … }}`: unbalanced braces or a bad expression. | Fix the expression (section 3). |
| `config.template.unsupported` | warning | `{{ … }}` in a setting that does not render templates; the braces stay as typed. | Remove the braces. Expression settings (For Each / Filter `list`, Transform, Save to Dataset / Download `value`) take `items`, not `{{items}}`. |
| `step.key.unknown` | error | A `step` key that does not exist. | `timeoutSeconds`, `retries`, `onError`, `disabled`, `note`, `screenshot`, `realInput` (section 7). |
| `step.value` | error | A bad `step` value (`retries` above 5, `onError: "ignore"`…). | See section 7. |
| `edge.endpoint.missing` | error | A connection's `source` or `target` is not a node id in that workflow. | Use the hinted id. |
| `edge.port.unknown` | error | `sourcePort` names an output the block does not have, or `"error"` on a block without `step.onError: "port"`. | Use the hinted output (`true`/`false` on If, `each`/`done` on loops), or add `"step": {"onError": "port"}`. |
| `edge.target.no-input` | error | A connection into a block that only starts workflows (Schedule). | Remove the connection. |
| `edge.duplicate` | warning | The same connection twice. | Remove one. |
| `graph.no-start` | error | Every block has an incoming connection, so nothing starts the workflow (a warning for a workflow with no blocks). | Remove the connection into the first block. |
| `graph.cycle` | warning (error for a block connected to itself) | A connection back to an earlier block makes a loop; runs stop after 1000 blocks. | Loop with Repeat, For Each or Paginate (their `each` output) instead. |
| `graph.unreachable` | warning | A block no start block leads to; it never runs. | Connect it, or remove it. |
| `page.no-tab` | warning | A page block whose tab (`tab`, default `main`) is not opened on every path to it. | Add an Open Tab (`open-url`) with that `tab` earlier on every path, or fix `tab`. Fine for a workflow called by Run Workflow from one that opened the tab. |
| `workflow.call.missing` | error | Run Workflow's `workflow` is not the `id` of a workflow in the file or already saved. | Put the called workflow in the same file and use its `id` (not its name). |
| `secret.unknown` | warning | `{{secret.x}}` names a secret the user has not created. | Create the secret (Secrets tab) before running, or fix the name. |
