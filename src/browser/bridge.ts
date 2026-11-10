import { browser } from 'wxt/browser';
import { BRIDGE_STORAGE_KEYS, NATIVE_HOST_NAME, RPC_ERRORS } from '../core/bridgeProtocol';
import type { BridgeLogEntry, BridgeSettings, RpcNotification, RpcResponse } from '../core/bridgeProtocol';
import { snapshotDocument } from '../core/page';
import type { SnapshotResult } from '../core/page';
import { normalizeHttpUrl } from '../core/url';
import { BridgeRpcError, boundedLog } from './bridgeHandlers';
import type { IncomingRequest, Notify } from './bridgeHandlers';
import { addOwnTab } from './ownTabs';
import { actInTab } from './pageDriver';
import { requireTabId, waitForTabComplete } from './tabs';
import { BRIDGE_STATUS_KEY } from './bridgeStatus';
import type { BridgeState, BridgeStatus } from './bridgeStatus';

/**
 * The extension end of the M4 bridge (`src/core/bridgeProtocol.ts`): while "Allow outside control" is
 * on, the worker keeps a native messaging port to the BlockFlow native host (`packages/bridge`) open.
 * An open native port also keeps the MV3 worker alive. The host forwards JSON-RPC requests from local
 * programs (MCP server, CLI); `bridgeHandlers.ts` answers them.
 *
 *   on  → connectNative(NATIVE_HOST_NAME); reconnect with backoff whenever the port closes while on,
 *         giving up (state `failed`) after MAX_RECONNECTS closes in a row
 *   off → post `bridge.disabled` (the host closes its clients), then disconnect
 *
 * The connection state for the Settings page is in storage.session `bf:bridge-status`.
 */

export { BRIDGE_STATUS_KEY } from './bridgeStatus';
export type { BridgeState, BridgeStatus } from './bridgeStatus';

/** The parts of `runtime.Port` the bridge uses. */
export interface NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: (port: unknown) => void): void };
}

export interface BridgeConnectionDeps {
  /** Opens the native port (`runtime.connectNative`). May throw (permission missing). */
  connect(): NativePort;
  /** Why the port closed: `runtime.lastError` (Chrome) or `port.error` (Firefox). */
  disconnectReason(port: unknown): string | undefined;
  respond(request: IncomingRequest, notify: Notify): Promise<RpcResponse>;
  setStatus(status: BridgeStatus): void;
  /** Calls `fn` after `ms`; returns a cancel function. */
  after(ms: number, fn: () => void): () => void;
  now?(): number;
}

/** A port that stayed open this long counts as connected (the host is running). */
export const CONNECTED_AFTER_MS = 1_000;
/** Reconnect delays: 1 s, 2 s, 4 s … up to this. */
export const MAX_BACKOFF_MS = 30_000;

/**
 * Closes in a row (each before the port counted as connected) after which the worker stops trying: the
 * host is missing, or exits at once (code 3: another browser's host already owns the socket).
 */
export const MAX_RECONNECTS = 5;

/** Delay before reconnect attempt `attempts` (1-based). */
export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempts - 1));
}

function isRequest(message: unknown): message is IncomingRequest {
  if (typeof message !== 'object' || message === null) return false;
  const value = message as Record<string, unknown>;
  return typeof value.method === 'string' && (typeof value.id === 'string' || typeof value.id === 'number');
}

/**
 * The port's lifecycle. `enable()` / `disable()` are idempotent; background.ts calls them whenever
 * the setting or the permission may have changed.
 */
export function createBridgeConnection(deps: BridgeConnectionDeps) {
  const now = deps.now ?? (() => Date.now());
  let enabled = false;
  let port: NativePort | undefined;
  let attempts = 0;
  let lastError: string | undefined;
  let cancelPending = () => {};
  let state: BridgeState = 'off';

  const status = (next: BridgeState) => {
    state = next;
    deps.setStatus({ state: next, since: new Date(now()).toISOString(), ...(lastError ? { error: lastError } : {}), ...(attempts ? { attempts } : {}) });
  };

  const post = (target: NativePort, message: RpcResponse | RpcNotification) => {
    try {
      target.postMessage(message);
    } catch {
      // The port closed meanwhile; onDisconnect deals with it.
    }
  };

  const markConnected = (target: NativePort) => {
    if (port !== target || state === 'connected') return;
    attempts = 0;
    lastError = undefined;
    status('connected');
  };

  function open(): void {
    cancelPending();
    if (!enabled || port) return;
    let opened: NativePort;
    try {
      opened = deps.connect();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      retry();
      return;
    }
    port = opened;
    status('connecting');
    const cancelConnected = deps.after(CONNECTED_AFTER_MS, () => markConnected(opened));
    opened.onMessage.addListener((message) => {
      markConnected(opened);
      if (!isRequest(message)) return; // the host sends only requests
      const notify: Notify = (method, params) => post(opened, { jsonrpc: '2.0', method, params });
      void deps
        .respond(message, notify)
        .then((response) => post(opened, response))
        .catch((error: unknown) => post(opened, { jsonrpc: '2.0', id: message.id, error: { code: RPC_ERRORS.internal, message: error instanceof Error ? error.message : String(error) } }));
    });
    opened.onDisconnect.addListener((closed) => {
      cancelConnected();
      if (port !== opened) return;
      port = undefined;
      lastError = deps.disconnectReason(closed) ?? 'The native host closed the connection.';
      if (enabled) retry();
      else status('off');
    });
  }

  function retry(): void {
    attempts += 1;
    if (attempts >= MAX_RECONNECTS) {
      lastError = `The bridge could not start (${lastError ?? 'no reason given'}). Is it installed for this browser, or does another browser hold it? Switch outside control off and on to try again.`;
      status('failed');
      return;
    }
    status('waiting');
    cancelPending = deps.after(backoffMs(attempts), () => open());
  }

  return {
    enable(): void {
      if (enabled) return;
      enabled = true;
      attempts = 0;
      lastError = undefined;
      open();
    },
    /** Tells the host (it closes its clients) and closes the port. */
    disable(): void {
      cancelPending();
      if (!enabled && !port) return;
      enabled = false;
      const current = port;
      port = undefined;
      if (current) {
        post(current, { jsonrpc: '2.0', method: 'bridge.disabled', params: {} });
        try {
          current.disconnect();
        } catch {
          // already closed
        }
      }
      attempts = 0;
      lastError = undefined;
      status('off');
    },
    get state(): BridgeState {
      return state;
    },
    get enabled(): boolean {
      return enabled;
    },
  };
}

// ---------- browser side of the handlers' dependencies ----------

/** `bf:settings`, with defaults (outside control off). */
export async function loadBridgeSettings(): Promise<BridgeSettings> {
  const stored = await browser.storage.local.get(BRIDGE_STORAGE_KEYS.settings);
  const value = stored[BRIDGE_STORAGE_KEYS.settings] as Partial<BridgeSettings> | undefined;
  return { outsideControl: value?.outsideControl === true };
}

/** True when the optional `nativeMessaging` permission is granted (always, in e2e/automation builds). */
export async function hasNativeMessaging(): Promise<boolean> {
  try {
    return await browser.permissions.contains({ permissions: ['nativeMessaging'] });
  } catch {
    return false;
  }
}

let logQueue: Promise<void> = Promise.resolve();

/** Appends to `bf:bridge-log` (serialised, newest last, capped at MAX_BRIDGE_LOG). Never rejects. */
export function appendBridgeLog(entry: BridgeLogEntry): Promise<void> {
  logQueue = logQueue
    .then(async () => {
      const stored = await browser.storage.local.get(BRIDGE_STORAGE_KEYS.log);
      const list = stored[BRIDGE_STORAGE_KEYS.log];
      await browser.storage.local.set({ [BRIDGE_STORAGE_KEYS.log]: boundedLog(Array.isArray(list) ? (list as BridgeLogEntry[]) : [], entry) });
    })
    .catch(() => {});
  return logQueue;
}

/** Writes `bf:bridge-status` to storage.session (where available). Never rejects. */
export function writeBridgeStatus(status: BridgeStatus): void {
  void Promise.resolve()
    .then(() => browser.storage.session.set({ [BRIDGE_STATUS_KEY]: status }))
    .catch(() => {});
}

/** `setTimeout` for the bridge's own timers (reconnect backoff, run timeouts): not workflow timing. */
export function after(ms: number, fn: () => void): () => void {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}

const SNAPSHOT_TIMEOUT_MS = 15_000;

/**
 * `snapshot`: the M1.3 page outline (`snapshot` page op) of an existing tab, or of `url` opened in a
 * background tab that is closed afterwards (marked as BlockFlow's own, so Page Visited ignores it).
 */
export async function bridgeSnapshot(params: { url?: string; tabId?: number }): Promise<{ url: string; title: string; outline: string }> {
  const read = async (tabId: number) => {
    const result = (await actInTab(tabId, { op: 'snapshot' }, SNAPSHOT_TIMEOUT_MS)) as unknown as SnapshotResult;
    return { url: result.url, title: result.title, outline: snapshotDocument(result) };
  };
  if (params.tabId !== undefined) {
    const exists = await browser.tabs.get(params.tabId).then(
      () => true,
      () => false,
    );
    if (!exists) throw new BridgeRpcError(RPC_ERRORS.notFound, `No tab has the id ${params.tabId}.`);
    return read(params.tabId);
  }
  const url = normalizeHttpUrl(params.url ?? '');
  if (!url) throw new BridgeRpcError(RPC_ERRORS.invalidParams, `"${params.url ?? ''}" is not a web address.`);
  const tabId = requireTabId(await browser.tabs.create({ url, active: false }));
  try {
    await addOwnTab(tabId);
    await waitForTabComplete(tabId);
    return await read(tabId);
  } finally {
    await browser.tabs.remove(tabId).catch(() => {});
  }
}

/** Opens the native port. `runtime.connectNative` exists only once `nativeMessaging` is granted. */
export function connectNativeHost(): NativePort {
  const connect = (browser.runtime as unknown as { connectNative?: (name: string) => NativePort }).connectNative;
  if (typeof connect !== 'function') throw new Error('The nativeMessaging permission is not granted.');
  return connect(NATIVE_HOST_NAME);
}

/** Chrome reports why a port closed in `runtime.lastError`, Firefox in `port.error`. */
export function nativeDisconnectReason(port: unknown): string | undefined {
  const fromPort = (port as { error?: { message?: string } } | undefined)?.error?.message;
  const fromRuntime = (browser.runtime as unknown as { lastError?: { message?: string } }).lastError?.message;
  return fromPort ?? fromRuntime;
}
