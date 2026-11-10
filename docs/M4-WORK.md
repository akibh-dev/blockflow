# M4 parallel implementation contract

Base: branch `m4-outside-access` from `main` after M3 (#6). Read CLAUDE.md, the M4 section of
docs/IMPLEMENTATION.md (M4.1–M4.4, decision §8.3 in docs/PLAN.md) and **`src/core/bridgeProtocol.ts`**
(the protocol: methods, params, results, notifications, error codes, limits, storage keys, socket/token paths).
No commits by agents. No UI redesign. `src/core` stays free of browser and Node APIs.

## Shared decisions (root owns; ask root before changing)

- Transport: client ⇄ native host over a local socket, **newline-delimited JSON** (one JSON-RPC message per
  line, ≤ `MAX_MESSAGE_BYTES`). The first client message must be `auth` `{token, protocol}`; anything else
  first → `unauthorized` error and close. Host ⇄ extension: standard native messaging framing (4-byte
  little-endian length + UTF-8 JSON). The host forwards every non-`auth` request to the extension,
  rewriting ids so concurrent clients never collide, and routes responses and `run.*` / `suite.progress`
  notifications (by `requestId`) back to the client that sent the request. `bridge.disabled` → host closes all
  clients. Extension not connected → `notConnected`.
- Packages are plain ESM `.mjs` with JSDoc types (like `tests/e2e`, `scripts/`), Node ≥ 20, npm workspaces
  (`packages/*`, already installed: `@modelcontextprotocol/sdk` 1.32, `zod` 4, `playwright-core`). Constants
  come from `packages/bridge/protocol.mjs` (mirror of the TS file). **Do not run `npm install`** or edit the
  root package.json/lockfile; ask root for dependencies or scripts.
- Tests: vitest picks up `tests/**/*.test.ts` (Node env). Node packages are tested from TS test files that
  import the `.mjs` modules (`tests/bridge`, `tests/mcp`, `tests/cli`).
- Extension builds for your own checks: `BF_OUT_DIR=.output-<you> BF_E2E=1 npx wxt build` (or `BF_AUTOMATION=1`),
  never the default folders while others work. e2e against your build: `BF_EXTENSION_DIR=.output-<you>/chrome-mv3
  node tests/e2e/run.mjs <spec>`. The harness (`tests/e2e/harness.mjs`, root-owned) now exposes `profile` and
  `bridge: {socket, tokenFile, hostsDir}`: the browser process gets `BLOCKFLOW_SOCKET` / `BLOCKFLOW_TOKEN_FILE`
  pointing inside the throwaway profile, and Chromium reads host manifests from `<profile>/NativeMessagingHosts`.
- Builds: `BF_AUTOMATION=1` → `.output-automation` (all optional permissions incl. `nativeMessaging` granted, no
  test hooks) is what the CLI loads. `nativeMessaging` is an optional permission otherwise (PermissionNote text done).
- Storage keys (added to `src/shared/keys.ts`): `bf:settings` `{outsideControl}`, `bf:bridge-log`, `bf:suites`.
  `Workflow.importedVia?: 'bridge'` exists in `src/core/types.ts`.
- Docs: each agent writes or updates the wiki page(s) for its own files (new pages are fine; root adds them to
  `_Sidebar.md`/`Home.md`). `npm run wiki:check` must pass. Root writes the learning lesson, guide, plans/status.
- Report exactly which commands you ran and what passed; never mark a browser check verified that you did not run.

## Exclusive ownership and interfaces

1. **Native host** — `packages/bridge/**` (protocol.mjs: append only, tell root), `tests/bridge/**`, wiki `Bridge.md`.
   - `paths.mjs`: `socketPath(env?)`, `tokenFile(env?)`, `readOrCreateToken(file)` (0600).
   - `framing.mjs`: native message encode/decode (stream parser, size limit); NDJSON line splitter.
   - `host.mjs` / `index.mjs` `runHost({stdin, stdout, env})`: the relay described above; exits and removes the
     socket when stdin ends; a socket already served by a live host → write a clear stderr line, send the
     extension a notification-free close (exit code 3). Logs to stderr only (stdout is the native channel).
   - `client.mjs`: `connectBridge({socketPath?, tokenFile?, client?, timeoutMs?}) → {call(method, params, {onNotification, timeoutMs}), close()}`.
     Errors are `BridgeError` with `.code` (RPC code) and `.data`; ENOENT/ECONNREFUSED → a readable "BlockFlow is
     not reachable: is the browser open with Allow outside control on, and the bridge installed?".
   - `install.mjs` `installHost({extensionIds, firefox?, dirs?, hostScript?})` / `uninstallHost`: writes a launcher
     (sh on unix using the current `process.execPath`, `.cmd` + registry key on Windows) and `dev.akibh.blockflow.json`
     for Chrome, Chromium, Brave, Edge (allowed_origins `chrome-extension://<id>/`) and Firefox
     (allowed_extensions `blockflow@akibh-dev`) on Linux/macOS/Windows; `dirs` overrides targets (CLI/e2e).
     `chromiumExtensionId(absPath)` computes an unpacked extension's id.
   - `cli.mjs`: `blockflow-bridge install --extension-id <id> [--browser chrome|chromium|brave|edge|firefox|all] [--dir d]`,
     `uninstall`, `status` (manifests found, socket reachable), `host` (what the launcher runs).
2. **Extension side** — `src/browser/bridge.ts`, `src/browser/bridgeHandlers.ts` (any `src/browser/bridge*.ts`),
   `src/entrypoints/editor/components/SettingsPage.tsx`, `src/entrypoints/background.ts` (bridge wiring; root adds
   the suite message case later), `src/shared/messages.ts` (append), `src/core/check.ts` only to accept
   `importedVia`, `tests/browser/bridge*.test.ts`, `tests/e2e/specs/m4-bridge.mjs`, wiki: Browser-Host,
   Background-Worker, Message-Protocol, Storage-Keys sections for these.
   - Switch on → request `nativeMessaging` (if optional) → save `bf:settings` → worker `connectNative(NATIVE_HOST_NAME)`;
     keep the port open while on (it keeps the MV3 worker alive); reconnect with backoff on disconnect while on;
     switch off → send `bridge.disabled`, disconnect. Listeners registered synchronously at worker start.
   - Serve every method in `BridgeParams` except `auth`. `validate` uses the M1 checker/compiler; `import` tags
     `importedVia: 'bridge'`; `run` streams `run.started`/`run.step`, overlays `secrets` for that run only, honours
     `timeoutSeconds`, resolves with the finished `RunRecord`; `stop`; `report` uses `src/core/report.ts`; `snapshot`
     reuses the M1.3 snapshot; results > `INLINE_RESULT_BYTES` and screenshots go through `blob.get`.
     `suite.list` / `suite.run` call agent 5's `src/browser/suites.ts` (interface below).
   - Every request appended to `bf:bridge-log` (method, ok, short detail, never secrets/payloads).
   - Settings page: the switch, connection status, this browser's extension id and the exact install command
     (`npx blockflow-bridge install --extension-id <id>`), the recent bridge log. Root adds it to the editor nav
     (`Editor.tsx`): export `SettingsPage` with no props.
3. **MCP server** — `packages/mcp/**`, `tests/mcp/**`, wiki `MCP-Server.md`.
   - stdio server with `@modelcontextprotocol/sdk`, talking to the bridge with `blockflow-bridge/client`.
   - Tools: `list_workflows`, `validate_workflow` (script or graph → issues), `import_workflow`, `run_workflow`
     (inline script or id, optional secrets; returns status, failing step, code, message, locator, URL and the
     failure screenshot as MCP image content via `blob.get screenshot:<id>`), `get_report`, `snapshot_page`,
     `stop_run`, `list_suites`, `run_suite`. Progress notifications from `run.step` where the client supports them.
   - Resources: the usage guide (`docs/guide/README.md`), block reference (`docs/guide/blocks.md`), script schema
     (`docs/guide/script.schema.json`), `llms.txt`; resolve from the repo, and make the package self-contained for
     publishing (a `prepack` copy step is fine). Prompt: "write and repair a BlockFlow test".
   - Tests with an in-process fake bridge (socket server speaking the protocol) and the SDK's client.
4. **CLI** — `packages/cli/**`, `tests/cli/**`, wiki `CLI.md`.
   - `blockflow run <file|dir>... [--suite <name|file>] [--report junit|json|html]... [--out dir] [--headed]
     [--browser path] [--extension dir] [--timeout s] [--secret name=value]...`
   - Finds Chromium (same candidates as the e2e harness), loads `.output-automation/chrome-mv3` by default (clear
     error with the build command when missing), throwaway profile, `installHost({dirs:[<profile>/NativeMessagingHosts], extensionIds:[chromiumExtensionId(ext)]})`,
     private `BLOCKFLOW_SOCKET`/`BLOCKFLOW_TOKEN_FILE` in the browser env, launches with `playwright-core`, sets
     `bf:settings.outsideControl = true` through the service worker, waits for the socket, then runs everything
     as one inline `suite.run` (`formats` from `--report`), writes reports to `--out` (default `blockflow-report/`),
     prints a summary, exits 0 all passed / 1 any failed / 2 usage or infrastructure error.
   - Secrets: `BLOCKFLOW_SECRET_<NAME>` → secret `NAME` and its lowerCamel form (`API_TOKEN` → `apiToken`); `--secret` wins.
5. **Suites** — `src/core/suite.ts`, `src/core/report.ts` (suite reports), `scripts/reportSchema.ts` + generated
   schema if needed, `src/browser/suites.ts`, `src/entrypoints/editor/components/SuitesPage.tsx`,
   `src/shared/messages.ts` (append a `bf:run-suite` message), `tests/core/suite*.test.ts`, `tests/browser/suites.test.ts`,
   wiki: Editor-Components / Core-Modules sections.
   - `src/core/suite.ts`: validate a `Suite`/`SuiteInput`, overall status, `skipped`.
   - `src/core/report.ts`: `toSuiteJUnit(result, options)` (one `<testsuite>`, one `<testcase>` per workflow, failure =
     failing step code/message), `toSuiteHtml(result, options)` (one section per workflow), `toSuiteJson(result)`.
   - `src/browser/suites.ts`: `loadSuites()`, `saveSuites()`, and
     `runSuite(input: { suite: Suite | SuiteInput; secrets?: Record<string,string>; formats?: ('json'|'junit'|'html')[] },
     deps: { loadWorkflows(): Promise<Workflow[]>; runWorkflow(wf: Workflow, opts: { secrets?: Record<string,string> }): Promise<RunRecord>; onProgress?(p: {index,total,workflowName,status}): void })
     : Promise<{ result: SuiteResult; reports?: Partial<Record<'json'|'junit'|'html', string>> }>`
     (inline `sources` are compiled with the M1 compiler; invalid ones fail the suite before running anything).
   - Editor page `SuitesPage` (no props): create/rename/delete, pick and order workflows, stopOnFailure, Run (sends
     `bf:run-suite`), the last result with JUnit/HTML/JSON downloads. Root wires the nav and the background case.

Root integrates: Editor nav, background suite case, package.json scripts (`bridge`, `mcp`, `blockflow`, e2e),
CI workflow, cross-package e2e (MCP → bridge → extension against the fixture site, CLI on the guide examples),
docs/learning lesson, guide, IMPLEMENTATION/PLAN status, version.
