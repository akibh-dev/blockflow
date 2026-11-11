# blockflow-mcp

An [MCP](https://modelcontextprotocol.io) server for the [BlockFlow](https://github.com/akibh-dev/blockflow) browser extension. It lets an AI
assistant (Claude Code, Claude Desktop, any MCP client) look at pages, write BlockFlow workflows, validate them,
run them **in your own browser with your own logins**, read the failure and repair the workflow.

```text
MCP client ──stdio──▶ blockflow-mcp ──local socket──▶ blockflow-bridge ──native messaging──▶ BlockFlow extension
```

## Setup

1. Install the BlockFlow extension and open its **Settings** page: switch on **Allow outside control** and copy the
   extension id.
2. Install the native host once: `npx blockflow-bridge install --extension-id <id>` (add `--browser firefox` for
   Firefox).
3. Add the server to your MCP client:

   ```json
   { "mcpServers": { "blockflow": { "command": "npx", "args": ["-y", "blockflow-mcp"] } } }
   ```

   Claude Code: `claude mcp add blockflow -- npx -y blockflow-mcp`.

## Tools

| Tool | What it does |
| --- | --- |
| `snapshot_page` | Outline of a page (URL or open tab) with ready-to-use locators |
| `validate_workflow` | Checks a script or graph; issues come with a code, a JSON path and a hint |
| `run_workflow` | Runs an inline script or a saved workflow; returns status, the failing step, error code, locator, URL and a screenshot |
| `get_report` | JSON, JUnit or HTML report of runs |
| `import_workflow`, `list_workflows`, `stop_run`, `list_suites`, `run_suite` | Manage workflows and suites |

Resources: the usage guide, the block reference, the script JSON Schema and `llms.txt`. Prompt:
`write-and-repair-test` (snapshot → write → validate → run → repair).

Outside control is **off by default** and local only: nothing is reachable from the network. Every request is
listed on the extension's Settings page. Full documentation: [MCP Server wiki](https://github.com/akibh-dev/blockflow/wiki/MCP-Server).

License: MIT.
