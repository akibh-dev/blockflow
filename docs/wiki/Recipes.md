# Recipes

Short, task-first examples for people building workflows in the editor and for LLMs writing them as JSON.
Each recipe lists the blocks it uses and links an importable file in
[docs/guide/examples](../guide/examples) where one exists; the others include the JSON here. All of them
use blocks that exist today (checked against the [block reference](../guide/blocks.md)).

To use a file: **Import** in the sidebar (or **+ New ▾** → template), then fix the URLs and locators for
your site. Replace `example.com` addresses and create the secrets the recipe names (header → **Secrets**).
How the file format works: [Workflows as Scripts](Workflows-as-Scripts.md).


## Login test

Log in with a password from a secret, wait for the dashboard, check the greeting; on failure, notify.

```text
Open Tab ─▶ Fill Form (email, {{secret.loginPassword}}, submit) ─▶ Wait For (URL /dashboard) ─▶ Assert (heading contains "Welcome")
                                                                        └─ error ─▶ Notify
```

- Blocks: `open-url`, `fill-form`, `wait-for` (`mode: "url"`, `step.onError: "port"`), `assert`, `notify`.
- Secret: `loginPassword`.
- File: [login-test.blockflow.json](../guide/examples/login-test.blockflow.json).
- Use `"where": "window"` on Open Tab for tests: background tabs are throttled and cannot be screenshotted.

## Data-driven test

Run the same login for several rows of data, recording each failure without stopping the rest.

```text
Data Table (CSV) ─▶ For Each ─each─▶ Open Tab ─▶ Fill Form ({{row.email}}) ─▶ Assert (soft) ─▶ Close Tab
```

- Blocks: `data-table`, `for-each` (`list: "rows"`, `as: "row"`), `open-url`, `fill-form`, `assert`
  (`soft: true`), `close-tab`.
- The password column says `USE_SECRET` for the real account; an expression picks the secret:
  `{{ row.password == 'USE_SECRET' ? secret.adminPassword : row.password }}`. Secret: `adminPassword`.
- File: [data-driven-login.blockflow.json](../guide/examples/data-driven-login.blockflow.json).
- Close Tab at the end of each row keeps tabs from piling up.

## Fill a form

One Fill Form block handles text inputs, selects (by option text or value) and checkboxes (`true` /
`false`), then clicks submit. Wait for the confirmation text.

```json
{
  "schemaVersion": 2,
  "id": "contact",
  "name": "Contact form",
  "nodes": [
    { "id": "open", "type": "open-url", "position": { "x": 0, "y": 0 },
      "config": { "url": "https://example.com/contact", "where": "window" } },
    { "id": "form", "type": "fill-form", "position": { "x": 260, "y": 0 },
      "config": {
        "fields": [
          { "locator": "label=Name", "value": "Ada Lovelace" },
          { "locator": "label=Email", "value": "ada@example.com" },
          { "locator": "label=Topic", "value": "Billing" },
          { "locator": "label=Subscribe to news", "value": "false" },
          { "locator": "label=Message", "value": "Please call me back." }
        ],
        "submit": "role=button[name=\"Send\"]" } },
    { "id": "thanks", "type": "wait-for", "position": { "x": 520, "y": 0 },
      "config": { "mode": "text", "text": "Thank you" } }
  ],
  "edges": [
    { "id": "e1", "source": "open", "target": "form" },
    { "id": "e2", "source": "form", "target": "thanks" }
  ]
}
```

- Blocks: `open-url`, `fill-form`, `wait-for` (`mode: "text"`).
- In the editor, **🎯 Detect fields** on the Fill Form block lists every field of a form with a locator,
  or use **● Record** and fill the form by hand.
- Fields with an empty value are skipped. For a site that ignores synthetic typing, set
  `"step": { "realInput": true }` (Chromium; asks for the debugger permission).

## Price watch

Check a product page every 5 minutes; notify when the price went down since the last check.

```text
Timer (300 s, repeat) ─▶ Read Element (Page URL, .price) ─▶ If ({{value}} less {{previous}}) ─true─▶ Notify
```

- Blocks: `timer`, `read-element` (with `url`: BlockFlow uses its own background tab and reloads it),
  `if` (`operator: "less"`; numbers like `$1,299.00` are parsed), `notify`.
- `{{previous}}` is the value from the last run; on the first run it is empty and `changed` is false.
- File: [price-watch.blockflow.json](../guide/examples/price-watch.blockflow.json).
- Turn the workflow **On** for it to keep running. Pages that need a login work if you are signed in in
  the same browser profile.

## Watch an element for changes

Simplest monitor: fire whenever an element's text changes, no comparison needed.

```json
{
  "schemaVersion": 2,
  "id": "stock-watch",
  "name": "Back in stock",
  "nodes": [
    { "id": "watch", "type": "watch-element", "position": { "x": 0, "y": 0 },
      "config": { "url": "https://shop.example.com/item/42", "locator": "#availability", "intervalSeconds": 300 } },
    { "id": "tell", "type": "notify", "position": { "x": 260, "y": 0 },
      "config": { "title": "Stock changed", "message": "{{previous}} → {{value}}" } }
  ],
  "edges": [{ "id": "e1", "source": "watch", "target": "tell" }]
}
```

- Blocks: `watch-element` (older files used the key `selector`; it is still accepted and renamed on import), `notify`.
- The first read only records the starting value (`emitOnFirstRead: true` changes that).
- Intervals under 30 seconds keep the background worker awake (costs battery); see
  [Troubleshooting](Troubleshooting.md#short-timers-pause-or-fire-late).

## Dark-mode watch

Read a class on `<html>` and notify when it flips. Shows `has-class` and `{{changed}}`.

```text
Timer (120 s) ─▶ Read Element (html, has-class "dark") ─▶ If ({{changed}} is true) ─true─▶ Notify
```

- Blocks: `timer`, `read-element` (`read: "has-class"`, `name: "dark"`), `if` (`operator: "true"`), `notify`.
- File: [dark-mode-watch.blockflow.json](../guide/examples/dark-mode-watch.blockflow.json).
- The same pattern works for any attribute (`read: "attribute"`, e.g. `aria-pressed`) or a count of
  elements (`read: "count"` with `If greater {{previous}}`).

## Scrape a list across pages to CSV

Collect product cards from every page of a paged list into a dataset, then download it as CSV.

```text
Open Tab ─▶ Save to Dataset (replace with []) ─▶ Paginate ─each─▶ Extract List ─▶ Save to Dataset (append)
                                                         └─done─▶ Download (dataset → CSV)
```

- Blocks: `open-url`, `save-dataset`, `paginate` (`next: role=link[name="Next"]`, `maxPages`),
  `extract-list` (item locator `.product-card`, fields with `locator` and optional `attribute: "href"`),
  `download` (`from: "dataset"`, `format: "csv"`).
- Links come back as absolute URLs. Paginate stops when the Next button is missing or disabled, or at `maxPages`.
- The dataset is also visible on the **Data** page (download as CSV or JSON there too).
- File: [scrape-to-csv.blockflow.json](../guide/examples/scrape-to-csv.blockflow.json).
- Infinite scroll instead of pages: put **Scroll** (`to: "end"`) before one Extract List.

## Scrape a table to CSV

```json
{
  "schemaVersion": 2,
  "id": "table-csv",
  "name": "Table to CSV",
  "nodes": [
    { "id": "open", "type": "open-url", "position": { "x": 0, "y": 0 },
      "config": { "url": "https://example.com/rates", "where": "new", "active": false } },
    { "id": "table", "type": "extract-table", "position": { "x": 260, "y": 0 },
      "config": { "locator": "table#rates", "into": "rows" } },
    { "id": "file", "type": "download", "position": { "x": 520, "y": 0 },
      "config": { "from": "value", "value": "rows", "format": "csv", "filename": "rates-{{ today() }}.csv" } },
    { "id": "close", "type": "close-tab", "position": { "x": 780, "y": 0 }, "config": {} }
  ],
  "edges": [
    { "id": "e1", "source": "open", "target": "table" },
    { "id": "e2", "source": "table", "target": "file" },
    { "id": "e3", "source": "file", "target": "close" }
  ]
}
```

- Blocks: `open-url`, `extract-table` (rows keyed by header text), `download` (`from: "value"`, an
  expression without braces), `close-tab`.
- Without a tab (faster, static pages only): `http-request` → `extract-table` with `source: "html"`,
  `html: "{{body}}"`, `baseUrl: "{{url}}"`.

## API to dataset

Call a JSON API daily, compute a summary with expressions, keep a history row, notify above a threshold.

```text
Timer (86400 s) ─▶ HTTP Request (Bearer {{secret.apiToken}}) ─▶ Transform ─▶ Save to Dataset ─▶ If (open > 100) ─true─▶ Notify
```

- Blocks: `timer`, `http-request` (`headers` one per line as `Name: value`; parsed JSON lands in
  `{{data}}`), `transform` (`values` rows of `name` + `expression`, e.g. `len(data.orders)`,
  `round(sum(pluck(data.orders, 'total')), 2)`), `save-dataset`, `if`, `notify`.
- Secret: `apiToken`.
- File: [api-to-dataset.blockflow.json](../guide/examples/api-to-dataset.blockflow.json).
- For an exact time of day, start with **Schedule** (`every: "day"`, `at: "09:00"`) instead of a Timer.

## Uptime monitor

Every minute, call a health endpoint; if the status is not 200, notify.

```text
Timer (60 s) ─▶ HTTP Request (failOnError: false) ─▶ Assert ({{status}} equals 200) ─error─▶ Notify ({{error}})
```

- Blocks: `timer`, `http-request` (`failOnError: false` so a 500 reaches the Assert), `assert`
  (`subject: "value"`, `step.onError: "port"`), `notify`.
- File: [api-uptime.blockflow.json](../guide/examples/api-uptime.blockflow.json).

## Reusable sub-workflow

Write the login once and call it from every test, like a Playwright `beforeEach`.

```text
"Log in (reusable)":  Fill Form ({{email}}, {{secret.loginPassword}}) ─▶ Wait For (URL /dashboard)
"Checkout test":      Open Tab ─▶ Set Variable (email) ─▶ Run Workflow ("Log in") ─▶ Click (Add to cart) ─▶ Assert (cart count = 1)
```

- Blocks: `run-workflow` (`workflow` = the called workflow's `id`), `set-variable`, plus the page blocks.
- The called workflow gets the caller's data, **including its tab**, so it needs no Open Tab of its own; the
  data of its last block comes back. Its run is listed separately in Reports, linked from the caller's step.
- Both workflows must be in the same file for the `workflow` id to be remapped on import. The called
  workflow does not need to be On.
- File: [reusable-login.blockflow.json](../guide/examples/reusable-login.blockflow.json).

## Sign in through a popup

Click a "Sign in with…" button that opens a new window, fill the form there, then check the original tab.

```json
{
  "schemaVersion": 2,
  "id": "popup-login",
  "name": "Sign in with popup",
  "nodes": [
    { "id": "open", "type": "open-url", "position": { "x": 0, "y": 0 },
      "config": { "url": "https://app.example.com", "where": "window" } },
    { "id": "click", "type": "click", "position": { "x": 260, "y": 0 },
      "config": { "locator": "role=button[name=\"Sign in with Example\"]" } },
    { "id": "popup", "type": "wait-for-popup", "position": { "x": 520, "y": 0 },
      "config": { "tab": "main", "name": "popup" } },
    { "id": "form", "type": "fill-form", "position": { "x": 780, "y": 0 },
      "config": { "tab": "popup",
        "fields": [
          { "locator": "label=Email", "value": "me@example.com" },
          { "locator": "label=Password", "value": "{{secret.ssoPassword}}" }
        ],
        "submit": "role=button[name=\"Continue\"]" } },
    { "id": "back", "type": "assert", "position": { "x": 1040, "y": 0 },
      "config": { "tab": "main", "subject": "text", "locator": "role=heading[level=1]", "operator": "contains", "expected": "Welcome" } }
  ],
  "edges": [
    { "id": "e1", "source": "open", "target": "click" },
    { "id": "e2", "source": "click", "target": "popup" },
    { "id": "e3", "source": "popup", "target": "form" },
    { "id": "e4", "source": "form", "target": "back" }
  ]
}
```

- Blocks: `click`, `wait-for-popup` (names the new tab `popup`), then any page block with `"tab": "popup"`.
- Also works for `target=_blank` links. The Assert retries until the heading appears (10 s by default).

## Answer a confirm dialog

`alert`, `confirm` and `prompt` would block the page. Tell BlockFlow how to answer **before** the click
that opens one, then read what it said.

```json
{
  "schemaVersion": 2,
  "id": "delete-item",
  "name": "Delete with confirm",
  "nodes": [
    { "id": "open", "type": "open-url", "position": { "x": 0, "y": 0 },
      "config": { "url": "https://app.example.com/items", "where": "window" } },
    { "id": "answer", "type": "dialogs", "position": { "x": 260, "y": 0 },
      "config": { "action": "accept" } },
    { "id": "delete", "type": "click", "position": { "x": 520, "y": 0 },
      "config": { "locator": "role=button[name=\"Delete\"] >> nth=0" } },
    { "id": "said", "type": "dialogs", "position": { "x": 780, "y": 0 },
      "config": { "action": "read" } },
    { "id": "check", "type": "assert", "position": { "x": 1040, "y": 0 },
      "config": { "subject": "value", "value": "{{lastDialog}}", "operator": "contains", "expected": "Are you sure" } }
  ],
  "edges": [
    { "id": "e1", "source": "open", "target": "answer" },
    { "id": "e2", "source": "answer", "target": "delete" },
    { "id": "e3", "source": "delete", "target": "said" },
    { "id": "e4", "source": "said", "target": "check" }
  ]
}
```

- Blocks: `dialogs` (`accept` with `text` for prompts, `dismiss`, or `read`), `click`, `assert`.
- The answer lasts until the page reloads or navigates; if the click navigates, the `read` step sees the
  new page's (empty) list.

## Upload a file

Fill a file input without the file dialog, submit, and wait for the API call to succeed.

```json
{
  "schemaVersion": 2,
  "id": "upload",
  "name": "Upload a CSV",
  "nodes": [
    { "id": "open", "type": "open-url", "position": { "x": 0, "y": 0 },
      "config": { "url": "https://app.example.com/import", "where": "window" } },
    { "id": "file", "type": "upload-file", "position": { "x": 260, "y": 0 },
      "config": { "locator": "input[type=file]", "source": "text",
        "content": "name,email\nAda,ada@example.com", "filename": "people.csv", "mime": "text/csv" } },
    { "id": "send", "type": "click", "position": { "x": 520, "y": 0 },
      "config": { "locator": "role=button[name=\"Import\"]" } },
    { "id": "saved", "type": "wait-for", "position": { "x": 780, "y": 0 },
      "config": { "mode": "response", "url": "/api/import", "status": "2xx" } },
    { "id": "done", "type": "assert", "position": { "x": 1040, "y": 0 },
      "config": { "subject": "text", "locator": "role=status", "operator": "contains", "expected": "1 row imported" } }
  ],
  "edges": [
    { "id": "e1", "source": "open", "target": "file" },
    { "id": "e2", "source": "file", "target": "send" },
    { "id": "e3", "source": "send", "target": "saved" },
    { "id": "e4", "source": "saved", "target": "done" }
  ]
}
```

- Blocks: `upload-file` (`source: "text"` with `content`, or `source: "url"` with `url` to fetch a file),
  `click`, `wait-for` (`mode: "response"`; a response that finished during the click still counts), `assert`.
- Hidden file inputs work; so does pointing at the input's label. A drop zone without an
  `<input type="file">`: `"target": "dropzone"` with the zone as `locator` (it receives dragenter, dragover
  and drop with the file).
- A binary file from an API (a PDF, an image): HTTP Request with `"responseType": "base64"`, then Upload File
  with `"source": "data", "data": "{{body64}}", "mime": "{{mime}}", "filename": "invoice.pdf"`. A `data:` URL works
  as `data` too.

## Drag and drop: sort a list, move a slider

```json
{
  "format": "blockflow-script",
  "version": 1,
  "name": "Reorder and set volume",
  "steps": [
    { "open": "https://app.example.com/board" },
    { "drag": { "from": "#todo >> text=Write docs", "to": "#done" } },
    { "id": "moved", "assert": { "locator": "#done", "operator": "contains", "expected": "Write docs" } },
    { "drag": { "from": "role=slider[name=\"Volume\"]", "to": "#volume-track", "toPosition": "150,10" } },
    { "click": { "locator": "#list >> text=Item 3", "modifiers": "Shift" } },
    { "element-action": { "locator": "#search", "action": "dispatch-event", "eventType": "input" } }
  ]
}
```

- Blocks: `drag` (HTML5 `draggable` lists and kanban boards, and pointer-event sliders and sortables;
  `toPosition` is x,y from the target's top-left corner), `click` with `modifiers` (Shift+click selects a
  range), `element-action` (focus, blur, clear, scroll into view, dispatch an event).
- Sites that only react to trusted events: set `"step": { "realInput": true }` on the drag (Chromium); it
  then uses the browser's own mouse, native drags included.

## Mock an API and test on a phone

Check that checkout shows a friendly message when the payment API is down, on an emulated iPhone in
French and dark mode, without sending analytics, and that the page logs no errors meanwhile. Chromium only.

```json
{
  "format": "blockflow-script",
  "version": 1,
  "name": "Checkout on a phone with a failing API",
  "steps": [
    { "open": "https://shop.example.com/cart" },
    { "emulate": { "device": "iphone", "timezone": "Europe/Paris", "locale": "fr-FR", "colorScheme": "dark" } },
    { "route": { "rules": "[{\"url\":\"**/api/payment\",\"method\":\"POST\",\"action\":\"fulfill\",\"status\":503,\"headers\":{\"Content-Type\":\"application/json\"},\"body\":\"{\\\"error\\\":\\\"down\\\"}\"},{\"url\":\"**/analytics/**\",\"action\":\"abort\"}]" } },
    { "navigate": { "action": "reload" } },
    { "click": "role=button[name=\"Pay\"]" },
    { "assert": { "locator": "role=alert", "operator": "contains", "expected": "try again" } },
    { "assert": { "subject": "console-errors", "operator": "equals", "expected": "0" } }
  ]
}
```

- Blocks: `emulate` (device preset, locale, timezone, color scheme), `route` (`rules` is a JSON array as
  text; the newest matching rule wins; `fulfill` mocks, `abort` blocks), `navigate` `reload` (UA and
  language changes reach page code on the next load), `assert` with `subject: "console-errors"`.
- Grant `debugger` on the Route and Emulate blocks when asked. Routes and emulation are reset when the run
  ends, even when it fails. With only `abort` / `redirect` rules, Route uses browser rules instead
  (`declarativeNetRequest`, works on Firefox too).
- To see every request the page made, put HAR Record `start` before and `stop` (with a `filename`) after.

## See also

- [Workflows as Scripts](Workflows-as-Scripts.md): the file format, the prompt template, Playwright mapping
- [Troubleshooting](Troubleshooting.md)
- [Usage guide: testing patterns](../guide/README.md#13-testing-patterns),
  [scraping](../guide/README.md#14-scraping-and-data), [monitoring](../guide/README.md#15-monitoring-patterns)
- [Block reference](../guide/blocks.md)
- [Getting Started](Getting-Started.md), [Concepts](Concepts.md)
