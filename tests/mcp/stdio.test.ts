// The real server.mjs over stdio (spawned with the SDK's StdioClientTransport), and the real
// blockflow-bridge client against a tiny fake host speaking the socket protocol (NDJSON, auth first).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBlockflowServer, defaultConnector } from '../../packages/mcp/index.mjs';
import { failedRun } from './fakeBridge';

const dir = mkdtempSync(path.join(os.tmpdir(), 'bf-mcp-stdio-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const serverScript = path.resolve(__dirname, '../../packages/mcp/server.mjs');
const textOf = (result: any) => (result.content as { type: string; text?: string }[]).filter((part) => part.type === 'text').map((part) => part.text).join('\n');

describe('server.mjs over stdio', () => {
  it('lists tools, and a tool call with no bridge returns the readable error', async () => {
    const tokenFile = path.join(dir, 'token');
    writeFileSync(tokenFile, 'a'.repeat(64));
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverScript],
      env: { ...env, BLOCKFLOW_SOCKET: path.join(dir, 'nothing-here.sock'), BLOCKFLOW_TOKEN_FILE: tokenFile },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(9);
      const { resources } = await client.listResources();
      expect(resources).toHaveLength(4);
      const result: any = await client.callTool({ name: 'list_workflows', arguments: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('BlockFlow is not reachable: is the browser open with Allow outside control on, and the bridge installed?');
      // Still alive after the failure.
      expect((await client.listTools()).tools).toHaveLength(9);
    } finally {
      await client.close();
    }
  }, 20_000);
});

/** A fake native host: unix socket, NDJSON, `auth` first, answers from `answer`. */
async function fakeHost(token: string, answer: (message: any, send: (m: unknown) => void) => void) {
  const socketPath = path.join(dir, `host-${Math.random().toString(36).slice(2)}.sock`);
  const seen: any[] = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let authed = false;
    const send = (message: unknown) => socket.write(`${JSON.stringify(message)}\n`);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        seen.push(message);
        if (!authed) {
          if (message.method !== 'auth' || message.params?.token !== token) {
            send({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32001, message: 'unauthorized' } });
            socket.end();
            return;
          }
          authed = true;
          send({ jsonrpc: '2.0', id: message.id, result: { ok: true, extensionConnected: true } });
          continue;
        }
        answer(message, send);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe('the real bridge client against a fake socket host', () => {
  it('authenticates, streams run.step as progress, and fetches the screenshot with blob.get', async () => {
    const token = 'b'.repeat(64);
    const tokenFile = path.join(dir, 'token-real');
    writeFileSync(tokenFile, token);
    const png = Buffer.from('fake png bytes');
    const host = await fakeHost(token, (message, send) => {
      if (message.method === 'run') {
        send({ jsonrpc: '2.0', method: 'run.started', params: { requestId: message.id, runId: failedRun.id, workflowName: failedRun.workflowName } });
        for (const step of failedRun.steps) send({ jsonrpc: '2.0', method: 'run.step', params: { requestId: message.id, runId: failedRun.id, step } });
        send({ jsonrpc: '2.0', id: message.id, result: { run: failedRun } });
      } else if (message.method === 'blob.get') {
        send({ jsonrpc: '2.0', id: message.id, result: { data: png.toString('base64'), offset: 0, size: png.length, done: true, mime: 'image/png' } });
      } else {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `no ${message.method}` } });
      }
    });
    const app = createBlockflowServer({ connect: defaultConnector({ socketPath: host.socketPath, tokenFile }) });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'socket-test', version: '0' });
    await app.server.connect(serverSide);
    await client.connect(clientSide);
    try {
      const progress: string[] = [];
      const result: any = await client.callTool({ name: 'run_workflow', arguments: { workflowId: 'wf-1' } }, undefined, { onprogress: (p) => progress.push(p.message ?? '') });
      expect(host.seen[0]).toMatchObject({ method: 'auth', params: { token, protocol: 1, client: 'blockflow-mcp' } });
      expect(textOf(result)).toContain('Failing step: landed (click)');
      expect(progress).toEqual(['started "Login test" (run run-2)', 's1 open-url passed', 'landed click failed locator.not-found']);
      const image = result.content.find((part: any) => part.type === 'image');
      expect(Buffer.from(image.data, 'base64').equals(png)).toBe(true);
      expect(host.seen.find((m) => m.method === 'blob.get').params).toEqual({ blobId: 'screenshot:shot-1', offset: 0 });
      const unknown: any = await client.callTool({ name: 'list_workflows', arguments: {} });
      expect(unknown.isError).toBe(true);
      expect(textOf(unknown)).toBe('BlockFlow error: no list');
    } finally {
      await client.close();
      await app.close();
      await host.close();
    }
  });

  it('a wrong token comes back as an error result', async () => {
    const tokenFile = path.join(dir, 'token-wrong');
    writeFileSync(tokenFile, 'c'.repeat(64));
    const host = await fakeHost('d'.repeat(64), () => {});
    const app = createBlockflowServer({ connect: defaultConnector({ socketPath: host.socketPath, tokenFile }) });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'socket-test', version: '0' });
    await app.server.connect(serverSide);
    await client.connect(clientSide);
    try {
      const result: any = await client.callTool({ name: 'list_workflows', arguments: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('unauthorized');
      expect(textOf(result)).toContain('token did not match');
    } finally {
      await client.close();
      await app.close();
      await host.close();
    }
  });
});
