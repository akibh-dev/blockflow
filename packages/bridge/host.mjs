#!/usr/bin/env node
// The native messaging host. The browser starts it when the extension calls
// `runtime.connectNative('dev.akibh.blockflow')` and talks to it on stdin/stdout (native framing). The host
// listens on a per-user local socket and relays JSON-RPC between socket clients (MCP server, CLI) and the
// extension:
//
//   client --NDJSON, auth first--> host --native frames, ids rewritten--> extension
//   client <--response / run.* notifications, original ids-- host <-- extension
//
// stdout is the native channel: everything human goes to stderr. The host lives exactly as long as the
// extension's port: stdin ends -> clients are told, the socket is removed, the process exits.
import { timingSafeEqual } from 'node:crypto';
import { chmodSync, realpathSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { FrameTooLargeError, createLineSplitter, createNativeDecoder, encodeLine, encodeNative } from './framing.mjs';
import { readOrCreateToken, socketPath as defaultSocketPath, tokenFile as defaultTokenFile } from './paths.mjs';
import { BRIDGE_METHODS, BRIDGE_PROTOCOL_VERSION, MAX_MESSAGE_BYTES, RPC_ERRORS } from './protocol.mjs';

/** Exit codes of `runHost`. */
export const EXIT = Object.freeze({ ok: 0, error: 1, socketInUse: 3 });

/** Notifications from the extension that belong to one request (`params.requestId`). */
const ROUTED_NOTIFICATIONS = new Set(['run.started', 'run.step', 'suite.progress']);
const FORWARDED = new Set(BRIDGE_METHODS.filter((method) => method !== 'auth'));

/**
 * @typedef {{ write(chunk: string | Uint8Array): boolean }} Writable
 * @typedef {{
 *   stdin: NodeJS.ReadableStream,
 *   stdout: NodeJS.WritableStream,
 *   stderr?: Writable,
 *   env?: Record<string, string | undefined>,
 *   authTimeoutMs?: number,
 *   onReady?: (info: { socketPath: string, tokenFile: string }) => void,
 * }} HostOptions
 * @typedef {{ socket: net.Socket, id: number, authed: boolean, name?: string, closed: boolean }} Client
 * @typedef {{ client: Client, originalId: string | number, method: string }} Pending
 */

/**
 * Runs the relay until the extension disconnects (stdin ends). Resolves with the exit code:
 * 0 normal end, 1 could not listen, 3 the socket is served by another live host.
 * @param {HostOptions} options
 * @returns {Promise<number>}
 */
export async function runHost({ stdin, stdout, stderr = process.stderr, env = process.env, authTimeoutMs = 10_000, onReady }) {
  const log = (/** @type {string} */ text) => stderr.write(`[blockflow-bridge] ${text}\n`);
  const where = defaultSocketPath(env);
  const tokenPath = defaultTokenFile(env);
  const windows = where.startsWith('\\\\.\\pipe\\');

  let token;
  try {
    token = Buffer.from(readOrCreateToken(tokenPath), 'utf8');
  } catch (error) {
    log(`cannot read or create the token file ${tokenPath}: ${/** @type {Error} */ (error).message}`);
    return EXIT.error;
  }

  /** @type {Set<Client>} */
  const clients = new Set();
  /** Host request id -> who asked. @type {Map<number, Pending>} */
  const pending = new Map();
  let nextHostId = 1;
  let nextClientId = 1;
  // Started by a browser: stdin is a pipe. Started by hand in a terminal: no extension behind it.
  let extensionConnected = !(/** @type {{ isTTY?: boolean }} */ (stdin).isTTY);
  let disabled = false;
  let finished = false;
  /** Set once we listen: only then is the socket file ours to remove. */
  let ownSocket = false;
  /** @type {(code: number) => void} */
  let resolveDone = () => {};
  const done = new Promise((resolve) => (resolveDone = resolve));

  // ---------- extension side (stdin / stdout) ----------

  /** @param {unknown} message @returns {boolean} false when the message could not be sent */
  const sendToExtension = (message) => {
    const frame = encodeNative(message);
    try {
      stdout.write(frame);
      return true;
    } catch (error) {
      log(`writing to the extension failed: ${/** @type {Error} */ (error).message}`);
      return false;
    }
  };

  const decoder = createNativeDecoder({
    onMessage: (message) => onExtensionMessage(message),
    onError: (error) => log(`dropped a message from the extension: ${error.message}`),
  });

  /** @param {any} message */
  function onExtensionMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (typeof message.method === 'string' && message.id === undefined) {
      if (message.method === 'bridge.disabled') {
        log('outside control was switched off: closing client connections');
        disabled = true;
        failAll(RPC_ERRORS.disabled, 'Outside control was switched off in BlockFlow.');
        for (const client of clients) closeClient(client);
        return;
      }
      if (ROUTED_NOTIFICATIONS.has(message.method)) {
        const route = pending.get(Number(message.params?.requestId));
        if (!route) return;
        send(route.client, { ...message, params: { ...message.params, requestId: route.originalId } });
        return;
      }
      log(`ignored notification ${message.method}`);
      return;
    }
    if (message.id !== undefined && message.id !== null && ('result' in message || 'error' in message)) {
      const route = pending.get(Number(message.id));
      if (!route) return;
      pending.delete(Number(message.id));
      send(route.client, { ...message, id: route.originalId });
      return;
    }
    log('ignored a message from the extension that is neither a response nor a notification');
  }

  stdin.on('data', (chunk) => decoder.push(/** @type {Buffer} */ (chunk)));
  stdin.on('end', () => finish(EXIT.ok, 'the extension disconnected'));
  stdin.on('close', () => finish(EXIT.ok, 'the extension disconnected'));
  stdin.on('error', (error) => finish(EXIT.ok, `stdin error: ${error.message}`));
  stdout.on('error', (error) => finish(EXIT.ok, `stdout error: ${error.message}`));

  // ---------- socket side ----------

  /** @param {Client} client @param {unknown} message */
  function send(client, message) {
    if (client.closed) return;
    client.socket.write(encodeLine(message));
  }

  /** @param {Client} client @param {string | number | null} id @param {number} code @param {string} text @param {object} [data] */
  function sendError(client, id, code, text, data) {
    send(client, { jsonrpc: '2.0', id, error: { code, message: text, ...(data ? { data } : {}) } });
  }

  /** @param {Client} client */
  function closeClient(client) {
    if (client.closed) return;
    client.closed = true;
    clients.delete(client);
    for (const [hostId, route] of pending) if (route.client === client) pending.delete(hostId);
    client.socket.end();
    // A client that does not read must not keep the host alive.
    setTimeout(() => client.socket.destroy(), 1000).unref();
  }

  /** Answers every request still waiting on the extension. @param {number} code @param {string} text */
  function failAll(code, text) {
    for (const [hostId, route] of pending) {
      pending.delete(hostId);
      sendError(route.client, route.originalId, code, text);
    }
  }

  /** @param {Client} client @param {string} line */
  function onClientLine(client, line) {
    /** @type {any} */
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      sendError(client, null, RPC_ERRORS.parse, 'Not JSON');
      if (!client.authed) closeClient(client);
      return;
    }
    const id = message && (typeof message.id === 'string' || typeof message.id === 'number') ? message.id : null;
    if (!client.authed) {
      const given = typeof message?.params?.token === 'string' ? Buffer.from(message.params.token, 'utf8') : Buffer.alloc(0);
      const ok = message?.method === 'auth' && given.length === token.length && timingSafeEqual(given, token);
      if (!ok) {
        sendError(client, id, RPC_ERRORS.unauthorized, message?.method === 'auth' ? 'Wrong token' : 'The first message must be auth {token, protocol}');
        closeClient(client);
        return;
      }
      if (message.params.protocol !== BRIDGE_PROTOCOL_VERSION) {
        sendError(client, id, RPC_ERRORS.version, `Protocol ${message.params.protocol} is not supported; this host speaks ${BRIDGE_PROTOCOL_VERSION}`, { protocol: BRIDGE_PROTOCOL_VERSION });
        closeClient(client);
        return;
      }
      client.authed = true;
      client.name = typeof message.params.client === 'string' ? message.params.client.slice(0, 80) : undefined;
      log(`client ${client.id}${client.name ? ` (${client.name})` : ''} connected`);
      if (id !== null) send(client, { jsonrpc: '2.0', id, result: { ok: true, extensionConnected: extensionConnected && !disabled } });
      return;
    }
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      sendError(client, id, RPC_ERRORS.invalidRequest, 'Not a JSON-RPC 2.0 request');
      return;
    }
    if (id === null) return; // a notification from a client: nothing to forward it to
    if (message.method === 'auth') {
      send(client, { jsonrpc: '2.0', id, result: { ok: true, extensionConnected: extensionConnected && !disabled } });
      return;
    }
    if (!FORWARDED.has(message.method)) {
      sendError(client, id, RPC_ERRORS.methodNotFound, `Unknown method ${message.method}`);
      return;
    }
    if (disabled) {
      sendError(client, id, RPC_ERRORS.disabled, 'Outside control is switched off in BlockFlow.');
      return;
    }
    if (!extensionConnected) {
      sendError(client, id, RPC_ERRORS.notConnected, 'The BlockFlow extension is not connected to this bridge.');
      return;
    }
    const hostId = nextHostId++;
    let frame;
    try {
      frame = encodeNative({ jsonrpc: '2.0', id: hostId, method: message.method, params: message.params ?? {} });
    } catch (error) {
      if (error instanceof FrameTooLargeError) sendError(client, id, RPC_ERRORS.tooLarge, `Request is ${error.size} bytes; the limit is ${MAX_MESSAGE_BYTES}`);
      else sendError(client, id, RPC_ERRORS.internal, String(error));
      return;
    }
    pending.set(hostId, { client, originalId: id, method: message.method });
    try {
      stdout.write(frame);
    } catch (error) {
      pending.delete(hostId);
      sendError(client, id, RPC_ERRORS.notConnected, `Could not reach the extension: ${/** @type {Error} */ (error).message}`);
    }
  }

  const server = net.createServer((socket) => {
    if (finished) return socket.destroy();
    /** @type {Client} */
    const client = { socket, id: nextClientId++, authed: false, closed: false };
    clients.add(client);
    const authTimer = setTimeout(() => {
      if (!client.authed) closeClient(client);
    }, authTimeoutMs);
    authTimer.unref();
    const splitter = createLineSplitter({
      onLine: (line) => onClientLine(client, line),
      onError: (error) => {
        sendError(client, null, RPC_ERRORS.tooLarge, `${error.message}`);
        closeClient(client);
      },
    });
    socket.on('data', (chunk) => {
      if (!client.closed) splitter.push(chunk);
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(authTimer);
      if (client.authed) log(`client ${client.id} disconnected`);
      client.closed = true;
      clients.delete(client);
      for (const [hostId, route] of pending) if (route.client === client) pending.delete(hostId);
    });
  });

  // ---------- listen (replacing a stale socket, refusing a live one) ----------

  const listening = await listen(server, where, windows);
  if (listening === 'in-use') {
    log(
      `another BlockFlow bridge is already serving ${where} (outside control is on in another browser or profile). ` +
        'Switch it off there, or give this browser its own BLOCKFLOW_SOCKET. Exiting.',
    );
    stdin.pause();
    return EXIT.socketInUse;
  }
  if (listening instanceof Error) {
    log(`cannot listen on ${where}: ${listening.message}`);
    stdin.pause();
    return EXIT.error;
  }
  ownSocket = true;
  if (!windows) {
    try {
      chmodSync(where, 0o600);
    } catch {}
  }
  // stdin may already have ended while we were setting up.
  if (finished) {
    removeSocket();
    return done;
  }
  log(`listening on ${where}`);
  onReady?.({ socketPath: where, tokenFile: tokenPath });

  function removeSocket() {
    server.close();
    if (!ownSocket || windows) return;
    ownSocket = false;
    try {
      unlinkSync(where);
    } catch {}
  }

  /** @param {number} code @param {string} reason */
  function finish(code, reason) {
    if (finished) return;
    finished = true;
    extensionConnected = false;
    log(`${reason}: shutting down`);
    failAll(RPC_ERRORS.notConnected, 'The BlockFlow extension disconnected (the browser closed, or outside control was switched off).');
    for (const client of clients) closeClient(client);
    // Only our own socket: a host that lost the race must not delete the winner's.
    removeSocket();
    resolveDone(code);
  }

  return done;
}

/**
 * Listens on `where`. A leftover unix socket file nobody answers on is removed first; one a live host
 * answers on (or a Windows pipe already taken) gives 'in-use'.
 * @param {net.Server} server @param {string} where @param {boolean} windows
 * @returns {Promise<'ok' | 'in-use' | Error>}
 */
async function listen(server, where, windows) {
  const attempt = () =>
    new Promise((resolve) => {
      const onError = (/** @type {NodeJS.ErrnoException} */ error) => {
        server.off('listening', onListening);
        resolve(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve('ok');
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(where);
    });
  let result = /** @type {'ok' | NodeJS.ErrnoException} */ (await attempt());
  if (result === 'ok') return 'ok';
  if (result.code !== 'EADDRINUSE') return result;
  if (windows) return 'in-use';
  if (await isLive(where)) return 'in-use';
  try {
    unlinkSync(where);
  } catch {}
  result = /** @type {'ok' | NodeJS.ErrnoException} */ (await attempt());
  if (result === 'ok') return 'ok';
  return result.code === 'EADDRINUSE' ? 'in-use' : result;
}

/** True when something accepts connections on the socket. @param {string} where */
export function isLive(where) {
  return new Promise((resolve) => {
    const probe = net.createConnection(where);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

// `node host.mjs` (what the installed launcher runs). Chromium passes the caller's origin as an argument.
const invokedAs = process.argv[1] ? (() => {
  try {
    return realpathSync(process.argv[1]);
  } catch {
    return process.argv[1];
  }
})() : '';
if (invokedAs === fileURLToPath(import.meta.url)) {
  runHost({ stdin: process.stdin, stdout: process.stdout }).then((code) => {
    // Let stdout flush (a final response) before leaving.
    process.stdout.write('', () => process.exit(code));
  });
}
