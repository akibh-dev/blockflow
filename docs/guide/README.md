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
| [`report.schema.json`](report.schema.json) | JSON Schema of the JSON report (Reports → Export JSON): runs, steps, [error codes](#error-codes). **Generated.** |
| [`examples/`](examples) | Importable workflow files. A test checks they import without errors. |

If you are changing BlockFlow's code rather than using it, read `CLAUDE.md` and `docs/ARCHITECTURE.md`.

---

## Rules for AI tools generating workflows (read first)

1. Output a JSON file in the **export format** (section 2). Users import it with **Import** in the
   sidebar or the All workflows page. Imported workflows always arrive **off**, with new ids.
2. Block `type` values and `config` keys must come from [`blocks.md`](blocks.md). Unknown keys are
   ignored; unknown types are an error. Missing keys take the block's default.
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
10. Ask for a **page snapshot** before writing locators, and copy locators from it as they are
    ([below](#getting-locators-from-a-page-snapshot)). When a run fails, read the step's **error code**
    ([table](#error-codes)) and fix what it names.

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
  edges name a missing node id, or that repeats a node id, is refused with a message naming the id.
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
| `frame=#pay >> label=Card number` | inside an iframe (same site or another site) |

Common roles: `button`, `link`, `textbox`, `checkbox`, `radio`, `combobox` (a `<select>`), `heading`,
`listitem`, `row`, `cell`, `dialog`, `switch`, `tab`, `img`.

**Strict**: actions (Click, Fill, Select, Check…) fail if the locator matches more than one element,
with a message listing the matches. Add `>> nth=0` or make it more specific. Reads (Read Element,
Assert text) use the first match.

### Getting locators from a page snapshot

A page snapshot is an outline of what is on a page, with a ready-made locator for each element that a
step could use. Two ways to get one:

- In the editor: select an **Open Tab** block and press **📸 Snapshot page**. BlockFlow opens its URL,
  takes the snapshot and copies it to the clipboard. Paste it into the chat with the AI tool.
- In a workflow: the **Page Snapshot** block (`type: "page-snapshot"`) outputs `snapshot` (the text) and
  `elements` (a list of `{ref, role, name, tag, locator, value?, checked?, disabled?, level?, url?}`),
  for the whole page or one part (`locator`). Useful to record what a page looked like during a run.

```text
# Page snapshot: Log in
URL: https://example.com/login
- main
  - heading "Log in" [level=1] [ref=e1] locator=role=heading[name="Log in"]
  - form "Login" [ref=e2] locator=role=form[name="Login"]
    - textbox "Email" [required] [ref=e3] locator=label="Email"
    - textbox "Password" [password] [ref=e4] locator=label="Password"
    - checkbox "Remember me" [ref=e5] locator=label="Remember me"
    - button "Sign in" [ref=e6] locator=role=button[name="Sign in"]
  - link "Forgot password?" [url="/reset"] [ref=e7] locator=role=link[name="Forgot password?"]
```

Each line is `role "name" [state…] [ref] locator=…`. The locator finds exactly that element (inside
frames it starts with `frame=… >> `), so a workflow can use it unchanged:
`{ "type": "fill", "config": { "locator": "label=\"Email\"", "value": "{{email}}" } }`. `[ref=…]` ids only
number the lines of one snapshot; do not use them as locators. States: `[checked]`, `[disabled]`,
`[expanded]`, `[selected]`, `[required]`, `[value="…"]` (never shown for passwords), `[options="…"]`
(selects), `[url="…"]` (links), `[level=N]` (headings). Hidden elements are left out; `[shadow]` marks a
web component's shadow root, `[frame]` an iframe whose content follows, `[cross-origin]` one that could not
be read. Long pages are cut at 1,500 lines with a note: snapshot one part with the block's `locator`.

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
| `onError` | `stop` (default): this path stops, the run fails. `continue`: pass the input on as if it worked. `port`: send `{...input, error, errorCode, errorBlock}` out of the `error` output (`errorCode`: see [error codes](#error-codes)) (connect it with `"sourcePort": "error"`). |
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
- The **JSON** export is for programs: `{ "$schema", "schemaVersion": 1, "generatedAt", "summary", "runs" }`
  ([schema](report.schema.json)). Each step of a run has `nodeId`, `sourceId` (the block's `id` in the
  file you imported, when it had one), `blockType`, `status`, `durationMs`, `attempts`, `input`, `output`
  and, when it failed, `error`, `code`, `locator`, `url` (the page) and `matches` (for `locator.strict`,
  up to 5 descriptions of the elements that matched).

### Error codes

Every failed step has a `code`. Fix by the code, then the message:

| Code | Meaning | Fix |
| --- | --- | --- |
| `locator.not-found` | No element matches the locator (within the step timeout). | Check the locator against a page snapshot; wait for the page or the element first. |
| `locator.strict` | The locator matches more than one element where exactly one is needed. | Make it more specific (see `matches`), or add `>> nth=0`. |
| `locator.invalid` | The locator cannot be parsed (bad CSS, unknown engine, bad regex). | Fix the locator syntax. |
| `element.not-visible` | The element exists but stayed hidden. | Open whatever reveals it first (menu, tab, accordion), or wait for it. |
| `element.disabled` | The element stayed disabled. | Fill in what enables it first, or check the right element is targeted. |
| `element.not-editable` | The field is read-only. | Target an editable field. |
| `element.covered` | Another element (an overlay, a cookie banner) sits on top of it. | Close the overlay first, or use `force` on Click. |
| `element.unstable` | The element kept moving (an animation). | Wait for the animation to end. |
| `element.wrong-type` | The element cannot do this (typing into a button, selecting on a non-select…). | Use the block that fits the element, or target the real field. |
| `option.not-found` | The select has no such option (or it is disabled). | Use one of the options the message lists. |
| `timeout` | Waited too long for something other than an element (text, URL, response, popup). | Raise the step timeout, or wait for the right thing. |
| `assert.failed` | An Assert did not hold. | Fix the expectation or the steps before it. |
| `http.status` | HTTP Request got a non-2xx answer with `failOnError`. | Check the URL, method, headers and body. |
| `http.network` | HTTP Request could not reach the server. | Check the URL and the host permission. |
| `navigation.failed` | A page did not finish loading. | Check the URL; raise the timeout for slow pages. |
| `tab.missing` | No tab of that name in this run. | Put an Open Tab (with that tab name) before the step. |
| `tab.closed` | The tab was closed while the step used it. | Do not close the tab mid-run. |
| `frame.unreachable` | The element is inside a frame that could not be reached. | Check the `frame=` part of the locator. |
| `page.restricted` | The browser does not let extensions script this page. | Use a normal web page. |
| `permission.missing` | An optional permission is not granted. | Grant it on the block or in the extension settings. |
| `script.error` | Run Script code threw. | Fix the script. |
| `config.invalid` | A setting is missing or invalid. | Fix the setting the message names. |
| `workflow.failed` | A workflow called by Run Workflow failed. | Fix the failing step of the called run (`childRunId`). |
| `step.failed` | Any other failure. | Read the message. |

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
