# MCP Server

`blockflow-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio. An AI
tool (Claude Code, Claude Desktop, any MCP client) uses it to write, validate, run and repair BlockFlow
workflows **in the user's real browser**, with their logins. It talks to the extension through the bridge:
the local socket served by the native host (`packages/bridge`), which relays to the extension over
native messaging. Read this to set it up, to see what each tool returns, or to change the server.

**Source:** [server.mjs](../../packages/mcp/server.mjs) (bin), [index.mjs](../../packages/mcp/index.mjs)
(tools, resources, prompt), [bridgeSession.mjs](../../packages/mcp/bridgeSession.mjs) (connection, errors),
[format.mjs](../../packages/mcp/format.mjs) (run and issue text), [resources.mjs](../../packages/mcp/resources.mjs),
[scripts/pack.mjs](../../packages/mcp/scripts/pack.mjs). Protocol: [bridgeProtocol.ts](../../src/core/bridgeProtocol.ts),
client: [client.mjs](../../packages/bridge/client.mjs). Tests: [tests/mcp](../../tests/mcp).

## Setup

1. The browser is open with BlockFlow, and **Settings → Allow outside control** is on (off by default).
2. The native host is installed for this browser: `npx blockflow-bridge install --extension-id <id>`
   (the Settings page shows the exact command with this browser's extension id).
3. The MCP client starts the server. Claude Code:

   ```bash
   claude mcp add blockflow -- npx -y blockflow-mcp
   ```

   or a project `.mcp.json`, and the same block in Claude Desktop's `claude_desktop_config.json`:

   ```json
   {
     "mcpServers": {
       "blockflow": { "command": "npx", "args": ["-y", "blockflow-mcp"] }
     }
   }
   ```

   From a checkout (before the package is published), use `"command": "node", "args": ["/path/to/blockflow/packages/mcp/server.mjs"]`.

The server starts without the browser: it connects to the bridge on the **first tool call**, so listing
tools, reading resources and getting the prompt always work. `BLOCKFLOW_SOCKET` and `BLOCKFLOW_TOKEN_FILE`
in the server's environment override the default socket and token paths (the same variables the native
host reads; see the paths comment in `bridgeProtocol.ts`). `node server.mjs --version` prints the version.
stdout is the MCP channel; the server logs to stderr only.

## Tools

Every tool returns text first (what a model reads), and `structuredContent` with the same data as JSON.
Every failure, including "browser not reachable", is a result with `isError: true` and a readable message;
the server never crashes on a bridge error.

| Tool | Input | Bridge method | Returns |
| --- | --- | --- | --- |
| `list_workflows` | none | `list` | one line per workflow: id, name, on/off, "via bridge" |
| `validate_workflow` | `source` | `validate` | `Valid: …` or `INVALID`, then each issue as `<level> <code> at <path>: <message> <hint>`; `{ok, issues, workflows}` |
| `import_workflow` | `source`, `replace?` | `import` | the new workflow ids (imported off, tagged via bridge); `isError` when nothing was imported |
| `run_workflow` | `workflowId` or `source`, `secrets?`, `timeoutSeconds?`, `screenshot?` | `run` | the run summary (below), step outputs, the failure screenshot as image content |
| `get_report` | `format?` (json, junit, html), `runIds?`, `workflowId?`, `limit?` | `report` | the report text |
| `snapshot_page` | `url` or `tabId` | `snapshot` | the page outline (`role "name" [state] [ref] locator=…`) |
| `stop_run` | `runId` | `stop` | stopping / was not running |
| `list_suites` | none | `suite.list` | one line per suite |
| `run_suite` | `suiteId`, `name` or `suite` (inline), `secrets?`, `formats?` | `suite.run` | suite verdict, one line per workflow with its failing step, the requested reports |

`source` is a script, a graph file or one workflow, as a JSON object or as JSON text (passed to the
extension unchanged, so issue paths match what the model wrote). Inputs are zod schemas; the descriptions
are written for a model (what to pass, what comes back, how to repair).

### The run summary

The first text block of `run_workflow` is compact and ordered for repair:

```text
Run FAILED in 31.2 s: "Login test" (run r-12, workflow wf-3)
Failing step: landed (click)
Error code: locator.not-found
Message: No element matches role=button[name="Sign in"]
Locator: role=button[name="Sign in"]
Page URL: https://example.com/login
Steps:
- s1 open-url ok 1.2 s
- landed click FAILED 30.0 s locator.not-found No element matches …
Next: look up locator.not-found in the guide's error-code table (resource blockflow://guide), fix step "landed" …
```

The failing step is the last step with status `failed` (handled failures do not stop a run); its id is
`StepRecord.sourceId` (the step `id` in the script, else `s<N>`), falling back to `nodeId`. `Matches` (for
`locator.strict`) and the last console lines follow when present. A second text block lists step outputs
(cut at 4,000 characters; all of them are in `structuredContent.steps`). When the failing step has a
`screenshot`, the server fetches `screenshot:<id>` with `blob.get` and adds it as `image` content; if that
fails the summary says so and the tool still succeeds.

### Large results and progress

- A result that came back as a `BlobRef` (`{blobId, size}`, anything over `INLINE_RESULT_BYTES`) is read
  with repeated `blob.get` calls (base64 chunks, next `offset` = chunk offset + decoded bytes, until
  `done`), joined and parsed as JSON. Screenshots are read the same way, keeping the bytes.
- When the tool call carries a `progressToken`, `run.started` and every `run.step` (and `suite.progress`
  for suites, with `total`) become `notifications/progress` with a short message
  (`landed click failed locator.not-found`). Clients that time out long calls should reset the timeout
  on progress (the SDK's `resetTimeoutOnProgress`).
- Cancelling a `run_workflow` call (the client's abort) sends `stop` for its run.

### Bridge connection

`createBridgeSession(connect)` opens one connection lazily and shares it between calls. It reconnects
before a call when the client's `closed` promise has settled, retries a failed connect once, and on a
dropped connection (an error without a numeric code, or `notConnected` with the socket closed) reconnects
and retries **once** for calls that are safe to repeat (`list`, `validate`, `report`, `snapshot`,
`blob.get`, `suite.list`, `stop`, `hello`). `run`, `suite.run` and `import` are not repeated: the message
says the run may still be going in the browser. `notConnected` answered by the host over a live socket
(the extension is not connected) is not retried. `describeError` adds a hint for `disabled`,
`notConnected`, `unauthorized`, `version` and `tooLarge`; `invalidWorkflow` with `data.issues` becomes the
issue list.

Bridge-call timeouts: `run` waits `timeoutSeconds + 60 s` (30 minutes without one), `suite.run` 4 hours,
`snapshot` 2 minutes, everything else the client's default (120 s).

## Resources

| URI | File (repo) |
| --- | --- |
| `blockflow://guide` | [docs/guide/README.md](../guide/README.md) |
| `blockflow://blocks` | [docs/guide/blocks.md](../guide/blocks.md) |
| `blockflow://script-schema` | [docs/guide/script.schema.json](../guide/script.schema.json) |
| `blockflow://llms.txt` | [llms.txt](../../llms.txt) |

Each is read when requested: from `packages/mcp/resources/<file>` when it exists (the published
package), else from the repo. `npm pack` runs `prepack` (`node scripts/pack.mjs copy`) to copy them into
`resources/` and `postpack` to delete the copies again, so a checkout never serves stale ones
(`resources/` is git-ignored).

## Prompt: `write-and-repair-test`

Arguments `url` and `goal`. It tells the model to read the guide and block reference, then loop:
**snapshot_page → write the script → validate_workflow (fix every issue at its path) → run_workflow →
read the failing step (code, message, locator, URL, screenshot) → fix that step → validate and run again**,
stopping after 5 failed runs, and answer with the final script and the secrets to create. The server's
MCP `instructions` say the same in four lines.

## Tests

`npx vitest run tests/mcp`:

- `server.test.ts`: the server built with a fake bridge client (`tests/mcp/fakeBridge.ts`, implements
  `{call, close}`) and the SDK `Client` over `InMemoryTransport`: tool list and schemas, each tool,
  invalid workflows, failed run with summary and image, BlobRef reassembly, progress, error and reconnect
  rules, resources (and the packaged copy winning), the prompt.
- `stdio.test.ts`: spawns `server.mjs` with `StdioClientTransport` and `BLOCKFLOW_SOCKET` pointing at
  nothing (tools list; a call returns the "not reachable" message), and drives the real
  `blockflow-bridge` client against a tiny fake socket host (NDJSON, `auth` first, notifications by
  `requestId`, a wrong token).

## Troubleshooting

| Message | Cause | Fix |
| --- | --- | --- |
| `BlockFlow is not reachable: …` | No socket: browser closed, outside control off, or the host is not installed for this browser. | Open the browser, switch on Allow outside control, run `npx blockflow-bridge install --extension-id <id>`. |
| `… switch on "Allow outside control"` | The host runs but the extension is not connected, or the switch is off. | Settings → Allow outside control. |
| `… token did not match` | The token file differs between the host and the server. | Check `BLOCKFLOW_TOKEN_FILE` is the same for both (or unset), restart the browser. |
| `… different protocol versions` | Old package or old extension. | Update both. |
| A long run times out in the client | The MCP client's request timeout. | Raise it, or enable reset-on-progress; pass `timeoutSeconds`. |

See also [Workflows as Scripts](Workflows-as-Scripts.md) and [Tooling and Scripts](Tooling-and-Scripts.md).
