// Shared helpers for the bridge tests: a host run in-process with fake stdio (the "extension" side) and raw
// socket clients that speak NDJSON.
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createLineSplitter, createNativeDecoder, encodeLine, encodeNative } from '../../packages/bridge/framing.mjs';
import { runHost } from '../../packages/bridge/host.mjs';
import { readOrCreateToken } from '../../packages/bridge/paths.mjs';

export type Message = Record<string, any>;

/** A queue of messages with `next()` that waits for the next one. */
export function inbox() {
  const items: Message[] = [];
  const waiters: ((m: Message) => void)[] = [];
  return {
    items,
    push(message: Message) {
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else items.push(message);
    },
    next(timeoutMs = 3000): Promise<Message> {
      const ready = items.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no message within timeout')), timeoutMs);
        waiters.push((m) => {
          clearTimeout(timer);
          resolve(m);
        });
      });
    },
  };
}

export function tempDir() {
  // Short paths: unix socket paths are limited to ~108 bytes.
  return mkdtempSync(path.join(os.tmpdir(), 'bfb-'));
}

/** Starts runHost with PassThrough stdio. `toHost` writes native frames, `fromHost` receives them. */
export async function startHost(options: { dir?: string; authTimeoutMs?: number } = {}) {
  const dir = options.dir ?? tempDir();
  const env = { BLOCKFLOW_SOCKET: path.join(dir, 's.sock'), BLOCKFLOW_TOKEN_FILE: path.join(dir, 'token') };
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let log = '';
  const stderr = { write: (text: string | Uint8Array) => ((log += String(text)), true) };
  const fromHost = inbox();
  const decoder = createNativeDecoder({ onMessage: (m: unknown) => fromHost.push(m as Message) });
  stdout.on('data', (chunk) => decoder.push(chunk));
  let ready!: () => void;
  const readyPromise = new Promise<void>((resolve) => (ready = resolve));
  const done: Promise<number> = runHost({ stdin, stdout, stderr, env, authTimeoutMs: options.authTimeoutMs, onReady: () => ready() });
  await Promise.race([readyPromise, done]);
  return {
    dir,
    env,
    socket: env.BLOCKFLOW_SOCKET,
    tokenFile: env.BLOCKFLOW_TOKEN_FILE,
    token: readOrCreateToken(env.BLOCKFLOW_TOKEN_FILE),
    stdin,
    fromHost,
    done,
    log: () => log,
    toHost: (message: unknown) => stdin.write(encodeNative(message)),
    cleanup: () => {
      stdin.end();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A raw NDJSON client. */
export function rawClient(socketPath: string) {
  const socket = net.createConnection(socketPath);
  const messages = inbox();
  const splitter = createLineSplitter({ onLine: (line: string) => messages.push(JSON.parse(line)) });
  socket.on('data', (chunk) => splitter.push(chunk));
  socket.on('error', () => {});
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
  return {
    socket,
    messages,
    closed,
    send: (message: unknown) => socket.write(encodeLine(message)),
    sendRaw: (text: string) => socket.write(text),
    async auth(token: string) {
      socket.write(encodeLine({ jsonrpc: '2.0', id: 'a', method: 'auth', params: { token, protocol: 1 } }));
      return messages.next();
    },
  };
}
