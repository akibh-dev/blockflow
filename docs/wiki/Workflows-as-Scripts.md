# Workflows as Scripts

For people who would rather write a workflow as text than drag blocks, and for anyone asking an LLM
(Claude, ChatGPT, a coding agent) to write one. BlockFlow reads two file formats:

- **Scripts** (`something.script.json`): a list of steps, like a Playwright test. The one to write by hand
  or ask an LLM for. Import compiles it into blocks and lays them out.
- **Graphs** (`something.blockflow.json`): blocks (`nodes`) and connections (`edges`), what the editor
  saves and exports. Every workflow can be a graph; a workflow that is a tree of steps can also be
  exported as a script.

The canonical reference is the [usage guide](../guide/README.md). This page summarises it and adds the
practical parts: a prompt template, the edit-run-fix loop, and a Playwright mapping.

## The script format

This script opens a search page, types a query, presses Enter and checks that results appear:

```json
{
  "format": "blockflow-script",
  "version": 1,
  "name": "Search shows results",
  "steps": [
    { "open": "https://example.com/search" },
    { "fill": { "locator": "role=searchbox", "value": "blue shoes" } },
    { "press": { "key": "Enter", "locator": "role=searchbox" } },
    { "id": "results", "assert": { "subject": "count", "locator": ".result", "operator": "greater", "expected": "0" } }
  ]
}
```

A **step** is an object with exactly one **block key**: a block `type` from the
[block reference](../guide/blocks.md) (or an alias, below). Its value is the block's settings (`config`);
missing keys take the block's default. A step may also have:

| Key | Meaning |
| --- | --- |
| `id` | Optional name of the step, unique in the script. Without one, the Nth step from the top of the file (nested steps count too) is `s<N>`. Import keeps it as the block's `origin`, so results can point back to the script. |
| `step` | [Step settings](../guide/README.md#7-step-settings-every-block): `timeoutSeconds`, `retries`, `onError`, `screenshot`, `disabled`, `note`, `realInput`. |
| `true`, `false` | If only: the steps for each answer. |
| case names, `default` | Switch only: the steps for each case (its `cases[].port`) and for no match. Any other key holding a list is refused as `edge.port.unknown`, with a did-you-mean over the real case names. |
| `each` | For Each, Repeat, Paginate: the steps run once per item / time / page. |
| `onError` | Any block: the steps that run when it fails. Sets `step.onError` to `"port"` for you. |

### How steps connect

1. The steps of a list run in order. Each step connects to the next one from its **continue port**:
   `out` for most blocks, `done` for the loops (For Each, Repeat, Paginate), so the step after a loop runs
   once, when the loop is finished.
2. `each` and `onError` lists **end where they end**: an `each` list is the loop body (the loop moves on
   to the next item by itself), an `onError` list handles the failure and the run does not come back.
3. **If rejoins.** The step after an If runs after whichever branch ran: it is connected from the last
   step of `true` and of `false`. A missing (or empty) branch goes straight to the next step, so
   "if without else" works as in code. This also holds for an If nested inside a branch.
4. **Switch rejoins the same way**: the step after it is connected from the last step of every case list
   and of `default`, and straight from every case without a list. Its outputs come from its settings, so
   the compiler reads the step's `cases` (defaults filled in) before it looks at the branch keys.
5. A list's last step connects to nothing, unless the list is an If or Switch branch (rules 3 and 4).

```json
{ "id": "big", "if": { "left": "{{count}}", "operator": "greater", "right": "100" },
  "true": [ { "notify": "{{count}} orders waiting" } ] },
{ "log": "checked" }
```

Here `log` runs in both cases: after the notification when the count is over 100, straight from If's
`false` output otherwise.

```json
{ "id": "route", "switch": { "value": "{{status}}", "cases": [
    { "port": "ok", "operator": "equals", "value": "200" },
    { "port": "server", "operator": "matches", "value": "/^5/" } ] },
  "server": [ { "notify": "API down: {{status}}" } ] },
{ "log": "checked {{status}}" }
```

`log` runs after every outcome: after the notification for a 5xx, straight from `ok` and `default`
otherwise. A loop that stops on a condition is Repeat with `"mode": "until"` (or `"while"`), see
[guide §6](../guide/README.md#6-branching).

### Aliases and shorthands

Every block works under its own `type`. A few common ones have shorter names, and some take a single value
instead of a settings object:

| Alias | Block |
| --- | --- |
| `open` | `open-url` |
| `goto` | `navigate` |
| `press` | `press-key` |
| `select` | `select-option` |

| Block | A bare value is its… | Example |
| --- | --- | --- |
| `open-url`, `navigate` | `url` | `{ "open": "https://example.com" }` |
| `click`, `check`, `wait-for` | `locator` | `{ "click": "role=button[name=\"Save\"]" }` |
| `press-key` | `key` | `{ "press": "Enter" }` |
| `log`, `notify` | `message` | `{ "notify": "Price dropped to {{value}}" }` |
| `run-script` | `code` | `{ "run-script": "return document.title" }` |
| `run-workflow` | `workflow` | `{ "run-workflow": "login" }` |
| `for-each` | `list` | `{ "for-each": "rows", "each": [ … ] }` |
| `repeat` | `times` | `{ "repeat": 3, "each": [ … ] }` |

Old setting names are accepted and moved, as for graphs (`selector` → `locator` on Read Element and Watch
Element, `next` → `locator` on Paginate).

### Several scripts in one file

```json
{ "format": "blockflow-script", "version": 1,
  "scripts": [
    { "id": "login", "name": "Log in", "steps": [ … ] },
    { "name": "Checkout test", "steps": [ { "open": "https://shop.example.com" }, { "run-workflow": "login" } ] }
  ] }
```

Run Workflow can name another script of the same file by its `id` (or its `name`); import points it at
the imported workflow.

### Script problems

Import refuses a script with errors and names the place with a JSON Pointer (`/steps/2/true/0` is the
first step of the `true` list of the third step), e.g.
`error node.type.unknown at /steps/1/clik: Unknown block "clik". Did you mean "click"?`. The codes:

| Code | Cause |
| --- | --- |
| `script.shape` | Not an object, no `steps` list, `format` is not `blockflow-script`, or `"scripts": []`. |
| `script.version` | `version` other than `1`. |
| `script.empty` (warning) | `"steps": []`. |
| `step.shape` | A step that is not an object, has no block key or two of them, a bare value for a block without a shorthand, `step` or `onError` of the wrong type, an empty `id`. |
| `node.type.unknown` | The block key is neither a type nor an alias. The hint suggests the closest one. |
| `node.id.duplicate` | Two steps with the same `id`. |
| `edge.port.unknown` | A list under a key that is not one of the block's outputs (`"ture"`, `"each"` on a Click). |
| `step.branch.next` | A list under the continue port (`out`, `done`): put those steps after this step instead. |
| `step.onError.conflict` | An `onError` list on a step whose `step.onError` is `stop` or `continue`. |

Settings themselves (a misspelt config key, a wrong value) are checked after compiling, like a graph
(see [How errors show up](#how-errors-show-up)).

## The graph format

What the editor saves. A file holds one or more workflows, each a list of blocks (`nodes`) and connections
(`edges`). The same search test as a graph:

```json
{
  "format": "blockflow-workflows",
  "version": 1,
  "workflows": [
    {
      "schemaVersion": 2,
      "id": "search-test",
      "name": "Search shows results",
      "enabled": false,
      "nodes": [
        { "id": "open", "type": "open-url", "position": { "x": 0, "y": 0 },
          "config": { "url": "https://example.com/search", "where": "window" } },
        { "id": "query", "type": "fill", "position": { "x": 260, "y": 0 },
          "config": { "locator": "role=searchbox", "value": "blue shoes" } },
        { "id": "submit", "type": "press-key", "position": { "x": 520, "y": 0 },
          "config": { "key": "Enter", "locator": "role=searchbox" } },
        { "id": "results", "type": "assert", "position": { "x": 780, "y": 0 },
          "config": { "subject": "count", "locator": ".result", "operator": "greater", "expected": "0" } }
      ],
      "edges": [
        { "id": "e1", "source": "open", "target": "query" },
        { "id": "e2", "source": "query", "target": "submit" },
        { "id": "e3", "source": "submit", "target": "results" }
      ]
    }
  ]
}
```

What each part means:

| Part | Meaning |
| --- | --- |
| `format`, `version` | Always `"blockflow-workflows"` and `1`. A single workflow object without this wrapper also imports. |
| `id` | Any unique string. Import replaces it with a fresh id (references between workflows in the same file, from Run Workflow, are kept). |
| `enabled` | Ignored on import: imported workflows always arrive **off**. |
| `nodes[].type` | The block type, e.g. `open-url`, `click`, `assert`. Must exist in the [block reference](../guide/blocks.md). |
| `nodes[].config` | The block's settings. Keys come from the block reference; missing keys take the default. |
| `nodes[].position` | Where the block sits on the canvas. About 260 px apart left to right reads well. Leave `position` out of every node and import lays the workflow out for you. |
| `nodes[].step` | Optional per-block settings: `timeoutSeconds`, `retries`, `onError`, `screenshot`, `disabled`, `note`, `realInput`. See [step settings](../guide/README.md#7-step-settings-every-block). |
| `edges` | Connections. `sourcePort` picks an output on blocks that have several: `"true"`/`"false"` on If, the case names and `"default"` on Switch, `"each"`/`"done"` on loops, `"error"` when the source has `"step": { "onError": "port" }`. |

A graph can do what a script cannot: several start blocks, one output feeding several blocks, joins
anywhere, loops back. A workflow like that has no script form ("Export as script" is greyed out).

In both formats, a block with no incoming connection (the first step of a script) is a **start block**.
Open Tab at the start runs once when you press ▶ Run. To run on a schedule, start with a `timer` or
`schedule` block instead (see [Concepts](Concepts.md)).

Data flows along connections as a JSON object. A block's settings can use earlier data with `{{name}}`,
secrets with `{{secret.name}}`, and expressions with `{{ price * 1.1 }}`. Details:
[data and templates](../guide/README.md#3-data-and-templates).

## Reference files (generated from the code)

These are generated by `npm run guide:sync` from the block definitions, so they are always in step with
the extension. Give them to an LLM rather than retyping them.

| File | Use it for |
| --- | --- |
| [blocks.md](../guide/blocks.md) | Every block: `type`, every `config` key with type and default, outputs, default timeout. Human-readable. |
| [blocks.json](../guide/blocks.json) | The same, machine-readable. |
| [script.schema.json](../guide/script.schema.json) | JSON Schema of a script file: every block and alias, its settings, its shorthand and its branch keys. Use it in an editor (VS Code: `"$schema"`) or a validator. |
| [workflow.schema.json](../guide/workflow.schema.json) | JSON Schema of a graph file, with every block's config. |
| [examples/](../guide/examples) | Eight importable workflows, each as a script (`*.script.json`) and a graph (`*.blockflow.json`). A test checks that both import, without errors, to the same graph. |
| [llms.txt](../../llms.txt) | The short index an AI tool should read first. |

The script schema rejects unknown config keys. The graph schema checks shapes and allowed values but
does **not** reject unknown config keys (they are silently ignored by BlockFlow too), so a typo like
`"locater"` passes it. Check key names against `blocks.md`.

## Rules an AI tool must follow

The full list is in the guide: [Rules for AI tools](../guide/README.md#rules-for-ai-tools-generating-workflows-read-first).
In short:

1. Output the script format above.
2. Use only block `type`s (or the aliases) and `config` keys from [blocks.md](../guide/blocks.md).
3. Every page block (Click, Fill, Assert on the page, Extract List…) needs an **Open Tab** earlier on the
   same path, with the same `tab` name (default `main`).
4. Write steps in order; use `true`/`false`, `each` and `onError` lists for branches. Remember that the
   step after an If runs after either branch.
5. Prefer readable locators: `role=button[name="Sign in"]`, `label=Email`, `text=Welcome`, `testid=…`.
   Actions are strict: a locator that matches two elements fails. See [locators](../guide/README.md#4-elements-locators).
6. Never put passwords or tokens in the file. Use `{{secret.name}}` and tell the user which secrets to create.
7. Do not add waits "just in case": every action already waits for its element.
8. Check results with **Assert** (tests) or **If** + **Notify** (monitoring).
9. Template values are strings. Compare numbers with `greater`, `less` and friends.

## A prompt template

Copy this, fill in the bracketed parts, and attach (or paste) `docs/guide/README.md` and
`docs/guide/blocks.md`. Models do best with both files in context.

```text
You are writing a BlockFlow script. BlockFlow is a browser extension that runs
automations made of blocks inside my own browser. Attached are its usage guide
(README.md) and its block reference (blocks.md). Follow the guide's
"Rules for AI tools" section exactly.

Task: [what the workflow should do, step by step, e.g. "Log in to https://app.example.com/login
with my email me@example.com, open Settings, and check that the heading says 'Account'"]

Page details I know: [labels, button texts, test ids, URLs. Say "unknown" if you don't know]
How it should start: [by hand with Run / every N minutes / daily at 09:00 / when I visit a URL]
What should happen on failure: [fail the run / send a notification / continue]

Output:
1. One JSON file in the "blockflow-script" format, nothing else in the code block.
   Use only block types, aliases and config keys from blocks.md and the guide.
2. A list of secrets I must create (name and what goes in it).
3. A list of locators you guessed, so I can check them with Pick on page.
```

Tips that make the first try more likely to work:

- Give the model real labels and button texts from the page. Locators it has to guess are the most common
  reason a generated workflow fails.
- Ask for one workflow at a time, short, ending in Asserts. Add branches once the straight path passes.
- Give the model `id`s to use for the steps you care about, so you can talk about "step `login`" when
  something fails.
- If the model writes `"locater"`, `"selector"` on a Click, or a type that does not exist, import refuses
  the file and lists each problem with its path in the script (`/steps/1/click/locater`) and a
  did-you-mean. Paste that list (the dialog's **Copy**) back to the model; it is written for that.

## Import and export

**Import** (sidebar top, or the **All workflows** page): pick one or more `.json` files, scripts or graphs.
A script is compiled into blocks and laid out in columns (as is a graph file without positions). Each
workflow gets a fresh id, a unique name ("Login test 2" if the name is taken) and arrives **off**, so an
import can never start something by surprise or overwrite a workflow.

**Export**: hover a workflow in the sidebar → export, or select several on **All workflows** → Export.
You get `<name>.blockflow.json` (several workflows: `blockflow-workflows.blockflow.json`), a graph.
**Export as script** in the canvas header downloads the open workflow as `<name>.script.json`, when it
can be written as one (one start block, every output feeding at most one block, joins only after an If or a Switch).
The export uses aliases and shorthands, leaves out settings at their default and keeps your step ids.
Exported workflows are always marked off. Secrets are never part of the file, only their
`{{secret.name}}` references.

**+ New ▾** offers the graph files in [examples/](../guide/examples) as templates.

Import keeps each block's `step` settings and each connection's `sourcePort`. It checks the whole file
first and refuses it on any error (below).

## How errors show up

There are two stages.

**1. Checking the file (import).** Before anything is imported, the whole file is checked against the
block registry ([check.ts](../../src/core/check.ts), see [Core Modules](Core-Modules.md#check)). Every
problem is an **issue** with a level, a stable **code**, a **JSON Pointer** into the file as you wrote it,
a message and usually a hint:

```
error config.key.unknown at /workflows/0/nodes/1/config/locater: Block "go" (click) has no setting "locater". Did you mean "locator"?
error node.type.unknown at /workflows/0/nodes/0/type: Block "open" has an unknown type "open-tab". Did you mean "open-url"?
warning page.no-tab at /workflows/0/nodes/3: Block "check" (assert) acts on the tab "main", but not every path to it opens that tab. Put an Open Tab block (type "open-url", tab "main") before it on every path.
info config.key.renamed at /workflows/0/nodes/2/config/selector: Block "price" (read-element): "selector" is now called "locator". Use "locator".
```

A script file gets the same check, after compiling; each path is moved back to the step you wrote
(`/steps/1/click/locater`, `/steps/2/true/0/step/retrys`, or the shorthand itself, `/steps/0/open`), and
the script's own problems come first (see [Script problems](#script-problems)).

- Any **error** refuses the whole file: nothing is imported, and a dialog (**Cannot import <file>**) lists
  every issue. **Copy** puts the list on the clipboard in the form above, ready to paste back to the AI
  tool that wrote the file.
- **Warnings** and **info** do not block: the file imports and a toast says how many warnings there are;
  its **Details** button opens the same list.

The codes, what they mean and how to fix each are in the guide's
[Repair table](../guide/README.md#repair-what-import-errors-mean). The paths point into the file you
imported (`/workflows/0/...` in an export file, `/nodes/...` for a bare workflow), and the messages use your
block ids, not the ones import creates.

What the check catches that used to fail only at run time: unknown config keys and step keys (typos were
silently ignored before), wrong value types (`"retries": "2"`, `"active": "true"`), options that do not
exist, broken locators (`rol=button`, an unclosed quote), invalid URLs, broken `{{ }}` expressions,
connections from an output a block does not have, a Run Workflow that calls a workflow that is neither in
the file nor saved, and the per-block rules (Assert on an element without `locator`, Wait For text without
`text`, Upload File from a URL without `url`…). A page block with no Open Tab on some path to it is a
warning (it may be a sub-workflow that gets its tab from the caller).

**2. Checking the workflow (editor).** After import the editor validates the workflow (the same check runs
all the time while you edit):

- The header shows **N problems**, ▶ Run is disabled ("Fix the problems first") and turning the workflow on
  is refused with the list of reasons.
- Blocks with problems get a badge; click the block to see the messages in its settings panel.

| Message | Fix |
| --- | --- |
| `Unknown block type "x"` | Use a `type` from blocks.md. |
| `<Setting> is required` | Add the config key. |
| `<Setting> must be a valid http(s) URL` | Full URL with `https://`, or a `{{template}}`. |
| `<Setting> has an invalid choice` | Use one of the listed values for that key. |
| `<Setting> must be a number` / `must be at least …` | Numbers as JSON numbers (`"5"` is also accepted). |
| `<Setting>: …` (expression error) | A broken `{{ … }}` expression. |
| `Element is required to check "text"`, `Text is required for mode "text"`… | A setting another setting needs (the block's `validate` rules, the same ones import checks). |
| `Schedule cannot take input from another block` | Schedule is the one block that only works at the start. Remove its incoming edge. |
| `Nothing can start this workflow: every block has an input.` | Remove a connection so one block has no input. |
| `This block can never run: no start block leads to it` (warning) | Connect it, or delete it. |
| `The "x" output is not in use, so its connection never runs` (warning) | `sourcePort` names an output the block does not have (e.g. `error` without `onError: "port"`). |
| `This workflow contains a loop. A run stops after 1000 blocks.` (warning) | Usually a mistake; use For Each / Repeat instead. |

Some problems only show when the block runs, because they depend on the page or on data: an element that
is not there, a templated URL that renders empty, a page block whose tab was closed (`No tab named "main"
in this run. Put an Open Tab block (tab name "main") before this block.`). These appear as a failed step in
the run. See [Troubleshooting](Troubleshooting.md).

## Iterating: run, read, fix

1. Import the file and open it. Fix anything the editor flags.
2. Press **▶ Run**. Blocks light up ✓ / ✕ / ↪ as the run goes.
3. Click the failed block: its settings panel shows the input and output of that run, and the error.
4. Open **Reports** for the whole run: every step with status, duration, attempts, error, screenshot
   (taken on failure by default), and **Export JSON** for the full record.
5. Fix the workflow (in the editor, or in the JSON and re-import) and run again.

To let an LLM fix its own workflow, give it the failing step's error text, or the exported JSON report,
together with the workflow file. Two things to tell it:

- The run record names blocks by the **new ids** created on import, not the ids in its file. Match steps
  by `blockType` and order, or export the workflow again (Export as script keeps the script's step ids,
  which import stores as each block's `origin`).
- Error texts are written for people but are specific: `role=button[name="Save"] matches 2 elements
  (button#save, button.save-2). Make it more specific, or add ">> nth=0" for the first one.` tells the
  model exactly what to change.

There is no API or CLI yet for a program to import, run and read results on its own; a person has to do
the import and press Run. That loop is planned (see [Roadmap](Roadmap.md)).

## Playwright to BlockFlow

BlockFlow's locators follow Playwright's, so a Playwright test usually translates step by step. Rows marked
**no equivalent yet** have no block today; [Run Script](../guide/blocks.md) (your own JavaScript in the page,
Chrome 135+) covers some of them.

### Pages and navigation

| Playwright | BlockFlow |
| --- | --- |
| `const page = await context.newPage(); await page.goto(url)` | **Open Tab** `open-url` (`url`, `tab` name, `where`, `waitUntil`) |
| `page.goto(url)` on an open page | **Navigate** `navigate`, `action: "goto"` |
| `page.goBack()` / `goForward()` / `reload()` | **Navigate** `action: "back"` / `"forward"` / `"reload"` |
| `page.waitForEvent('popup')` | Click, then **Wait for Popup** `wait-for-popup`; later blocks use `"tab": "popup"` |
| `page.close()` | **Close Tab** `close-tab` |
| `page.frameLocator('#pay').getByLabel('Card')` | locator `frame=#pay >> label=Card` |
| `page.setViewportSize`, `emulateMedia`, geolocation, locale | no equivalent yet |
| new browser context per test, `storageState` | no equivalent yet (runs share your browser profile) |

### Locators

| Playwright | BlockFlow locator |
| --- | --- |
| `getByRole('button', { name: 'Save' })` | `role=button[name="Save"]` (`[exact]` for exact) |
| `getByText('Sign in')` / `{ exact: true }` | `text=Sign in` / `text="Sign in"` |
| `getByLabel`, `getByPlaceholder`, `getByTestId`, `getByAltText`, `getByTitle` | `label=`, `placeholder=`, `testid=`, `alt=`, `title=` |
| `locator('css')`, `locator('xpath=…')` | the CSS itself, `xpath=…` |
| `a.locator(b)`, `.first()`, `.last()`, `.nth(n)` | `a >> b`, `>> nth=0`, `>> nth=-1`, `>> nth=n` |
| `filter({ hasText })` / `{ hasNotText }` | `>> has-text=…` / `>> has-not-text=…` |
| `filter({ has })` / `{ hasNot }` | `>> has=<locator>` / `>> has-not=<locator>` (quote it when it has steps) |
| `filter({ visible: true })` / `false` | `>> visible` / `>> visible=false` |
| `a.or(b)` | `a \|\| b` |
| `getByRole(…, { pressed, expanded, selected, disabled, includeHidden })` | `[pressed]`, `[expanded=false]`, `[selected]`, `[disabled]`, `[include-hidden]` |
| `a.and(b)` | no equivalent yet |

### Actions

| Playwright | BlockFlow |
| --- | --- |
| `locator.click()` / `dblclick()` / `click({ button: 'right' })` / `hover()` | **Click** `click`, `action`: `click` / `double` / `right` / `hover` |
| `click({ force: true })` | **Click** `force: true` |
| `click({ button, modifiers, position, clickCount })` | **Click** `button` (`left`/`middle`/`right`), `modifiers` (`"Control+Shift"`), `position` (`"x,y"`), `clickCount` |
| `locator.fill(value)` | **Fill** `fill` |
| `locator.pressSequentially(text)`, `keyboard.type` | **Fill** `mode: "type"` |
| several `fill`s and a submit click | **Fill Form** `fill-form` (`fields`, `submit`) |
| `locator.selectOption(label)` | **Select Option** `select-option` (text or value; `a\|b` for multi) |
| `check()` / `uncheck()` / `setChecked()` | **Check** `check`, `state` |
| `locator.press('Enter')`, `keyboard.press('Control+Shift+K')`, `'ControlOrMeta+A'` | **Press Key** `press-key` (`locator` optional) |
| `keyboard.insertText(text)` | **Press Key** `mode: "text"`, `text` |
| `setInputFiles` | **Upload File** `upload-file` (one file, from text, a URL or base64 `data`) |
| a `drop` event with a DataTransfer (drop zones) | **Upload File** `target: "dropzone"` |
| `page.on('dialog', d => d.accept())` | **Dialogs** `dialogs`, placed **before** the click that opens the dialog |
| `scrollIntoViewIfNeeded()`, `mouse.wheel` | **Scroll** `scroll` (`to`: `element`, `end`, `bottom`, `top`) |
| `page.evaluate(fn)` | **Run Script** `run-script` (Chrome 135+, needs the userScripts permission) |
| `locator.dragTo(target, { sourcePosition, targetPosition })` | **Drag** `drag` (`from`, `to`, `fromPosition`, `toPosition`) |
| `focus()`, `blur()`, `clear()`, `scrollIntoViewIfNeeded()`, `dispatchEvent(type, init)` | **Element Action** `element-action`, `action`: `focus`, `blur`, `clear`, `scroll-into-view`, `dispatch-event` (`eventType`, `detail`) |
| `isTrusted` input (Playwright's input is always trusted) | step setting `"realInput": true` (Chromium only) |

### Waiting

| Playwright | BlockFlow |
| --- | --- |
| auto-waiting before actions | built in: visible, enabled, stable, not covered, exactly one match |
| `locator.waitFor({ state })` | **Wait For** `wait-for`, `mode`: `visible` / `hidden` / `attached` / `detached` / `enabled` |
| `page.waitForURL(pattern)` | **Wait For** `mode: "url"` (contains, `*`/`**` globs, `/regex/`) |
| `page.waitForLoadState('load' \| 'networkidle')` | **Wait For** `mode: "load"` / `"networkidle"` |
| `page.waitForResponse(url)` | **Wait For** `mode: "response"`, `url`, `status` (`201`, `2xx`). Status only, no body |
| `page.waitForRequest` | no equivalent yet |
| `page.waitForEvent('download')` | no equivalent yet |
| `page.waitForTimeout(ms)` | **Timer** after a block delays the flow (exported back as `page.waitForTimeout`) |

### Reading and assertions

| Playwright | BlockFlow |
| --- | --- |
| `expect(l).toHaveText` / `toContainText` | **Assert** `assert`, `subject: "text"`, `operator: "equals"` / `"contains"` (also `matches`, `starts-with`…) |
| `toHaveValue` | **Assert** `subject: "input"` |
| `toHaveAttribute(name, v)` | **Assert** `subject: "attribute"`, `name` |
| `toHaveClass` / `toContainClass` | **Assert** `subject: "class"`, `operator: "equals"` / `"contains"` (has the classes) |
| `toHaveCSS(name, v)` | **Assert** `subject: "css"`, `name` = the property |
| `toHaveAccessibleName` / `toHaveAccessibleDescription` | **Assert** `subject: "accessible-name"` / `"accessible-description"` |
| `toBeFocused` / `toBeEditable` / `toBeInViewport` | **Assert** `subject: "focused"` / `"editable"` / `"in-viewport"` |
| `toHaveCount` | **Assert** `subject: "count"` |
| `toBeVisible` / `toBeHidden` / `toBeChecked` / `toBeEnabled` / `toBeDisabled` | **Assert** `subject` of the same name (`unchecked` for not checked) |
| `expect(page).toHaveURL` / `toHaveTitle` | **Assert** `subject: "url"` / `"title"` |
| `expect(value).toBe(x)` | **Assert** `subject: "value"`, `value: "{{key}}"` |
| `expect.soft` | **Assert** `soft: true` |
| `toBeFocused`, `toHaveCSS`, `toBeEditable`, `toBeInViewport`, `toHaveScreenshot`, ARIA snapshots | no equivalent yet |
| `textContent()`, `inputValue()`, `getAttribute()`, `count()`, `isVisible()` | **Read Element** `read-element` with `tab` (no `url`), `read`: `text` / `value` / `attribute` / `has-class` / `exists` / `count` |
| `page.title()`, meta tags, `context.cookies()`, localStorage | **Page Info** `page-info` (read only; setting cookies: no equivalent yet) |
| `page.screenshot()` | step setting `"screenshot": "always"` (visible tab only) |

### Network, data and test structure

| Playwright | BlockFlow |
| --- | --- |
| `request.get/post(...)` | **HTTP Request** `http-request` |
| `page.route` (mock, block, modify) | no equivalent yet |
| `test.beforeEach` login, shared helpers | **Run Workflow** `run-workflow` calls another workflow in the same tab |
| parameterised tests | **Data Table** → **For Each** (see [Recipes](Recipes.md#data-driven-test)) |
| `test.retries` | per-block `"step": { "retries": 2 }` |
| `try { … } catch` | an `onError` list in a script (in a graph: `"step": { "onError": "port" }` and an edge with `"sourcePort": "error"`) |
| `page.pause()` | **Manual Step** `manual-step` |
| `test.describe`, projects, parallel workers, headless, CI | no equivalent inside BlockFlow; export to Playwright for CI (below) |

## Export to Playwright

Sidebar row or **All workflows** → 🎭 **Playwright** downloads `<name>.spec.ts`, a Playwright test you run
with `npx playwright test`. A workflow exported from the editor was run green this way in the Phase F
end-to-end test (see [README](../../README.md#what-has-been-verified)).

What it does:

- One `test()` per exported workflow, using Playwright's `page`, `context` and `request` fixtures. Every
  start block is walked in turn and written as statements.
- Locators are translated to `getByRole`, `getByLabel`, `frameLocator`, `.nth()` and so on. Element
  assertions use `.first()` like BlockFlow's reads.
- Templates run through BlockFlow's **own** template and expression code: a setting with `{{…}}` becomes
  `render("…", data)`, so `{{key}}`, `{{$json.x}}`, keys with dashes (`{{order-id}}`) and expressions
  (`{{ price * 1.1 }}`, `{{ upper(name) }}`) render exactly as in the extension. `{{secret.name}}` reads
  `process.env.NAME` (upper-cased); the header comment lists the environment variables needed.
- At the end of the spec is the **BlockFlow runtime**: the real source of `src/core/expression.ts`,
  `condition.ts`, `csv.ts`, `urlPattern.ts` and `template.ts`, inlined at build time
  ([src/core/playwrightRuntime.ts](../../src/core/playwrightRuntime.ts)), so it cannot drift from the
  extension. Data blocks use it: Transform → `evaluate(…)`, Filter → `listAt` + `compare`, Data Table →
  `parseRows` (JSON, or CSV with quotes and comma/semicolon/tab separators), Set Variable → `render`,
  For Each → `listAt` with `item`/`index`/`total` and `count` after, If → `compare` (every operator).
- Assert retries like BlockFlow's: `toHaveText`/`toContainText`, `toHaveValue`, `toHaveAttribute`,
  `toHaveCount`, `expect(page).toHaveURL`/`toHaveTitle` (and `not.` / regex forms) where Playwright has a
  matcher; every other operator (greater, starts-with, empty…) becomes
  `expect.poll(() => compare(…)).toBe(true)`. Soft asserts use `expect.soft` /
  `expect.configure({ soft: true }).poll`. An Assert on a data value is checked once, as in BlockFlow.
- Wait For `mode: "response"` → `waitForResponse(tab, pattern, status)`: a matching response of that tab
  from the last 10 s (usually triggered by the click before) or the next one, through
  `page.waitForResponse`; the pattern works like BlockFlow's (contains, `*`/`**` globs, `/regex/`) and
  `status` accepts `201`, `2xx`, `200,201`. `data.response` gets `{ url, status, method }`.
- Open Tab: `where: "current"` / `"workflow"` reuse the test's `page`; `"new"` / `"window"` open
  `context.newPage()`.
- Dialogs → one `page.on('dialog')` handler per page that answers with the latest Dialogs choice and
  records what was shown (`read` returns `dialogs` / `lastDialog`). Upload File → `setInputFiles` with a
  `Buffer` (text), a file downloaded with `request.get` (URL) or `fileFromData` (base64 / `data:` URL); with
  `target: "dropzone"` → `dropFiles(zone, file)` (dragenter, dragover, drop with a DataTransfer in the page).
  Click options → the same `click`/`dblclick`/`hover` options. Drag → `dragTo` (held modifiers become a
  comment). Element Action → `focus`/`blur`/`clear`/`scrollIntoViewIfNeeded`, and `dispatchEvent(locator,
  type, detail)`: Playwright's `dispatchEvent` for built-in types, a `CustomEvent` with `detail` otherwise.
  HTTP Request `responseType: "base64"` → `body64` from `response.body()`. Wait for Popup → a page the site opened in
  the last 15 s, or `context.waitForEvent('page')`. Run Script → `page.evaluate(async (data) => { …your
  code… }, data)`. A Timer after another block → `page.waitForTimeout(ms)`.
- Step settings: `timeoutSeconds` → `{ timeout }` on the action or expect; `retries` → `retry(n, …)` around
  the step (1 s, 2 s, 4 s… like the engine); `onError: "continue"` → `try/catch` that logs; `onError:
  "port"` with an `error` edge → `try/catch` that runs the error branch with `error` / `errorBlock` in the
  data (the normal path continues only on success); `disabled` → a comment.
- If becomes `if/else`, Switch an `if / else if` chain over its cases; For Each, Repeat (also until / while, with `max`) and Paginate become loops.
- Run Workflow becomes a call to a generated function for the called workflow.
- Helper functions (`read`, `compare`, `extractList`, `extractTable`, `setField`…) are appended so the test
  keeps BlockFlow's behaviour.

The e2e spec [tests/e2e/specs/playwright-export.mjs](../../tests/e2e/specs/playwright-export.mjs) runs three
such workflows (data table + For Each logins, API response + dialogs + uploads, scraping + popups + error
branch) in the extension, exports them from the editor and runs them green with `npx playwright test`.

Known limits (from [src/core/playwright.ts](../../src/core/playwright.ts)):

| Not exported, or exported differently | What you get |
| --- | --- |
| Notify, Save to Dataset, Download | a comment `// BlockFlow-only: <Block> has no Playwright equivalent, skipped.` Later steps that need their data will not get it. |
| Triggers (Timer or Schedule at the start, Page Visited, Context Menu, Watch Element) | a comment; the test starts there. |
| Extract List from HTML (`source: "html"`) | a `// BlockFlow-only:` comment |
| Read Element `previous` / `changed` | not available (no state between test runs) |
| `realInput` | ignored (Playwright's input is always trusted) |
| `screenshot` step setting | ignored (use Playwright's `screenshot: 'only-on-failure'` option) |
| Loops back to an earlier block | a comment `(loop back … not exported)` |
| Data flow | one mutable `data` object, so a branch that changes it also changes it for the blocks written after that branch (BlockFlow gives each branch its own copy) |

Treat the export as a strong first draft: read it, run it once, fix what is marked `BlockFlow-only`.

## See also

- [Recipes](Recipes.md): task-by-task examples, each linked to an importable file
- [Troubleshooting](Troubleshooting.md): what error messages mean and how to fix them
- [Usage guide](../guide/README.md) and [block reference](../guide/blocks.md)
- [Concepts](Concepts.md), [Using the Editor](Using-the-Editor.md)
- [Capabilities and Limitations](Capabilities-and-Limitations.md)
- [Locators](Locators.md) (internals of the locator engine)
