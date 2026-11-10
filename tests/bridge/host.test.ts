import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createNativeDecoder, encodeNative } from '../../packages/bridge/framing.mjs';
import { RPC_ERRORS } from '../../packages/bridge/protocol.mjs';
import { type Message, inbox, rawClient, startHost, tempDir } from './helpers';

const HOST = fileURLToPath(new URL('../../packages/bridge/host.mjs', import.meta.url));
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));
async function host(options?: Parameters<typeof startHost>[0]) {
  const h = await startHost(options);
  cleanups.push(h.cleanup);
  return h;
}

describe('native host: auth', () => {
  it('rejects a first message that is not auth, then closes', async () => {
    const h = await host();
    const c = rawClient(h.socket);
    c.send({ jsonrpc: '2.0', id: 1, method: 'list', params: {} });
    const reply = await c.messages.next();
    expect(reply).toMatchObject({ id: 1, error: { code: RPC_ERRORS.unauthorized } });
    await c.closed;
    expect(h.fromHost.items).toEqual([]);
  });

  it('rejects a wrong token, then closes', async () => {
    const h = await host();
    const c = rawClient(h.socket);
    expect(await c.auth('0'.repeat(64))).toMatchObject({ id: 'a', error: { code: RPC_ERRORS.unauthorized, message: 'Wrong token' } });
    await c.closed;
  });

  it('rejects non-JSON before auth and another protocol version', async () => {
    const h = await host();
    const c = rawClient(h.socket);
    c.sendRaw('hello\n');
    expect(await c.messages.next()).toMatchObject({ id: null, error: { code: RPC_ERRORS.parse } });
    await c.closed;
    const d = rawClient(h.socket);
    d.send({ jsonrpc: '2.0', id: 1, method: 'auth', params: { token: h.token, protocol: 99 } });
    expect(await d.messages.next()).toMatchObject({ error: { code: RPC_ERRORS.version, data: { protocol: 1 } } });
    await d.closed;
  });

  it('accepts the token and says whether the extension is connected', async () => {
    const h = await host();
    const c = rawClient(h.socket);
    expect(await c.auth(h.token)).toEqual({ jsonrpc: '2.0', id: 'a', result: { ok: true, extensionConnected: true } });
    c.socket.destroy();
  });

  it('closes a client that never authenticates', async () => {
    const h = await host({ authTimeoutMs: 50 });
    const c = rawClient(h.socket);
    await c.closed;
  });
});

describe('native host: relay', () => {
  it('rewrites ids so two clients can use the same ids, and routes responses and notifications back', async () => {
    const h = await host();
    const a = rawClient(h.socket);
    const b = rawClient(h.socket);
    await a.auth(h.token);
    await b.auth(h.token);
    a.send({ jsonrpc: '2.0', id: 1, method: 'run', params: { workflowId: 'A' } });
    b.send({ jsonrpc: '2.0', id: 1, method: 'suite.run', params: { name: 'B' } });
    const first = await h.fromHost.next();
    const second = await h.fromHost.next();
    expect(first.id).not.toBe(second.id);
    const fromA = first.params.workflowId === 'A' ? first : second;
    const fromB = fromA === first ? second : first;
    expect(fromA).toMatchObject({ jsonrpc: '2.0', method: 'run', params: { workflowId: 'A' } });
    expect(fromB).toMatchObject({ method: 'suite.run', params: { name: 'B' } });

    // Answer B first, with notifications interleaved.
    h.toHost({ jsonrpc: '2.0', method: 'run.started', params: { requestId: fromA.id, runId: 'ra', workflowName: 'A' } });
    h.toHost({ jsonrpc: '2.0', method: 'suite.progress', params: { requestId: fromB.id, index: 0, total: 1, workflowName: 'B', status: 'passed' } });
    h.toHost({ jsonrpc: '2.0', method: 'run.step', params: { requestId: fromA.id, runId: 'ra', step: { nodeId: 'n1' } } });
    h.toHost({ jsonrpc: '2.0', id: fromB.id, result: { result: { name: 'B' } } });
    h.toHost({ jsonrpc: '2.0', id: fromA.id, error: { code: RPC_ERRORS.notFound, message: 'No workflow A', data: { code: 'X' } } });

    expect(await a.messages.next()).toEqual({ jsonrpc: '2.0', method: 'run.started', params: { requestId: 1, runId: 'ra', workflowName: 'A' } });
    expect(await a.messages.next()).toMatchObject({ method: 'run.step', params: { requestId: 1, step: { nodeId: 'n1' } } });
    expect(await a.messages.next()).toEqual({ jsonrpc: '2.0', id: 1, error: { code: RPC_ERRORS.notFound, message: 'No workflow A', data: { code: 'X' } } });
    expect(await b.messages.next()).toMatchObject({ method: 'suite.progress', params: { requestId: 1, workflowName: 'B' } });
    expect(await b.messages.next()).toEqual({ jsonrpc: '2.0', id: 1, result: { result: { name: 'B' } } });
    expect(a.messages.items).toEqual([]);
    expect(b.messages.items).toEqual([]);
    a.socket.destroy();
    b.socket.destroy();
  });

  it('answers unknown methods and malformed requests itself', async () => {
    const h = await host();
    const c = rawClient(h.socket);
    await c.auth(h.token);
    c.send({ jsonrpc: '2.0', id: 2, method: 'rm -rf', params: {} });
    expect(await c.messages.next()).toMatchObject({ id: 2, error: { code: RPC_ERRORS.methodNotFound } });
    c.send({ id: 3, method: 'list' });
    expect(await c.messages.next()).toMatchObject({ id: 3, error: { code: RPC_ERRORS.invalidRequest } });
    c.sendRaw('{oops\n');
    expect(await c.messages.next()).toMatchObject({ id: null, error: { code: RPC_ERRORS.parse } });
    // Still usable; params default to {}.
    c.send({ jsonrpc: '2.0', id: 4, method: 'list' });
    expect(await h.fromHost.next()).toMatchObject({ method: 'list', params: {} });
    c.socket.destroy();
  });

  it('rejects a line over the size limit and closes', async () => {
    const h = await host();
    const c = rawClient(h.socket);
    await c.auth(h.token);
    c.sendRaw(`{"jsonrpc":"2.0","id":5,"method":"validate","params":{"source":"${'x'.repeat(1_000_001)}"}}\n`);
    expect(await c.messages.next()).toMatchObject({ error: { code: RPC_ERRORS.tooLarge } });
    await c.closed;
  });

  it('drops answers for a client that went away', async () => {
    const h = await host();
    const c = rawClient(h.socket);
    await c.auth(h.token);
    c.send({ jsonrpc: '2.0', id: 1, method: 'list', params: {} });
    const forwarded = await h.fromHost.next();
    c.socket.destroy();
    await c.closed;
    h.toHost({ jsonrpc: '2.0', id: forwarded.id, result: { workflows: [] } });
    const d = rawClient(h.socket);
    expect(await d.auth(h.token)).toMatchObject({ result: { ok: true } });
    d.socket.destroy();
  });

  it('bridge.disabled fails pending requests and closes every client', async () => {
    const h = await host();
    const a = rawClient(h.socket);
    const b = rawClient(h.socket);
    await a.auth(h.token);
    await b.auth(h.token);
    a.send({ jsonrpc: '2.0', id: 7, method: 'run', params: {} });
    await h.fromHost.next();
    h.toHost({ jsonrpc: '2.0', method: 'bridge.disabled', params: {} });
    expect(await a.messages.next()).toMatchObject({ id: 7, error: { code: RPC_ERRORS.disabled } });
    await Promise.all([a.closed, b.closed]);
    // A new client may still authenticate but cannot use it.
    const c = rawClient(h.socket);
    expect(await c.auth(h.token)).toMatchObject({ result: { extensionConnected: false } });
    c.send({ jsonrpc: '2.0', id: 1, method: 'list', params: {} });
    expect(await c.messages.next()).toMatchObject({ error: { code: RPC_ERRORS.disabled } });
    c.socket.destroy();
  });

  it('stdin end: pending requests fail with notConnected, the host exits and removes the socket', async () => {
    const h = await host();
    const c = rawClient(h.socket);
    await c.auth(h.token);
    c.send({ jsonrpc: '2.0', id: 9, method: 'run', params: {} });
    await h.fromHost.next();
    expect(existsSync(h.socket)).toBe(true);
    h.stdin.end();
    expect(await c.messages.next()).toMatchObject({ id: 9, error: { code: RPC_ERRORS.notConnected } });
    await c.closed;
    expect(await h.done).toBe(0);
    expect(existsSync(h.socket)).toBe(false);
  });
});

describe('native host: socket ownership', () => {
  it('replaces a stale socket file nobody listens on', async () => {
    const dir = tempDir();
    const socket = path.join(dir, 's.sock');
    // A real leftover socket: a process listens, then dies without cleaning up.
    const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(socket)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve) => child.stdout!.once('data', resolve));
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    expect(existsSync(socket)).toBe(true);
    const h = await host({ dir });
    expect(h.log()).toContain('listening on');
    const c = rawClient(h.socket);
    expect(await c.auth(h.token)).toMatchObject({ result: { ok: true } });
    c.socket.destroy();
  });

  it('replaces a plain file in the socket path', async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 's.sock'), 'junk');
    const h = await host({ dir });
    expect(h.log()).toContain('listening on');
  });

  it('refuses a socket a live host serves: clear stderr line, exit code 3, the first host keeps working', async () => {
    const first = await host();
    const second = await startHost({ dir: first.dir });
    expect(await second.done).toBe(3);
    expect(second.log()).toMatch(/another BlockFlow bridge is already serving .*s\.sock/);
    expect(second.fromHost.items).toEqual([]);
    second.stdin.end();
    expect(existsSync(first.socket)).toBe(true);
    const c = rawClient(first.socket);
    expect(await c.auth(first.token)).toMatchObject({ result: { ok: true } });
    c.socket.destroy();
  });
});

/** host.mjs as the browser runs it. */
function spawnHost(env: Record<string, string>) {
  const child = spawn(process.execPath, [HOST, 'chrome-extension://abc/'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const fromHost = inbox();
  const decoder = createNativeDecoder({ onMessage: (m: unknown) => fromHost.push(m as Message) });
  child.stdout.on('data', (chunk) => decoder.push(chunk));
  let stderr = '';
  const listening = new Promise<void>((resolve) =>
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.includes('listening on')) resolve();
    }),
  );
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, fromHost, listening, exited, stderr: () => stderr, toHost: (m: unknown) => child.stdin.write(encodeNative(m)) };
}

describe('native host as a child process', () => {
  it('relays between a socket client and the extension on stdio, and exits when stdin ends', async () => {
    const dir = tempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const env = { BLOCKFLOW_SOCKET: path.join(dir, 's.sock'), BLOCKFLOW_TOKEN_FILE: path.join(dir, 'token') };
    const proc = spawnHost(env);
    await proc.listening;
    const { connectBridge } = await import('../../packages/bridge/client.mjs');
    const bridge = await connectBridge({ socketPath: env.BLOCKFLOW_SOCKET, tokenFile: env.BLOCKFLOW_TOKEN_FILE, client: 'test' });
    expect(bridge.extensionConnected).toBe(true);
    const steps: Message[] = [];
    const answer = bridge.call('run', { source: 'x' }, { onNotification: (n: Message) => steps.push(n) });
    const request = await proc.fromHost.next();
    expect(request).toMatchObject({ jsonrpc: '2.0', method: 'run', params: { source: 'x' } });
    proc.toHost({ jsonrpc: '2.0', method: 'run.step', params: { requestId: request.id, runId: 'r', step: { status: 'passed' } } });
    proc.toHost({ jsonrpc: '2.0', id: request.id, result: { run: { id: 'r', status: 'passed' } } });
    expect(await answer).toEqual({ run: { id: 'r', status: 'passed' } });
    expect(steps).toEqual([{ jsonrpc: '2.0', method: 'run.step', params: { requestId: 2, runId: 'r', step: { status: 'passed' } } }]);
    expect(proc.stderr()).toContain('client 1 (test) connected');

    proc.child.stdin.end();
    expect(await proc.exited).toBe(0);
    await bridge.closed;
    expect(existsSync(env.BLOCKFLOW_SOCKET)).toBe(false);
  });

  it('exits with code 3 when another host serves the socket', async () => {
    const first = await host();
    const proc = spawnHost(first.env);
    expect(await proc.exited).toBe(3);
    expect(proc.stderr()).toContain('another BlockFlow bridge is already serving');
    expect(proc.fromHost.items).toEqual([]);
  });
});
