// Client for the bridge socket, used by the MCP server and the CLI:
//
//   const bridge = await connectBridge({ client: 'blockflow-mcp' });
//   const { run } = await bridge.call('run', { source }, { onNotification: (n) => console.error(n.method) });
//   bridge.close();
//
// Every failure is a BridgeError with the JSON-RPC `.code` (RPC_ERRORS) and `.data`.
import net from 'node:net';
import { createLineSplitter, encodeLine } from './framing.mjs';
import { readToken, socketPath as defaultSocketPath, tokenFile as defaultTokenFile } from './paths.mjs';
import { BRIDGE_PROTOCOL_VERSION, MAX_MESSAGE_BYTES, RPC_ERRORS } from './protocol.mjs';

export const NOT_REACHABLE = 'BlockFlow is not reachable: is the browser open with Allow outside control on, and the bridge installed?';

export class BridgeError extends Error {
  /**
   * @param {number} code JSON-RPC error code (see RPC_ERRORS)
   * @param {string} message
   * @param {{ code?: string, [key: string]: unknown }} [data]
   */
  constructor(code, message, data) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.data = data;
  }
}

/**
 * @typedef {{ jsonrpc: '2.0', method: string, params: any }} Notification
 * @typedef {{ onNotification?: (notification: Notification) => void, timeoutMs?: number }} CallOptions
 * @typedef {{
 *   call: (method: string, params?: unknown, options?: CallOptions) => Promise<any>,
 *   close: () => void,
 *   extensionConnected: boolean,
 *   closed: Promise<void>,
 * }} BridgeConnection
 */

/**
 * Connects and authenticates. `timeoutMs` (default 120 s) covers connecting and is the default for each
 * `call`; pass `timeoutMs: 0` to a call to wait as long as it takes (a long `run`).
 * @param {{ socketPath?: string, tokenFile?: string, client?: string, timeoutMs?: number, env?: Record<string, string | undefined> }} [options]
 * @returns {Promise<BridgeConnection>}
 */
export async function connectBridge(options = {}) {
  const env = options.env ?? process.env;
  const where = options.socketPath ?? defaultSocketPath(env);
  const tokenPath = options.tokenFile ?? defaultTokenFile(env);
  const defaultTimeout = options.timeoutMs ?? 120_000;

  let token;
  try {
    token = readToken(tokenPath);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ENOENT') throw new BridgeError(RPC_ERRORS.notConnected, NOT_REACHABLE, { code: 'ENOENT', path: tokenPath });
    throw new BridgeError(RPC_ERRORS.internal, `Cannot read the bridge token ${tokenPath}: ${/** @type {Error} */ (error).message}`);
  }

  const socket = await new Promise((resolve, reject) => {
    const candidate = net.createConnection(where);
    const timer = defaultTimeout > 0 ? setTimeout(() => {
      candidate.destroy();
      reject(new BridgeError(RPC_ERRORS.notConnected, `${NOT_REACHABLE} (connecting to ${where} timed out)`, { code: 'TIMEOUT', path: where }));
    }, defaultTimeout) : undefined;
    candidate.once('connect', () => {
      clearTimeout(timer);
      candidate.off('error', onError);
      resolve(candidate);
    });
    const onError = (/** @type {NodeJS.ErrnoException} */ error) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') reject(new BridgeError(RPC_ERRORS.notConnected, NOT_REACHABLE, { code: error.code, path: where }));
      else reject(new BridgeError(RPC_ERRORS.notConnected, `${NOT_REACHABLE} (${error.message})`, { code: error.code, path: where }));
    };
    candidate.once('error', onError);
  });

  let nextId = 1;
  let isClosed = false;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void, onNotification?: (n: Notification) => void, timer?: NodeJS.Timeout }>} */
  const waiting = new Map();
  /** @type {() => void} */
  let markClosed = () => {};
  const closed = new Promise((resolve) => (markClosed = () => resolve(undefined)));
  /** Why the host hung up, when it said so (bridge.disabled etc. arrive as errors on pending calls). */
  let closeReason = 'The BlockFlow bridge closed the connection (the browser closed, or outside control was switched off).';

  const splitter = createLineSplitter({
    maxBytes: MAX_MESSAGE_BYTES + 64 * 1024,
    onLine: (line) => {
      /** @type {any} */
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message && typeof message.method === 'string' && message.id === undefined) {
        const entry = waiting.get(Number(message.params?.requestId));
        entry?.onNotification?.(message);
        return;
      }
      if (message?.id === null && message.error) {
        // The host rejected something it could not tie to a request (e.g. a line over the limit).
        closeReason = message.error.message;
        return;
      }
      const entry = waiting.get(Number(message?.id));
      if (!entry) return;
      waiting.delete(Number(message.id));
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new BridgeError(message.error.code, message.error.message, message.error.data));
      else entry.resolve(message.result);
    },
  });
  socket.on('data', (chunk) => splitter.push(chunk));
  socket.on('error', () => {});
  socket.on('close', () => {
    isClosed = true;
    for (const [id, entry] of waiting) {
      waiting.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new BridgeError(RPC_ERRORS.notConnected, closeReason));
    }
    markClosed();
  });

  /** @type {BridgeConnection['call']} */
  function call(method, params = {}, callOptions = {}) {
    if (isClosed) return Promise.reject(new BridgeError(RPC_ERRORS.notConnected, closeReason));
    const id = nextId++;
    const timeoutMs = callOptions.timeoutMs ?? defaultTimeout;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        waiting.delete(id);
        reject(new BridgeError(RPC_ERRORS.internal, `BlockFlow did not answer ${method} within ${Math.round(timeoutMs / 100) / 10} s`, { code: 'TIMEOUT', method }));
      }, timeoutMs) : undefined;
      waiting.set(id, { resolve, reject, onNotification: callOptions.onNotification, timer });
      socket.write(encodeLine({ jsonrpc: '2.0', id, method, params }));
    });
  }

  function close() {
    socket.end();
    setTimeout(() => socket.destroy(), 500).unref();
  }

  let auth;
  try {
    auth = await call('auth', { token, protocol: BRIDGE_PROTOCOL_VERSION, ...(options.client ? { client: options.client } : {}) });
  } catch (error) {
    socket.destroy();
    throw error;
  }
  return { call, close, extensionConnected: Boolean(auth?.extensionConnected), closed };
}
