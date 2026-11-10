#!/usr/bin/env node
// blockflow-mcp: the BlockFlow MCP server over stdio. MCP clients start it with `npx blockflow-mcp`.
// It connects to the BlockFlow bridge (local socket, BLOCKFLOW_SOCKET / BLOCKFLOW_TOKEN_FILE override the
// default paths) on the first tool call, not at startup, so it starts even while the browser is closed.
// stdout is the MCP channel: log to stderr only.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBlockflowServer, VERSION } from './index.mjs';

if (process.argv.includes('--version')) {
  console.log(VERSION);
  process.exit(0);
}

const app = createBlockflowServer();
const transport = new StdioServerTransport();

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close().catch(() => {});
  process.exit(0);
}
process.stdin.on('end', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (error) => console.error('blockflow-mcp: unhandled rejection:', error));

await app.server.connect(transport);
console.error(`blockflow-mcp ${VERSION} ready (stdio)`);
