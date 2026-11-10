// One lazily opened bridge connection shared by every tool call, with a single reconnect on a
// transport failure. The connector is injected (tests pass a fake); the default one loads
// `connectBridge` from blockflow-bridge/client on first use.
import { RPC_ERRORS } from 'blockflow-bridge/protocol';

/**
 * The interface of `connectBridge` from blockflow-bridge/client (tests implement it directly).
 * `onNotification` gets the whole JSON-RPC notification `{jsonrpc, method, params}`.
 * `closed` (optional) resolves when the connection ends; the session then reconnects on the next call.
 * @typedef {{ onNotification?: (notification: { method: string, params: any }) => void, timeoutMs?: number }} CallOptions
 * @typedef {{ call(method: string, params?: unknown, options?: CallOptions): Promise<any>, close(): void | Promise<void>, closed?: Promise<unknown> }} BridgeClient
 * @typedef {() => Promise<BridgeClient>} BridgeConnector
 */

/** Methods that are safe to send twice when the connection drops under them. */
const IDEMPOTENT = new Set(['hello', 'validate', 'list', 'report', 'blob.get', 'suite.list', 'stop', 'snapshot']);

const NOT_REACHABLE =
  'BlockFlow is not reachable: is the browser open with Allow outside control on, and the bridge installed?';

/**
 * The default connector: `connectBridge` from `blockflow-bridge/client`, with the
 * socket and token file from the environment (the client reads BLOCKFLOW_SOCKET / BLOCKFLOW_TOKEN_FILE).
 * @param {{ socketPath?: string, tokenFile?: string, timeoutMs?: number }} [options]
 * @returns {BridgeConnector}
 */
export function defaultConnector(options = {}) {
  return async () => {
    /** @type {any} */
    let mod;
    try {
      mod = await import('blockflow-bridge/client');
    } catch (error) {
      const err = new Error(
        `The blockflow-bridge client could not be loaded (${/** @type {Error} */ (error).message}). Reinstall blockflow-mcp.`,
      );
      throw err;
    }
    return mod.connectBridge({ client: 'blockflow-mcp', ...options });
  };
}

/**
 * @param {BridgeConnector} connect
 */
export function createBridgeSession(connect) {
  /** @type {BridgeClient | null} */
  let client = null;
  /** Set when the current client's `closed` promise settles. */
  let clientClosed = false;
  /** @type {Promise<BridgeClient> | null} */
  let pending = null;

  async function get() {
    if (client && !clientClosed) return client;
    client = null;
    pending ??= (async () => {
      try {
        const opened = await connect();
        client = opened;
        clientClosed = false;
        Promise.resolve(opened.closed).then(
          () => {
            if (opened.closed && client === opened) clientClosed = true;
          },
          () => {},
        );
        return opened;
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  function drop() {
    const old = client;
    client = null;
    if (old) {
      try {
        void Promise.resolve(old.close()).catch(() => {});
      } catch {
        // already closed
      }
    }
  }

  /**
   * @param {string} method
   * @param {unknown} [params]
   * @param {CallOptions} [options]
   */
  async function call(method, params = {}, options = {}) {
    let first;
    try {
      first = await get();
    } catch {
      // Connecting failed: try once more (the host may have just restarted).
      first = await get();
    }
    try {
      return await first.call(method, params, options);
    } catch (error) {
      if (!(await connectionLost(first, error))) throw error;
      drop();
      if (!IDEMPOTENT.has(method)) {
        const err = /** @type {any} */ (
          new Error(
            `${/** @type {Error} */ (error)?.message ?? error} The connection dropped during ${method}, so it was not retried ` +
              '(it changes state; a run may still be going in the browser). Call the tool again.',
          )
        );
        err.code = /** @type {any} */ (error)?.code;
        throw err;
      }
      const second = await get();
      return second.call(method, params, options);
    }
  }

  /** True when `error` means the connection is gone (not an answer from the host or extension). */
  async function connectionLost(used, error) {
    const code = /** @type {any} */ (error)?.code;
    if (typeof code !== 'number') return true;
    if (code !== RPC_ERRORS.notConnected) return false;
    // notConnected is also the host's answer "the extension is not connected"; only a closed socket counts.
    await new Promise((done) => setImmediate(done));
    return used !== client || clientClosed;
  }

  return {
    call,
    async close() {
      const old = client;
      client = null;
      if (old) await old.close();
    },
  };
}

const HINTS = {
  [RPC_ERRORS.disabled]:
    'In BlockFlow open Settings and switch on "Allow outside control" (it is off by default).',
  [RPC_ERRORS.notConnected]:
    'The bridge is running but the extension is not connected to it: open the browser with BlockFlow and switch on "Allow outside control" in Settings.',
  [RPC_ERRORS.unauthorized]:
    'The bridge token did not match. Restart the browser (the native host rewrites the token), or check BLOCKFLOW_TOKEN_FILE.',
  [RPC_ERRORS.version]: 'blockflow-mcp and the BlockFlow extension speak different protocol versions: update both.',
  [RPC_ERRORS.tooLarge]: 'The message is over 1 MB. Send a smaller workflow, or save it first and run it by id.',
};

/** A readable one-paragraph message for any error from the bridge or the client. */
export function describeError(error) {
  const e = /** @type {any} */ (error);
  let message = typeof e?.message === 'string' && e.message ? e.message : String(error);
  if (/ENOENT|ECONNREFUSED|ENOTSOCK|EACCES/.test(message) && !message.includes('not reachable')) {
    message = `${NOT_REACHABLE} (${message})`;
  }
  let hint = typeof e?.code === 'number' ? HINTS[e.code] : undefined;
  // The client reports a missing socket or a closed connection as notConnected too; its message says enough.
  if (e?.code === RPC_ERRORS.notConnected && /not reachable|closed the connection/.test(message)) hint = undefined;
  return hint && !message.includes(hint) ? `${message}\n${hint}` : message;
}
