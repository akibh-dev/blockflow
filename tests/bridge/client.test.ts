import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BridgeError, NOT_REACHABLE, connectBridge } from '../../packages/bridge/client.mjs';
import { RPC_ERRORS } from '../../packages/bridge/protocol.mjs';
import { startHost, tempDir } from './helpers';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));
async function host() {
  const h = await startHost();
  cleanups.push(h.cleanup);
  return h;
}
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected a failure'); }, (error: unknown) => error as BridgeError);

describe('bridge client', () => {
  it('no token / no socket → the readable "not reachable" error', async () => {
    const dir = tempDir();
    const noToken = await failure(connectBridge({ socketPath: path.join(dir, 's.sock'), tokenFile: path.join(dir, 'token') }));
    expect(noToken).toBeInstanceOf(BridgeError);
    expect(noToken).toMatchObject({ code: RPC_ERRORS.notConnected, message: NOT_REACHABLE });
    writeFileSync(path.join(dir, 'token'), 'abc\n');
    const noSocket = await failure(connectBridge({ socketPath: path.join(dir, 's.sock'), tokenFile: path.join(dir, 'token') }));
    expect(noSocket).toMatchObject({ code: RPC_ERRORS.notConnected, message: NOT_REACHABLE, data: { code: 'ENOENT' } });
  });

  it('a stale socket (ECONNREFUSED) gives the same error', async () => {
    const dir = tempDir();
    const socket = path.join(dir, 's.sock');
    writeFileSync(path.join(dir, 'token'), 'abc\n');
    const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(socket)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve) => child.stdout!.once('data', resolve));
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    const error = await failure(connectBridge({ socketPath: socket, tokenFile: path.join(dir, 'token') }));
    expect(error).toMatchObject({ code: RPC_ERRORS.notConnected, message: NOT_REACHABLE, data: { code: 'ECONNREFUSED' } });
  });

  it('a wrong token is a BridgeError with the unauthorized code', async () => {
    const h = await host();
    const file = path.join(h.dir, 'other-token');
    writeFileSync(file, 'f'.repeat(64));
    const error = await failure(connectBridge({ socketPath: h.socket, tokenFile: file }));
    expect(error).toMatchObject({ name: 'BridgeError', code: RPC_ERRORS.unauthorized });
  });

  it('passes extension errors through with code and data', async () => {
    const h = await host();
    const bridge = await connectBridge({ socketPath: h.socket, tokenFile: h.tokenFile });
    const pending = failure(bridge.call('validate', { source: '{}' }));
    const request = await h.fromHost.next();
    h.toHost({ jsonrpc: '2.0', id: request.id, error: { code: RPC_ERRORS.invalidWorkflow, message: 'Bad', data: { issues: [{ code: 'X' }] } } });
    expect(await pending).toMatchObject({ code: RPC_ERRORS.invalidWorkflow, message: 'Bad', data: { issues: [{ code: 'X' }] } });
    bridge.close();
  });

  it('times out a call (per call and by default) and keeps working', async () => {
    const h = await host();
    const bridge = await connectBridge({ socketPath: h.socket, tokenFile: h.tokenFile, timeoutMs: 100 });
    const slow = await failure(bridge.call('list'));
    expect(slow).toMatchObject({ code: RPC_ERRORS.internal, data: { code: 'TIMEOUT', method: 'list' } });
    expect(slow.message).toMatch(/did not answer list within 0.1 s/);
    const late = await h.fromHost.next();
    h.toHost({ jsonrpc: '2.0', id: late.id, result: { workflows: [] } }); // ignored: nobody waits any more
    const quick = bridge.call('list', {}, { timeoutMs: 0 });
    const request = await h.fromHost.next();
    await new Promise((resolve) => setTimeout(resolve, 150));
    h.toHost({ jsonrpc: '2.0', id: request.id, result: { workflows: [{ id: 'w' }] } });
    expect(await quick).toEqual({ workflows: [{ id: 'w' }] });
    bridge.close();
  });

  it('host gone mid-call → notConnected error, later calls fail fast', async () => {
    const h = await host();
    const bridge = await connectBridge({ socketPath: h.socket, tokenFile: h.tokenFile });
    const pending = failure(bridge.call('run', {}));
    await h.fromHost.next();
    h.stdin.end();
    expect(await pending).toMatchObject({ code: RPC_ERRORS.notConnected, message: expect.stringMatching(/disconnected/) });
    await bridge.closed;
    expect(await failure(bridge.call('list'))).toMatchObject({ code: RPC_ERRORS.notConnected });
  });
});
