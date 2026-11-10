# M3 parallel implementation contract

Base: `m3-network`, checkpoint `605203e`. Read CLAUDE.md, docs/PLAN.md and docs/IMPLEMENTATION.md.
Complete M3.1–M3.5; keep the engine free of browser/DOM APIs. No UI redesign. No commits by agents.

## Shared contracts (root owns these files)

- `src/core/network.ts`: RouteRule/Options/Result, HarLog/Result, ConsoleEntry, EmulateOptions,
  ClearSiteDataOptions. Changes needed here must be requested from root before assuming a new shape.
- Host additions root will provide: `network.route(tabId, RouteOptions): Promise<RouteResult>`,
  `network.har(tabId, 'start'|'stop'): Promise<HarResult>`,
  `network.console(tabId): Promise<ConsoleEntry[]>`,
  `environment.emulate(tabId, EmulateOptions): Promise<void>`,
  `environment.clearSiteData(ClearSiteDataOptions): Promise<void>`.
- Optional permissions root adds: `declarativeNetRequest`, `browsingData` alongside current permissions.
- `src/browser/m3Runtime.ts`: injected runtime uses the existing run-scoped CDP manager. Normal
  withTab rejects while closing; cleanupTab permits resetting an existing session during cleanup.
  subscribe uses the existing event multiplexer. Check isClosed in delayed callbacks.
- Mutable route/emulation changes must claim the tab before mutation. Root enforces ownership between
  concurrent runs, releases claims after all feature cleanup. Passive HAR/console may share sessions.
- Factories have no top-level dynamic browser listeners; subscriptions happen through runtime.
- Cleanup functions must be idempotent, unregister subscriptions, bound state, and reset overrides/rules.
  Root always calls every feature cleanup and then releases CDP in finally, including failed runs.
- Strict block validate hooks: reject malformed JSON, unsupported modes, invalid URLs/numbers instead
  of silently ignoring. Block metadata drives existing inspector; do not edit engine/editor for new blocks.
- Root owns registry/index.ts, host.ts, types.ts, engine.ts, runs.ts, report schema, FakeHost,
  wxt.config.ts, PermissionNote.tsx, generated guide files and milestone/status/docs integration.

## Exclusive ownership

1. Routing agent: blocks/route.ts, browser/routes.ts, tests/core/route.test.ts,
   tests/browser/routes.test.ts, tests/e2e/specs/m3-route.mjs, fixtures/site/m3-route.html.
   Export `createRoutes(runtime)` => `{apply(tabId, options), finish()}`.
2. Environment agent: blocks/emulate.ts, blocks/clearSiteData.ts, browser/environment.ts,
   tests/core/environment.test.ts, tests/browser/environment.test.ts,
   tests/e2e/specs/m3-environment.mjs, fixtures/site/geo.html.
   Export `createEnvironment(runtime)` => `{emulate(tabId, options), clearSiteData(options), finish()}`.
3. Capture agent: blocks/harRecord.ts, browser/telemetry.ts, blocks/assert.ts,
   core/report.ts, editor/components/ReportsPage.tsx, tests/browser/telemetry.test.ts,
   tests/core/telemetry.test.ts, tests/e2e/specs/m3-telemetry.mjs, fixtures/site/m3-telemetry.html.
   Export `createTelemetry(runtime)` => `{attach(tabId, send), har(tabId, action), console(tabId),
   beginStep(nodeId), finishStep(nodeId), finish()}`. attach receives a current CdpSend and must
   subscribe/enable Runtime through that sender without recursively calling withTab. Root calls attach
   before each feature/real-input CDP callback; it must deduplicate per tab. finishStep returns captured
   ConsoleEntry[] (bounded); root stores masked entries on StepRecord.console. Console assertion uses
   network.console and counts error-level entries in the current run. HAR is metadata only and bounded;
   do not collect auth headers, cookies, post bodies, or response bodies into reports by default.

## Verification and handoff

Use unit tests for meaningful failure/cleanup/concurrency cases and real browser specs for behavior.
Existing e2e harness uses fixture server; do not change shared server/harness without asking root.
Use actual fixture controls instead of external services. Root runs integrated checks/builds/e2e,
updates docs/learning and generated schemas, reviews combined diffs and closes M3 only after passing.
Agents report exact tested commands and any limitations; do not mark unexecuted browser checks verified.
