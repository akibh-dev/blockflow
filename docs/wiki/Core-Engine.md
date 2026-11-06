# Core Engine

The engine runs one workflow graph against the `Host` interface: it starts root blocks, carries payloads
along edges, applies step settings (timeout, retries, on-error, screenshots), records runs and masks
secrets. Read this page before changing `WorkflowRunner`, the `Host` contract, or the `BlockContext`
that blocks receive. For the reasoning behind the design see
[ARCHITECTURE: Engine model](../ARCHITECTURE.md#engine-model-srccoreenginets).

**Source:** [engine.ts](../../src/core/engine.ts), [runs.ts](../../src/core/runs.ts),
[ports.ts](../../src/core/ports.ts), [session.ts](../../src/core/session.ts),
[workflow.ts](../../src/core/workflow.ts), [validate.ts](../../src/core/validate.ts),
[registry.ts](../../src/core/registry.ts), [types.ts](../../src/core/types.ts),
[timerKey.ts](../../src/core/timerKey.ts), [id.ts](../../src/core/id.ts)

Rule of the whole folder: nothing in `src/core` touches browser APIs or DOM types. Everything from outside
comes through `Host`.

## Data model (`types.ts`)

| Type | Shape / meaning |
| --- | --- |
| `Payload` | `Record<string, unknown>`; the data passed between blocks. Must stay JSON-serialisable (stored with timers and run records). |
| `Workflow` | `{ schemaVersion: 2, id, name, enabled, nodes: NodeDef[], edges: EdgeDef[] }`. Stored as a list (see [Storage Keys](Storage-Keys.md)). Older versions are migrated on load and import by `migrate.ts` ([Core Modules](Core-Modules.md#migrate)). |
| `NodeDef` | `{ id, type, position, config, step? }`. `type` is looked up in the `BlockRegistry`. |
| `EdgeDef` | `{ id, source, target, sourcePort? }`. Missing `sourcePort` = the source's first output. |
| `StepSettings` | Engine-applied per-node settings: `timeoutSeconds`, `retries` (0..5), `onError` (`stop` / `continue` / `port`), `disabled`, `note`, `screenshot` (`error` default / `always` / `never`), `realInput`. |
| `LogEntry`, `LogSink` | `{ ts, workflowId, nodeId?, level, message }`; the runner's log callback. |
| `FieldSpec` | Union of `TextField` (`text`/`url`/`selector`/`locator`, `templated`, `multiline`, `pickerUrlKey`, `pickPrefers`), `NumberField`, `BooleanField`, `SelectField`, `RowsField` (columns may be `templated`/`locator`, `detectForm`), `WorkflowField`. Validated by `config.ts` ([Core Modules](Core-Modules.md#config)). |
| `BlockCategory`, `CATEGORY_LABELS` | Palette groups (`start`, `browser`, `page`, `read`, `test`, `logic`, `data`, `output`). |

## Block contract

### `BlockDefinition<C>`

| Member | Purpose |
| --- | --- |
| `type`, `label`, `description`, `icon`, `accent`, `category?` | Identity and editor look. `category` is set at registration (`BLOCK_GROUPS` in `blocks/index.ts`). |
| `defaultConfig: C`, `fields: FieldSpec[]`, `outputs: OutputSpec[]`, `summary?(config)` | Settings and documentation shown in the editor and generated guide. |
| `ports?: string[] \| ((config: C) => string[])` | Named outputs; default `['out']`. The engine appends `error` when the node's `onError` is `port`. A function makes them **dynamic** (Switch: one per case + `default`): it gets the config with defaults, not rendered, must not throw, and should keep names stable while a setting is being typed. Read ports only through `nodePorts(def, node)`. |
| `timeoutSeconds?` | Default step timeout for this block type (page actions use 30). |
| `permissions?` | Optional browser permissions (`debugger`, `userScripts`) the editor offers to grant. |
| `start?(ctx)` | Root block started with the workflow: schedule timers, register watchers. Never called for non-roots. |
| `trigger?(ctx)` | Root block on the Run button (and as a called workflow's entry): return a payload to send now, or `null`. |
| `run?(ctx, input)` | Called when an upstream block emits. Returns `RunOutput`. A block without `run` cannot have inputs (validation error). |
| `onTimer?(ctx, name, data)` | Called when a timer set with `ctx.timers.set(name, …)` fires. |

`RunOutput = Payload | Routed | null | undefined | void`. A plain payload goes out of the first port;
`routeTo(port, payload)` picks a port; `null`/`undefined` ends this path (the step still passes).

See [Block Internals](Block-Internals.md) and [Adding a Block](Adding-a-Block.md) for writing one.

### `BlockContext<C>` (what `ctx` holds)

Built per call by the private `makeContext()`; do not keep it between calls.

| Member | Notes |
| --- | --- |
| `workflowId`, `workflowName`, `nodeId` | Identity. |
| `config: C` | Defaults applied, `templated` fields rendered against the input (and `secret.*`), validated. |
| `isRoot` | Nothing feeds this node. |
| `timeoutMs` | This step's timeout. Page blocks wait a bit less (`pageWaitMs`) so the page's reason wins. Start/timer contexts get the 60 s default. |
| `realInput` | `step.realInput === true`. |
| `runId` | Current run id, `''` in `start` / `onTimer` (no run yet). |
| `softFail(failure)` | Marks the step and run failed but lets the block return normally (soft Assert). `failure` is a message or an `Error`; a `CodedError` also records its code. Outside a run it only logs. |
| `callWorkflow(id, input)` | Runs another workflow as a child run and resolves with its last output. Throws outside a run, when nested ≥ `MAX_CALL_DEPTH` (8), when the workflow is missing, or when the child did not pass. |
| `host` | The `Host` (below). |
| `emit(payload, port = 'out')` | Inside a run: runs the downstream subtree now and awaits it (loops use this with `each`), resolving with the data at the end of the last path it reached (the payload itself when nothing is connected; `undefined` when every path stopped). Repeat until/while tests its condition on that. Outside a run (`start`/`onTimer`): starts a **new run** whose first step is this block, trigger `start` or `timer`. |
| `log(level, message)` | Masked log line tagged with the node. |
| `timers.set(name, options, data?)` / `clear(name)` | `Host.scheduler` with key `makeTimerKey(workflowId, nodeId, name)`. |
| `state.get(key)` / `set(key, value)` | `Host.state` with key `stateKey(workflowId, nodeId, key)`; survives worker restarts. |

## The `Host` interface

Implemented by `src/browser/host.ts` ([Browser Host](Browser-Host.md)) and by
`tests/helpers/fakeHost.ts` ([Testing](Testing.md)).

| Member | Signature | Used by |
| --- | --- | --- |
| `sleep` | `(ms) => Promise<void>` | Step timeouts, retry backoff, screenshot race. |
| `http.fetch` | `(HttpRequestOptions) => Promise<HttpResult>` | HTTP Request. Body is cut to a safe size. |
| `http.download` | `(url) => Promise<{ base64, mime, name }>` | Upload File from a URL. |
| `notify` | `({ title, message }) => Promise<void>` | Notify. |
| `tabs.open` | `(OpenTabOptions) => Promise<{ tabId }>` | Open Tab. Options: `url`, `newTab`, `active`, `reuseTabId?`, `newWindow?`, `waitUntil?` (default `none`), `timeoutMs?`. |
| `tabs.navigate` | `(tabId, { action: goto/back/forward/reload, url?, waitUntil, timeoutMs }) => Promise<{ url }>` | Navigate. |
| `tabs.close` | `(tabId) => Promise<void>` | Close Tab. |
| `tabs.info` | `(tabId) => Promise<TabInfo \| null>` | `null` when the tab is gone. |
| `tabs.current` | `() => Promise<(TabInfo & { tabId }) \| null>` | The web tab the user is looking at (not the editor). |
| `tabs.waitForLoad` | `(tabId, until, timeoutMs)` | Wait For load / network idle. |
| `tabs.waitForUrl` | `(tabId, pattern, timeoutMs) => Promise<string>` | Wait For URL ([`urlMatches`](Core-Modules.md#urlpattern)). |
| `tabs.waitForPopup` | `(openerTabId, lookBackMs, timeoutMs) => Promise<number>` | Wait For Popup. |
| `tabs.waitForResponse` | `(tabId, pattern, status, lookBackMs, timeoutMs) => Promise<{ url, status, method }>` | Wait For response. |
| `page.readElement` | `(ReadElementOptions) => Promise<ReadElementResult>` | Watch / Read Element with a URL (BlockFlow's own background tab). |
| `page.act` | `(tabId, AgentRequest, timeoutMs, { realInput? }) => Promise<Record<string, unknown>>` | Every page block. See [Page Protocol](Page-Protocol.md). Throws with the agent's last reason on timeout. |
| `page.dialogs` | `(tabId, { mode, text } \| { read: true })` | Dialogs block. |
| `page.runScript` | `(tabId, code, data) => Promise<unknown>` | Run Script (userScripts API). |
| `scheduler` | `Scheduler` | Timers ([Scheduling and Timers](Scheduling-and-Timers.md)). |
| `state` | `StateStore` (`get`, `set`) | `ctx.state`. |
| `workflows.get` | `(id) => Promise<Workflow \| undefined>` | Run Workflow (`callWorkflow`). |
| `secrets.all` | `() => Promise<Record<string, string>>` | Loaded once per run. |
| `screenshots.capture` | `(tabId, runId) => Promise<string \| null>` | After-step screenshots. |
| `datasets.read` / `write` | `(name)`, `(name, rows, 'append' \| 'replace') => Promise<number>` | Save Dataset and friends. |
| `downloads.save` | `(filename, content, mime)` | Download. |
| `html.act` | `(html, baseUrl, AgentRequest)` | Extract from fetched HTML (agent on a parsed document). |
| `prompt.ask` | `({ runId, workflowName, message, timeoutMs }) => Promise<boolean>` | Manual Step. |
| `now` | `() => Date` | All engine timestamps. |

`Scheduler`: `set(key, options, data?)`, `clear(key)`, `clearPrefix(prefix)`, `take(key)`. `take` returns the
stored `TimerRecord` (`{ data?, periodic }`) and deletes one-shot timers; `undefined` means stale or cleared
and the engine ignores the firing.

## `WorkflowRunner` (`engine.ts`)

```ts
new WorkflowRunner({ workflow, registry, host, log?, maxSteps?, onRun?, isCancelled?, callDepth? })
```

| Method | What it does | Called by |
| --- | --- | --- |
| `rootNodes()` | Nodes with no incoming edge. | internal, tests |
| `start()` | Clears the workflow's timers (`clearPrefix`), then for each root: `def.start(ctx)`; a root without `start` but with `run` gets one run (trigger `start`) with `{}`. Config errors are logged, not thrown. | background, on enable/edit/startup/install |
| `stop()` | Sets `stopped`, clears timers. | background, on disable/delete |
| `runOnce()` | One run (trigger `manual`): every root once, through `trigger` if it has one (its result is merged over the input), else `run`. Schedules nothing. | Run button |
| `runAsCall(input, parentRunId)` | Like `runOnce` with `input` for every root, trigger `call`; returns `{ record, output }` where output is `lastOutput ?? input`. | `callWorkflow` (child runner) |
| `handleEvent(nodeId, payload)` | New run (trigger `event`) starting at that node's `run`. | Page Visited, Context Menu |
| `handleTimer(key)` | Parses the key, ignores other workflows, `scheduler.take(key)`, then calls `def.onTimer(ctx, name, data)` under `guard`. Safe on a fresh runner. | `onAlarm` in the background |

Exported helpers: `DEFAULT_MAX_STEPS` (1000), `DEFAULT_TIMEOUT_SECONDS` (60), `MAX_RETRIES` (5),
`MAX_CALL_DEPTH` (8), `stepTimeoutSeconds(node, def)` (step setting if > 0, else the block type's
`timeoutSeconds`, else 60; also used by the editor).

### Run lifecycle

1. `inRun(trigger, body)` creates a `RunRecord` (`status: 'running'`), publishes it, loads
   `host.secrets.all()` (values of 3+ characters are used for masking), runs `body`.
2. `body` calls `runStep(node, input, run)` for the entry blocks.
3. Anything thrown out of `body` fails the run. At the end the status is `cancelled` (if cancelled),
   else `failed` or `passed`; `endedAt` is set; the final copy is published and returned.

### One step (`runStep`)

```text
cancelled/stopped? ──▶ mark run cancelled, return
steps >= maxSteps? ──▶ fail run once ("Is there a loop?"), return
beginStep (record input, masked + compacted)
unknown type ──▶ failStep
no run/invoke ──▶ step "skipped" (warn)
step.disabled ──▶ step "skipped", emit input out of first port
attempt():
  resolveConfig(def, node.config, {...input, secret}) ── errors ─▶ failure
  loop: ctx = makeContext(...); withTimeout(call(ctx, input), timeoutSeconds)
        throw ─▶ retry after min(1s·2^(n-1), 10s) via Host.sleep, up to `retries`
failure (message + errorDetails(error)) ──▶ handleFailure by step.onError:
   continue: step "handled", input goes out of the first port
   port:     step "handled", {...input, error, errorCode, errorBlock} goes out of "error"
   default:  failStep (step "failed", run failed, path ends)
success:
   no output   ──▶ step passed (or failed if softFail was called); path ends
   Routed/port ──▶ port must be in nodePorts() else failure
   endStep, afterStep (screenshot), emitFrom(node, payload, port)
```

**Error details.** Every failure carries `ErrorDetails` (`code`, `locator?`, `url?`, `matches?`) from
`errorDetails(error)` in [errors.ts](../../src/core/errors.ts): a thrown `CodedError` (or anything with a
known `code` property) keeps its code, anything else is `step.failed`. The engine adds its own: config that
does not render or an unknown block type is `config.invalid`, its step timeout is `timeout`, a failed
called workflow is `workflow.failed`, a soft failure given as plain text is `step.failed`. `endStep` copies
them onto the step record next to `error` (masked like the message).

`emitFrom` runs every edge whose `edgePort()` equals the port, **sequentially and depth-first**, each target
getting a shallow copy `{ ...payload }`. If no edge leaves that port, the payload is stored as
`run.lastOutput` (the result of a called workflow).

**Screenshots** (`afterStep`): by `step.screenshot` (default only when something went wrong), of the tab
named by `config.tab` (else `main`) looked up in the payload's `$session`. Raced against 8 s; errors are
swallowed.

### Timers and state

Blocks never use `setTimeout`. `ctx.timers.set` stores a timer under
`bf::<workflowId>::<nodeId>::<name>`; when it fires, the background builds a fresh runner and calls
`handleTimer(key)`. Anything a block must remember goes in `ctx.state` (`<workflowId>::<nodeId>::<key>`).
Details: [Scheduling and Timers](Scheduling-and-Timers.md),
[ARCHITECTURE: Surviving the background worker sleeping](../ARCHITECTURE.md#surviving-the-background-worker-sleeping).

### Cancellation

- `isCancelled(runId)` (the Stop button, from the background's cancel set) is checked before every step
  and before each retry. A cancelled run ends `cancelled` with `"Stopped by the user."`.
- A child runner's `isCancelled` also returns true when the parent run is cancelled.
- `stop()` sets `stopped`: `runStep`, `emitFrom` and `handleTimer` then do nothing on that runner.
  Any public entry (`runOnce`, `runAsCall`, `handleEvent`) resets `stopped` to false.
- Cancellation is cooperative: the step currently running is not interrupted.

### Gotchas

- **A timed-out attempt is fenced off, not killed.** JavaScript cannot interrupt the block's promise, so
  `withTimeout` races it and, on timeout, sets the attempt's `fence.abandoned`. From then on its
  `ctx.emit`, `ctx.callWorkflow` and soft failures are refused, its late rejection is swallowed, and
  `ctx.aborted()` returns true so long-running blocks (Timer's inline wait, loops) can stop early. The
  next retry starts with a fresh fence.
- A step whose run was stopped while it ran is recorded `skipped` and the run `cancelled`; `runStep`
  returns early when the run is no longer `running`.
- Config is resolved once per step, before retries.
- Start/timer contexts (`start`, `onTimer`) have no run: `softFail` only logs, `callWorkflow` throws,
  `emit` starts a new run.
- `secretValues` lives on the runner and is replaced by each run's `inRun`.
- Only `MAX_STEPS_KEPT` (300) steps are stored per run; the rest increment `droppedSteps`.

## Run records (`runs.ts`)

| Export | Meaning |
| --- | --- |
| `RunTrigger` | `manual` / `start` / `timer` / `call` / `event`. |
| `RunStatus` | `running` / `passed` / `failed` / `cancelled` / `interrupted`. |
| `StepStatus` | `running` / `passed` / `failed` / `handled` (failed but dealt with) / `skipped`. |
| `StepRecord` | `nodeId, blockType, status, startedAt, durationMs?, attempts, input?, output?, port?, error?, code?, locator?, url?, matches?, sourceId?, screenshot?, childRunId?`. `code` (an `ErrorCode`) is set whenever `error` is; `locator`, `url` and `matches` (up to 5 element descriptions, strict-mode errors) when the error had them. `sourceId` is the node's `origin` (its id in the imported file), so a report maps back to the script. |
| `RunRecord` | `id, workflowId, workflowName, trigger, status, startedAt, endedAt?, steps, droppedSteps?, error?, parentRunId?`. |
| `RunObserver` | `(run) => void`; receives a fresh copy after every change. |
| `MAX_STEPS_KEPT` | 300. |
| `compactPayload(p)` | Payloads over 3000 JSON chars become `{ $preview, $size }`; unserialisable ones `{ $preview: '[not serialisable]' }`. |
| `markInterrupted(runs, liveIds, now)` | Runs still `running` and not in `liveIds` become `interrupted`, their running steps `failed`. Called on worker start. |
| `maskText(text, secrets)` | Replaces each secret (length ≥ 3) with `•••`. |
| `maskPayload(value, secrets)` | Same over JSON, matching JSON-escaped secrets. |

## Error codes (`errors.ts`)

| Export | Meaning |
| --- | --- |
| `ERROR_CODES` | Code → `{ meaning, fix }`. The source of the usage guide's table and of `$defs/errorCode` in `docs/guide/report.schema.json`. |
| `ErrorCode`, `ERROR_CODE_LIST` | The codes as a type and as a list. |
| `CodedError(code, message, { locator?, url?, matches? })` | Throw it from blocks and the host. Message unchanged; the details go on the step record. |
| `errorDetails(error)` | `ErrorDetails` of any thrown value (duck-typed on `code`), `step.failed` when it has none. |
| `isErrorCode(value)` | Type guard. |

Codes: `locator.not-found`, `locator.strict`, `locator.invalid`, `element.not-visible`, `element.disabled`,
`element.not-editable`, `element.covered`, `element.unstable`, `element.wrong-type`, `option.not-found`,
`timeout`, `assert.failed`, `http.status`, `http.network`, `navigation.failed`, `tab.missing`, `tab.closed`,
`frame.unreachable`, `page.restricted`, `permission.missing`, `script.error`, `config.invalid`,
`workflow.failed`, `step.failed`. Who throws which: [Page Protocol](Page-Protocol.md#error-codes) for
page ops; blocks and host: Assert `assert.failed`, HTTP Request `http.status` / `http.network`, Run Script
`script.error`, Open Tab / Navigate / HTTP Request with a bad URL `config.invalid`, `requireSessionTab`
`tab.missing`, page loads `navigation.failed`, the debugger and userScripts permissions
`permission.missing`, URL / response / popup / network-idle waits `timeout`.

Adding a code: add it to `ERROR_CODES` (meaning and fix), run `npm run guide:sync` (the report schema
lists the codes), add a row to the guide's error-code table and to [Troubleshooting](Troubleshooting.md).

The background stores records in `bf:runs` ([Storage Keys](Storage-Keys.md)); the editor reads them for
block colours, the step inspector and reports ([Core Modules: report](Core-Modules.md#report)).

## Ports (`ports.ts`)

| Export | Notes |
| --- | --- |
| `DEFAULT_PORT = 'out'`, `ERROR_PORT = 'error'` | |
| `class Routed { port; payload }`, `routeTo(port, payload)` | Returned from `run` to choose an output. |
| `declaredPorts(def, config?)` | The block's own outputs: `def.ports`, or `def.ports(config)` with defaults filled in for dynamic ports; de-duplicated, empty names and `error` dropped, `['out']` when none (or when the function throws). |
| `nodePorts(def, node)` | `declaredPorts(def, node.config)` plus `error` when `node.step.onError === 'port'`. Pass the node's `config` (a `NodeDef` already has it); without it a dynamic block shows its default config's ports. |
| `hasDynamicPorts(def)` | `def.ports` is a function (the editor re-wires edges on setting changes, the script schema allows any branch key). |
| `edgePort(edge, ports)` | `edge.sourcePort ?? 'out'`; a legacy `out` on a block without `out` maps to its first port. |

Used by the engine, `validate.ts`, `check.ts`, `script.ts`, `layout.ts`, `playwright.ts`, `scripts/guide.ts`,
`scripts/scriptSchema.ts` and the editor (`BlockNode`, `Editor.tsx`'s `portOfEdge` and `updateConfig`).

**Dynamic ports and dead edges.** An edge whose port a block no longer has never runs; the engine skips
it, `validate.ts` warns ("The "x" output is not in use"), `check.ts` refuses it on import
(`edge.port.unknown`, did-you-mean over the node's real ports). The editor keeps them from appearing:
`updateConfig` calls `followPortChanges` (`flow/convert.ts`) with the outputs before and after a change,
so when one output disappears and one appears (a case renamed) its edges move to the new name, and edges
from outputs that disappear otherwise (a case removed) are deleted. Switch gives a nameless, invalid or
repeated case a stand-in output `case<N>` so that typing a name over an old one is a chain of renames.

## Session tabs (`session.ts`)

A run's tabs live in the payload as `$session: { tabs: { [name]: tabId } }`, so they survive timers and
worker restarts. A blank name means `main`.

| Export | Notes |
| --- | --- |
| `SESSION_KEY = '$session'`, `DEFAULT_TAB = 'main'` | |
| `sessionTab(payload, name)` | Tab id or `undefined`. |
| `requireSessionTab(payload, name)` | Throws "No tab named … Put an Open Tab block …". Every page block uses this. |
| `withSessionTab(payload, name, tabId)` / `withoutSessionTab(payload, name)` | Return copies; used by Open Tab, Close Tab, Wait For Popup and by the background for event triggers (`main`). |

## Workflow helpers (`workflow.ts`)

| Export | Notes |
| --- | --- |
| `createWorkflow(name?)` | Empty, disabled, fresh id. |
| `uid` | Re-export of `id.ts`. |
| `rootSignature(workflow)` | JSON of the start blocks (nothing feeds them), sorted by id: `id, type, config, step`. Only these hold schedules and listeners; other blocks are read from storage when a run reaches them, so editing them needs no restart. |
| `diffWorkflows(previous, next)` | `{ start, restart, stop, removed }`: start = newly enabled (plain start blocks run); restart = enabled and `rootSignature` changed (triggers re-armed, plain start blocks not run); stop = disabled or deleted while enabled; removed = deleted (state and timers cleared). Drives the background's `storage.onChanged` handler ([Background Worker](Background-Worker.md)), which migrates both sides first ([Core Modules: migrate](Core-Modules.md#migrate)). |

## Validation (`validate.ts`)

`validateWorkflow(workflow, registry): Issue[]` with `Issue = { level: 'error' | 'warning', nodeId?, edgeId?, message }`.
Used by the editor to flag problems; never blocks a run.

| Check | Level |
| --- | --- |
| Empty workflow | warning (and stops) |
| Duplicate node id, unknown block type | error |
| Settings invalid in `design` mode (`validateConfig`) | error |
| Edge to a missing block, self-connection | error |
| Edge from a port the node does not have | warning |
| Duplicate connection (same source, port, target) | warning |
| Edge into a block without `run` | error |
| No root at all | error |
| Node unreachable from any root | warning |
| Any cycle | warning (run stops after 1000 steps) |

## Registry (`registry.ts`)

`BlockRegistry`: `register(def)` (throws on duplicate type, chainable), `get(type)`, `has(type)`, `list()`
(registration order). The single instance is built by `createRegistry()` in `src/core/blocks/index.ts`.

## Timer keys (`timerKey.ts`)

| Export | Result |
| --- | --- |
| `makeTimerKey(workflowId, nodeId, name)` | `bf::<workflowId>::<nodeId>::<name>` |
| `workflowTimerPrefix(workflowId)` | `bf::<workflowId>::` |
| `parseTimerKey(key)` | `{ workflowId, nodeId, name } \| null`; the name may contain `::`. |
| `stateKey(workflowId, nodeId, key)` | `<workflowId>::<nodeId>::<key>` (no `bf` prefix; the host adds its own storage prefix). |

## Ids (`id.ts`)

`uid()`: UUID v4 via `crypto.randomUUID`, falling back to `getRandomValues` where `randomUUID` is missing
(it only exists in secure contexts), so ids never fail to generate.

## See also

- [Core Modules](Core-Modules.md): config, templates, expressions and the other helpers the engine uses
- [Page Protocol](Page-Protocol.md): what `Host.page.act` carries
- [Block Internals](Block-Internals.md), [Adding a Block](Adding-a-Block.md)
- [Background Worker](Background-Worker.md): who creates runners and stores runs
- [Scheduling and Timers](Scheduling-and-Timers.md), [Storage Keys](Storage-Keys.md)
- [Browser Host](Browser-Host.md), [Testing](Testing.md)
- [ARCHITECTURE.md](../ARCHITECTURE.md)
