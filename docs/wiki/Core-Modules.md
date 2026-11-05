# Core Modules

The pure helpers in `src/core` that are not the engine itself: settings validation, the template and
expression languages, conditions, CSV, reports, workflow import/export, the Playwright exporter, the
recorder converter, schedules, URLs and locator syntax. Read the section for the module you are about to
use or change. All of them are browser-free and unit-tested in Node (`tests/core/`).

**Source:** [config.ts](../../src/core/config.ts), [template.ts](../../src/core/template.ts),
[expression.ts](../../src/core/expression.ts), [condition.ts](../../src/core/condition.ts),
[text.ts](../../src/core/text.ts), [csv.ts](../../src/core/csv.ts), [report.ts](../../src/core/report.ts),
[library.ts](../../src/core/library.ts), [samples.ts](../../src/core/samples.ts),
[playwright.ts](../../src/core/playwright.ts), [playwrightRuntime.ts](../../src/core/playwrightRuntime.ts), [recording.ts](../../src/core/recording.ts),
[schedule.ts](../../src/core/schedule.ts), [url.ts](../../src/core/url.ts),
[urlPattern.ts](../../src/core/urlPattern.ts), [locatorSyntax.ts](../../src/core/locatorSyntax.ts)

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
- `now()` and `today()` use the real clock, not `Host.now`.

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
| `toJUnitXml(runs, options)` | One `<testsuite>` per workflow name, one `<testcase>` per run; failed/interrupted → `<failure>`, cancelled → `<skipped>`; step lines in `<system-out>`. |
| `toHtmlReport(runs, options)` | One self-contained HTML page (inline CSS, screenshots embedded). |

Called by: `ReportsPage.tsx`.

## library

Copy, export and import workflows.

| Export | Notes |
| --- | --- |
| `uniqueName(wanted, taken)` | `"Foo"`, else `"Foo 2"`, `"Foo 3"`… (case-insensitive). |
| `cloneWorkflow(source, name)` | Fresh ids for workflow, nodes and edges; disabled; config deep-copied. |
| `duplicateWorkflow(source, existing)` | Clone named `"<name> copy"` (made unique). |
| `exportWorkflows(workflows)` | `{ format: 'blockflow-workflows', version: 1, workflows }` JSON, all `enabled: false`. |
| `parseImport(text, existing): ImportResult` | Accepts an export file or one bare workflow. Validates shape, clones with new ids, disables, uniquifies names, and remaps `run-workflow` `config.workflow` ids to the imported copies. |

Gotcha (looks like a bug): `cloneWorkflow` and `parseImport` rebuild nodes and edges without
`node.step` and `edge.sourcePort`, so a duplicated or imported workflow loses its step settings and every
connection falls back to the source's first output (an If's `false` branch becomes `true`).

Called by: `Editor.tsx` (duplicate, import, export, templates).

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
| `toPlaywrightLocator(locator, base)` | Per [locator step](#locatorsyntax): `css` → `.locator()` (`>>>` dropped, Playwright CSS pierces shadow roots), `xpath` → `.locator('xpath=…')`, `text/label/placeholder/alt/title` → `getByX` (quoted = `exact: true`, `/re/` = regex), `testid` → `getByTestId`, `frame` → `frameLocator`, `nth` → `first()/last()/nth()`, `role` → `getByRole` with `name`, `exact`, `checked`, `level`. |
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
| `ENGINES` | `css`, `text`, `role`, `label`, `placeholder`, `testid`, `alt`, `title`, `xpath`, `nth`, `frame`. |
| `parseLocatorSteps(source)` | Splits on `>>` outside quotes and brackets (leaves the shadow-piercing `>>>` alone). `engine=body` for known engines; else `//…` or `(//…` → xpath, a double-quoted string → text, anything else → css. |

## See also

- [Core Engine](Core-Engine.md)
- [Page Protocol](Page-Protocol.md), [Locators](Locators.md)
- [Block Internals](Block-Internals.md)
- [Editor](Editor.md) (import/export, reports, Playwright export UI)
- [Picker and Recorder](Picker-and-Recorder.md)
- [Testing](Testing.md)
