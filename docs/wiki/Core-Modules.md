# Core Modules

The pure helpers in `src/core` that are not the engine itself: settings validation, strict file
checking (issues, codes, did-you-mean), the template and expression languages, conditions, CSV, reports,
workflow import/export, the script format and auto-layout, the Playwright exporter, the recorder
converter, schedules, URLs, locator syntax and schema migrations. Read the section for the module you are about to
use or change. All of them are browser-free and unit-tested in Node (`tests/core/`).

**Source:** [config.ts](../../src/core/config.ts), [template.ts](../../src/core/template.ts),
[expression.ts](../../src/core/expression.ts), [condition.ts](../../src/core/condition.ts),
[text.ts](../../src/core/text.ts), [csv.ts](../../src/core/csv.ts), [report.ts](../../src/core/report.ts),
[library.ts](../../src/core/library.ts), [samples.ts](../../src/core/samples.ts),
[playwright.ts](../../src/core/playwright.ts), [playwrightRuntime.ts](../../src/core/playwrightRuntime.ts), [recording.ts](../../src/core/recording.ts),
[schedule.ts](../../src/core/schedule.ts), [url.ts](../../src/core/url.ts),
[urlPattern.ts](../../src/core/urlPattern.ts), [locatorSyntax.ts](../../src/core/locatorSyntax.ts),
[migrate.ts](../../src/core/migrate.ts), [issues.ts](../../src/core/issues.ts),
[check.ts](../../src/core/check.ts), [suggest.ts](../../src/core/suggest.ts),
[script.ts](../../src/core/script.ts), [layout.ts](../../src/core/layout.ts)

## config

Block settings: defaults, coercion, template rendering, validation.

| Export | Notes |
| --- | --- |
| `ValidationMode = 'design' \| 'run'` | `design`: what the user typed (a templated URL is accepted if non-empty; broken `{{ }}` reported). `run`: final values. |
| `withDefaults(def, raw)` | `{ ...def.defaultConfig, ...raw }`, number fields given as non-empty strings become numbers. No rendering. |
| `validateConfig(def, config, mode = 'run'): string[]` | One message per bad field (rules below). In design mode, also `templateErrors` for every `templated` string field. |
| `resolveConfig<C>(def, raw, input): { config, errors }` | `withDefaults`, then renders `templated` text/url/selector/locator fields and templated `rows` columns against `input`, then validates in `run` mode. Rows are normalised to string cells. |

Field rules: `text`/`selector`/`locator`/`url` required means non-blank; `url` must pass
`normalizeHttpUrl` (deferred in design mode when templated). `number` must be finite and within `min`/`max`.
`boolean` must be a boolean. `select` must be one of the options. `rows`: array; required means at least one
non-blank row; every filled row needs its first column. `workflow`: required means a non-blank id.

Called by: the engine (`resolveConfig` before every step and for `start`/`onTimer`), `validate.ts`, tests.

## template

The `{{…}}` language in settings. Plain paths are read directly; anything else goes to the expression
evaluator.

| Export | Notes |
| --- | --- |
| `hasTemplate(text)` | Any `{{…}}` token. |
| `getPath(data, path)` | `a.b[0].c`, optional `$json.` prefix (`$json` alone = whole payload). Own properties only. |
| `resolveToken(token, data)` | Path regex `^\$?[\w-]+(?:\.[\w$-]+\|\[\d+\])*$` (dashes allowed: `{{my-key}}`) → `getPath`; otherwise `evaluate`. An `ExpressionError` gives `''`. |
| `render(template, data)` | Every token replaced by `toText(value)`: missing → `''`, objects → JSON. |
| `templateErrors(template)` | Parse errors of non-path tokens, for design-mode validation. |

Gotcha: a path with a dash (`{{my-key}}`) is a path, but inside an expression `my-key` is subtraction.
`secret.*` is available because the engine adds `secret` to the render data (never to the payload).

## expression

A safe interpreter (no `eval`, forbidden in MV3) for `{{ … }}`, Transform and Filter. The supported syntax
is listed in the file header; rationale in [ARCHITECTURE: Data and scraping](../ARCHITECTURE.md#data-and-scraping).

| Export | Notes |
| --- | --- |
| `class ExpressionError` | Syntax or evaluation error. |
| `parseExpression(source)` | Tokenize + parse; AST cached by trimmed source (cache cleared past 500 entries). Unknown function names fail at parse time. |
| `evaluate(source, scope)` | Parse (cached) and interpret against `scope` (the payload). |
| `toNumber(value)` | Numbers as-is, booleans 1/0, strings read like a person (`"1,250"` → 1250, `"$9.99"` → 9.99), else `NaN`. |
| `toText(value)` | `''` for null/undefined, JSON for objects. |

Semantics worth knowing:

- Identifiers resolve to own properties of the payload; `$json` is the payload itself. `true`, `false`,
  `null` are literals. `.length` works on strings and arrays.
- `+` adds when both sides read as numbers (`"1,250" + 10` = 1260), otherwise concatenates.
- `==`/`===` compare **as text** (`1 == "1"` is true). `<`, `>` compare numerically when both read as
  numbers, else by `localeCompare`.
- `&&`, `||` short-circuit and return an operand; an empty array is falsy. `??` only for null/undefined.
- String escapes: only `\n`, `\t`, `\\`, `\'`, `\"`; any other backslash is kept, so `'/#(\d+)/'` works.
- Regex arguments (`matches`, `extract`, `replace`) accept `/re/flags` or a bare pattern.
- `now()` and `today()` read the clock from the evaluation context (`EvalEnv.now`, third argument of
  `evaluate` / `render` / `resolveConfig`); the engine and the data blocks pass `Host.now`, so tests with
  FakeHost's fixed clock get fixed dates. Without one, the system clock.

Called by: `template.ts`, `blocks/dataCommon.ts` (Transform, Filter).

## condition

Comparisons for If, Assert and Filter. Operands are strings already rendered from templates.

| Export | Notes |
| --- | --- |
| `Clause { left, operator, right }`, `Condition { match: 'all' \| 'any', clauses }` | |
| `OPERATORS` | `equals`, `not-equals`, `contains`, `not-contains`, `starts-with`, `ends-with`, `matches` (regex, `/re/flags` or bare), `greater`, `greater-equal`, `less`, `less-equal` (numbers via `parseNumber`; false if either side is not a number), `empty`, `not-empty`, `true` (`true/yes/on/1`), `false` (anything else). |
| `OPERATOR_OPTIONS` | `{ value, label }[]` for select fields. |
| `operatorLabel(value)`, `describeClause(clause)` | Readable text for summaries. |
| `parseNumber(text)` | Like `toNumber` but returns `null` for non-numbers. |
| `testClause(clause)` | Throws for an unknown operator or invalid regex (the step fails with that message). |
| `testCondition(condition)` | No clauses = true. |

## text

`normalizeText(text)` collapses whitespace (Watch Element compares normalised text so layout changes do not
count). `truncate(text, max = 80)` ends with `…` when cut.

## csv

| Export | Notes |
| --- | --- |
| `parseCsv(text, delimiter = ',')` | RFC 4180 (quoted cells with `""`, delimiters and newlines inside quotes; CRLF/LF/CR). Rows of only blank cells are dropped. |
| `csvToObjects(text)` | Delimiter guessed from the first line (`,`, `;` or tab, whichever splits most). First row = keys (blank header → `columnN`); cells trimmed. |
| `toCsv(rows)` | Columns = every key in first-seen order; non-objects become `{ value }`; objects in cells as JSON; ends with `\n`. |

Called by: Data Table, Download, the editor's Data page.

## report

Test reports from `RunRecord`s (see [Core Engine: Run records](Core-Engine.md#run-records-runsts)).

| Export | Notes |
| --- | --- |
| `ReportOptions { blockLabel(type), screenshots?, title? }` | `screenshots` maps screenshot id → data URL for the HTML report. |
| `durationOf(run)` | ms, 0 while running. |
| `summarize(runs): RunSummary` | `total`, `passed`, `failed` (includes `interrupted`), `other` (`cancelled` or `running`), `durationMs`. |
| `toJUnitXml(runs, options)` | One `<testsuite>` per workflow name, one `<testcase>` per run; failed/interrupted → `<failure>`, cancelled → `<skipped>`; step lines in `<system-out>` (failed ones end with `[error code]`). |
| `toHtmlReport(runs, options)` | One self-contained HTML page (inline CSS, screenshots embedded); failed steps show their error code. |
| `toJsonReport(runs, now?)` | `JsonReport { $schema, schemaVersion, generatedAt, summary, runs }`: Export JSON. |
| `REPORT_SCHEMA_VERSION` | `1`. Raise it when a report field changes meaning or goes away (new optional fields do not need it). |
| `REPORT_SCHEMA_PATH` | `docs/guide/report.schema.json`, generated by `scripts/reportSchema.ts` through `npm run guide:sync`. |

Called by: `ReportsPage.tsx`.

## library

Copy, export and import workflows.

| Export | Notes |
| --- | --- |
| `uniqueName(wanted, taken)` | `"Foo"`, else `"Foo 2"`, `"Foo 3"`… (case-insensitive). |
| `cloneWorkflow(source, name)` | Fresh ids for workflow, nodes and edges; disabled; config deep-copied. |
| `duplicateWorkflow(source, existing)` | Clone named `"<name> copy"` (made unique). |
| `exportWorkflows(workflows)` | `{ format: 'blockflow-workflows', version: 1, workflows }` JSON, all `enabled: false`. |
| `parseImport(text, existing, options?): ImportResult` | Parses (`parseJson`). A script file (`isScriptFile`) goes to `parseScriptImport`: compiled by `compileScriptFile`, then the compiled workflows are checked as one export file by `checkFile` and each issue path is moved back to the author's step (`/nodes/3/config/url` → `/steps/2/open/url`, or the shorthand string itself; step settings → `…/step/…`; a connection → the step it leaves from); Run Workflow may name another script of the file by `id` or `name`. Otherwise an export file or one bare workflow is checked by `checkFile` (below) with the existing workflow ids, laid out with `layoutWorkflow` when no node has a `position`. Any error refuses the whole file. Then: renames old config keys (`migrateNode`), clones with new ids, disables, uniquifies names, and remaps `run-workflow` `config.workflow` ids to the imported copies. `options`: `registry` (default: the built-in blocks), `secrets` (names, for `secret.unknown`). |
| `ImportResult` | `{ ok: true, workflows, issues }` (issues are warnings/info only) or `{ ok: false, error, issues }` (`error` = first error's message plus "(and N more problems)"). |

`cloneWorkflow` and `parseImport` keep `node.step` and `edge.sourcePort`, so branches and step settings
survive duplicate and import (tested in `library.test.ts` and `guideExamples.test.ts`).

Called by: `Editor.tsx` (duplicate, import, export, templates).

## issues

The one shape every file checker reports in: strict checking (`check.ts`), the script compiler and
migrations. An LLM (or a person) reads `code` and `path` to repair the file.

| Export | Notes |
| --- | --- |
| `Issue { level, code, path, message, hint? }` | `level`: `error` (blocks an import), `warning` (imports, with a banner), `info` (a note). `code`: stable, listed in the guide's "Repair" table. `path`: a JSON Pointer into the file as written (`/workflows/0/nodes/3/config/locater`, `''` = the whole file). `hint`: how to fix it, often `Did you mean "locator"?`. |
| `pointer(...parts)` | RFC 6901 pointer from segments (escapes `~` and `/`). |
| `hasErrors(issues)` | Any `error`? |

Not to be confused with `validate.ts`'s editor `Issue` (`nodeId`/`edgeId`, no code or path), which the
canvas uses to mark blocks.

## check

Strict checking of a workflow file before import, on the raw JSON, so paths and ids are the author's.

| Export | Notes |
| --- | --- |
| `checkFile(raw, registry, options?): Issue[]` | Every problem, in file order. `options.workflowIds`: saved workflows Run Workflow may call; `options.secrets`: secret names (without it, `secret.unknown` is never reported). |
| `parseJson(text)` | `{ ok, data }` or `{ ok: false, issues: [json.invalid] }` with the parser's position message. |
| `locatorProblem(source)` | `{ message, hint? }` or null: unclosed quote/bracket, empty step, an unknown `engine=` prefix (did-you-mean against `ENGINES`), non-numeric `nth=`. Templated locators are not checked. |
| `EXPORT_FORMAT` | `'blockflow-workflows'`. |

What it checks, by level (codes in the guide's [Repair table](../guide/README.md#repair-what-import-errors-mean)):

- **error**: `file.shape` (not an object, `workflows`/`nodes`/`edges` not lists, node without string
  `id`/`type`, `config`/`step` not objects, schema newer than this build), `node.id.duplicate`,
  `node.type.unknown`, `config.key.unknown` (also unknown columns in `rows` settings), `config.type`,
  `config.required`, `config.enum`, `config.value` (number out of range, and `validate` hooks such as a bad
  Schedule time), `config.locator.invalid`, `config.url.invalid`, `config.template.invalid`,
  `edge.endpoint.missing`, `edge.port.unknown` (including `error` without `onError: "port"`),
  `edge.target.no-input` (into a block without `run`), `step.key.unknown`, `step.value`, `graph.no-start`
  (every block has an input), `graph.cycle` for a block wired to itself, `workflow.call.missing` (Run
  Workflow target not in the file nor saved), and whatever a block's `validate` hook returns.
- **warning**: `file.key.unknown` (unknown keys on the file, a workflow, a node or an edge; ignored on
  import), `config.template.unsupported` (`{{…}}` in a setting that does not render it), `edge.duplicate`,
  `graph.cycle` (a loop back: allowed, the run's step limit stops it), `graph.unreachable`, `page.no-tab`,
  `secret.unknown`, `graph.no-start` for an empty workflow.
- **info**: `config.key.renamed` (an old key such as `selector`; it is moved on import).

Design points:

- Legacy keys a block still reads (`BlockDefinition.legacyKeys`, e.g. Open Tab's `newTab`) and renamed keys
  (`RENAMED_KEYS`) are not unknown. Numeric strings in number settings are accepted (`withDefaults`
  coerces them). Values that come from defaults are not checked for syntax, only the author's.
- Templated values (`{{…}}`) are checked for template syntax only; URL and locator syntax wait for run time.
- `page.no-tab` is a forward "must" analysis over the graph: the tabs certainly open before a block are the
  intersection over its incoming paths, plus what each block opens (Open Tab: its `tab`; Wait for Popup:
  its `name`; Page Visited and Context Menu: `main`). An `error` output carries what the failed block had
  before it. Disabled blocks neither open nor need a tab. Skipped for a workflow that a Run Workflow in the
  same file calls (it gets the caller's tabs). A warning, because a sub-workflow saved earlier can also
  receive tabs.
- Loops are made with Repeat / For Each / Paginate (they `emit` on `each` and await the branch), never with
  a connection back, so a cycle is a warning (probably a mistake, but the engine tolerates it).
- Unknown keys get a hint from an alias table first (`settings`→`config`, `from`→`source`,
  `sourceHandle`→`sourcePort`…), then did-you-mean, else the list of valid keys.

Called by: `parseImport` (so the editor's Import, templates and tests), `tests/core/check.test.ts`.

## suggest

Did-you-mean.

| Export | Notes |
| --- | --- |
| `editDistance(a, b)` | Damerau-Levenshtein (optimal string alignment): insert, delete, substitute, swap neighbours. |
| `closest(word, candidates, maxDistance = 2)` | Case-insensitive best match within the distance (1 for words of 3 letters or fewer), or undefined. |
| `didYouMean(word, candidates)` | `Did you mean "x"?` or undefined. |

Called by: `check.ts`.
## script

The script format ([Workflows as Scripts](Workflows-as-Scripts.md#the-script-format)): a workflow as a
list of steps, compiled to a graph and back. Needs a `BlockRegistry` (defaults to `createDefaultRegistry()`)
for block types, ports and default configs.

| Export | Notes |
| --- | --- |
| `compileScript(raw, registry?, base?): CompiledScript` | One script → `{ workflow?, issues, nodePaths, configPaths, scriptId? }`. Node ids are the steps' `id`s, else `s<N>` (Nth step top to bottom, skipping author ids); `origin` = node id. Configs are the defaults plus the author's keys (old keys moved by `migrateNode` first). Positions from `layoutWorkflow`. `workflow` is missing when there are errors. `nodePaths` / `configPaths`: node id → JSON Pointer of its step / its config value (`/steps/2/true/0`, `…/click`), so other checkers can point into the script. `base` prefixes every path. |
| `compileScriptFile(raw, registry?)` | One script, or `{ format, version, scripts: [...] }` (paths under `/scripts/N`). |
| `decompile(workflow, registry?): Script \| null` | The graph as a script when it is a tree in the format's sense (one start, no fan-out, joins only after an If, no cycles); verified by compiling back and comparing with `sameScriptGraph`. Uses aliases and shorthands, drops config values equal to the default, keeps `origin` ids (drops uuids and ids a compile would generate). |
| `sameScriptGraph(a, b, registry, idOf?)` | Same blocks, configs (with defaults), step settings and wiring by port, nodes matched by id (or `idOf`). |
| `isScriptFile(data)` | `format: "blockflow-script"`, or a `steps` array and no `nodes`. |
| `continuePort(ports)` | `out`, else `done`, else undefined (If: its branches rejoin). |
| `didYouMean(word, candidates)` | Closest candidate within Damerau-Levenshtein distance 2 (its own copy; `suggest.ts` has the shared one). |
| `SCRIPT_ALIASES`, `SCRIPT_SHORTHAND` | Alias → block type; block type → the config key a bare value fills. |

Wiring: a step connects to the next from its continue port; lists on other ports (`each`, `onError`) end
where they end; a block without a continue port (If) connects the next step from the end of each branch
list and from each port that has no list. Issue codes: `script.shape`, `script.version`, `script.empty`,
`step.shape`, `node.type.unknown`, `node.id.duplicate`, `edge.port.unknown`, `step.branch.next`,
`step.onError.conflict` (table in [Workflows as Scripts](Workflows-as-Scripts.md#script-problems)).

Called by: `parseImport` (`library.ts`), the editor's **Export as script**, `scripts/scriptSchema.ts`
(generates `docs/guide/script.schema.json`). Tests: `tests/core/script.test.ts`, and the guide examples
round trip (graph → decompile → compile is the same graph; `*.script.json` compile to the `*.blockflow.json`
graphs) in `guideExamples.test.ts`.

## layout

Automatic left-to-right layout, pure and deterministic.

| Export | Notes |
| --- | --- |
| `layoutGraph(nodes, edges, portRank?)` | Map node id → `{x, y}`. Longest-path layers (edges closing a cycle ignored), then per column, left to right, nodes sorted by the average index of their parents plus a slot for the port they hang off (`portRank`), then rows: parents' average row (rounded up the page) when free, else the next free row. A chain is one row; branches open downwards; nothing overlaps. |
| `layoutWorkflow(workflow, registry?)` | Every node placed. Ports ranked as the blocks declare them, or by `out, true, each, false, done, error` without a registry. |
| `LAYOUT_X`, `LAYOUT_Y` | 260 and 140 px. |

Called by: `compileScript`, `parseImport` (graph files without positions), the editor's **Tidy up**.
Tests: `tests/core/layout.test.ts`.

## migrate

Workflow schema versions (`Workflow.schemaVersion`) and the steps between them. Version 2 (v0.3) calls
every element setting `locator`: Read Element and Watch Element used `selector`, Paginate used `next`.

| Export | Notes |
| --- | --- |
| `CURRENT_SCHEMA_VERSION` | `2`. |
| `RENAMED_KEYS` | Per block type, old config key → new key. Also read by `check.ts` to report `config.key.renamed`. |
| `migrateNode(node, renames?)` | Moves renamed keys (the new key wins when both exist). Same object back when nothing changed. Applied to every imported node whatever the file's version, so old key names are always accepted. |
| `migrateWorkflow(workflow, renames?)` | Brings an older workflow to the current version; no-op (same object) when current. |
| `migrateWorkflows(list)` | `{ workflows, changed }`. |

Called by: `loadWorkflows` (`src/browser/stores.ts`, every read is migrated), `migrateStoredWorkflows`
(the background's `onInstalled` rewrites `bf:workflows` once after an update), the background's
`bf:run-workflow` handler and storage-change diff (both sides migrated, so the rewrite restarts nothing),
the editor's storage listener, and `parseImport`. Adding a version: bump the constant, add the step in
`migrateWorkflow`, add v(n-1) fixtures to `tests/core/migrate.test.ts`.

## samples

`sampleWorkflows()`: two disabled examples created on first install ("open a page every 5 minutes":
Timer → Open Tab; "open the page when part of it changes": Watch Element → Open Tab). Called by the
background's `onInstalled`. Note the Open Tab configs use the legacy `newTab: true` key; `openUrl.ts` still
accepts it.

## playwright

Exports a workflow as a Playwright test. See
[ARCHITECTURE: Harder pages](../ARCHITECTURE.md#harder-pages-phase-f).

| Export | Notes |
| --- | --- |
| `ExportOptions { registry, lookup?(id) }` | `lookup` resolves Run Workflow targets. |
| `toPlaywrightLocator(locator, base)` | Per [locator step](#locatorsyntax): `css` → `.locator()` (`>>>` dropped, Playwright CSS pierces shadow roots), `xpath` → `.locator('xpath=…')`, `text/label/placeholder/alt/title` → `getByX` (quoted = `exact: true`, `/re/` = regex), `testid` → `getByTestId`, `frame` → `frameLocator`, `nth` → `first()/last()/nth()`, `role` → `getByRole` with `name`, `exact`, `checked`, `pressed`, `expanded`, `selected`, `disabled`, `level`, `includeHidden`; filters → `.filter({ hasText | hasNotText | has | hasNot | visible })` (`has` locators built from the page or the current `frameLocator`; quoted `has-text` → `/^…$/`); `A \|\| B` → `A.or(B)`. |
| `workflowToPlaywright(workflow, options)` | Full `.spec.ts`: one `test()` with the `page`, `context` and `request` fixtures, a `tabs` map and a mutable `data` object; called workflows as functions; helper functions (`render`, `evaluate`, `listAt`, `compare`, `parseRows`, `urlPattern`, `retry`, `waitForResponse`, `waitForPopup`, `answerDialogs`, `fileFromUrl`, `setField`, `selectByText`, `read`, `peek`, `extractList`, `extractTable`…) and the inlined runtime appended. |

How it walks: from every root, depth-first along edges (`Writer.walk`); a node already on the current path
writes a "loop back … not exported" comment. Each step writes only its own statements; `walk` wraps them
for the step settings: `retries` → `retry(n, async () => …)`, `onError: 'continue'` → `try/catch` that
logs, `onError: 'port'` with an error edge → `try/catch` running the error branch and an `if (okN)` around
the normal continuation; `timeoutSeconds` → `{ timeout }` on the action or matcher; `disabled` → a comment.
If → `if/else`; For Each, Repeat, Paginate → `for` loops with `each` inside and `done` after (For Each and
Repeat restore the input afterwards). Triggers (a root Timer, Schedule, Page Visited, Context Menu, Watch
Element) become comments; a fed Timer is `page.waitForTimeout`; unknown blocks become
`// BlockFlow-only:` comments. Templates: any `{{…}}` → `render("…", data)` (BlockFlow's own
`template.ts`, with `{ ...data, secret: SECRETS }` and `SECRETS` read from `process.env`). Assert uses
web-first matchers for equals / not-equals / matches (and contains for text), `expect.poll` around
`compare` for the rest. Open Tab `where: current/workflow` reuses `page`.

### playwrightRuntime

The BlockFlow runtime inlined at the end of every exported spec. `runtimeSource()` reads the source of
`expression.ts`, `condition.ts`, `csv.ts`, `urlPattern.ts` and `template.ts` with Vite's `?raw` import
(build time; declared in `src/core/raw.d.ts`) and wraps each in a closure
(`const expressionModule = (() => { … return { evaluate, … }; })();`) with `wrapModule(name, source,
known)`: `export` dropped, value imports between these modules turned into destructuring, type imports
removed (`Payload` is declared once). An import of any other module throws, so a new dependency in
those files fails the unit tests instead of producing a broken spec. Because the text is the real
source, the export cannot drift from the extension.

Called by: `Editor.tsx` (export), `tests/core/playwright.test.ts`, and the e2e run.

## recording

Turns what the recorder ([Picker and Recorder](Picker-and-Recorder.md)) captured into blocks.

| Export | Notes |
| --- | --- |
| `RecordedStep` | `click`, `fill` (`secret?` for passwords), `select`, `check`, `press`, `navigated`, `assert-text`, `assert-visible`. |
| `Recording { startUrl, steps }` | |
| `tidySteps(steps)` | Consecutive fills of the same locator keep the last; consecutive navigations keep the last. |
| `recordingToBlocks(recording, origin?): RecordedBlocks` | Open Tab, then one block per step in a line (240 px apart) wired in sequence. 2+ fills in a run of fill/select/check become one Fill Form (a directly following click becomes its `submit`). Secret fills become `{{secret.password}}` and `secrets` lists `password`. A navigation becomes Wait For URL with the URL's path. |

Called by: `Editor.tsx`, `src/browser/recording.ts`, `src/dom/recorder.ts` (types), `src/shared/messages.ts`.

## schedule

Pure next-fire-time maths for the Schedule block, in local time.

| Export | Notes |
| --- | --- |
| `ScheduleSpec` | `{ every: 'day', at: 'HH:MM', days: number[] }` (0 = Sunday, empty = every day), `{ every: 'hour', minute }`, `{ every: 'minutes', minutes }`. |
| `parseTime(text)` | `"9:30"`/`"09:30"` → `{ hour, minute }` or null. |
| `nextOccurrence(now, spec)` | First matching time strictly after `now`, seconds zeroed. `minutes` aligns to the clock from midnight (00, 10, 20…). Throws for a bad time. |
| `parseDays(text)` | `"mon,wed"`, `"weekdays"`, `"weekends"`, `"every day"`/`"daily"`/`""` → day numbers. |

The block sets a one-shot timer for the next occurrence and plans the following one when it fires
([Scheduling and Timers](Scheduling-and-Timers.md)).

## url

`normalizeHttpUrl(raw): string | null`. Adds `https://` when there is no scheme; rejects
`javascript:`, `data:`, `file:`, extension and browser pages and anything not http(s) or without a host.
Returns `URL.href`. Used by `config.ts` (url fields), the picker, and URL-taking blocks.

## urlPattern

`urlMatches(url, pattern): boolean`. `/re/flags` → regex (throws "Invalid URL pattern" when bad); a pattern
with `*` → glob anchored to the whole URL (`*` = anything but `/`, `**` = anything); otherwise "URL
contains". Empty pattern = false. Used by `src/browser/navigation.ts` (Wait For URL), the background (Page
Visited) and the fake host.

## locatorSyntax

String-level locator parsing, shared by the page agent's resolver ([Locators](Locators.md)) and the
Playwright exporter. No DOM.

| Export | Notes |
| --- | --- |
| `class LocatorSyntaxError` | Empty or malformed locator. |
| `LocatorStep { engine, body }` | |
| `ENGINES` | `css`, `text`, `role`, `label`, `placeholder`, `testid`, `alt`, `title`, `xpath`, `nth`, `frame`, plus `FILTERS`. |
| `FILTERS` | `has-text`, `has-not-text`, `has`, `has-not`, `visible`: steps that narrow the matches so far. |
| `splitAlternatives(source)` / `parseLocatorAlternatives(source)` | `A \|\| B` split outside quotes and brackets (`\|\|` binds loosest); the second also parses each into steps. |
| `parseLocatorSteps(source)` | One alternative. Splits on `>>` outside quotes and brackets (leaves the shadow-piercing `>>>` alone). `engine=body` for known engines; a bare `visible` → the visible filter; else `//…` or `(//…` → xpath, a double-quoted string → text, anything else → css. |
| `nestedLocator(body)`, `visibleFilter(body)` | The inner locator of `has=`/`has-not=` (unquoted when fully quoted); `visible=` as a boolean (throws for anything but true/false). |
| `ROLE_OPTIONS`, `ROLE_STATES`, `parseRoleSelector(body)`, `roleState(option)`, `unquoteValue(value)` | `role=` options parsed once for the resolver, the checker and the exporter: unknown options, bad state values and non-number levels throw `LocatorSyntaxError`. |

## See also

- [Core Engine](Core-Engine.md)
- [Page Protocol](Page-Protocol.md), [Locators](Locators.md)
- [Block Internals](Block-Internals.md)
- [Editor](Editor.md) (import/export and the import issues dialog, reports, Playwright export UI)
- [Picker and Recorder](Picker-and-Recorder.md)
- [Testing](Testing.md)
