/**
 * M4 outside-access protocol: JSON-RPC 2.0 shared by the extension (`src/browser/bridge.ts`), the native
 * host (`packages/bridge`), the MCP server (`packages/mcp`) and the CLI (`packages/cli`).
 *
 *   client ──NDJSON over local socket (auth first)──▶ native host ──native messaging (4-byte LE length + JSON)──▶ extension
 *
 * Pure data, no browser or Node APIs. The Node packages are plain `.mjs`; they mirror the constants in
 * `packages/bridge/protocol.mjs`, and `tests/bridge/protocol.test.ts` keeps the two in sync.
 */
import type { Issue } from './issues';
import type { RunRecord, StepRecord } from './runs';

export const BRIDGE_PROTOCOL_VERSION = 1;
/** Native messaging host name (`runtime.connectNative`), also the host manifest's `name`. */
export const NATIVE_HOST_NAME = 'dev.akibh.blockflow';
/** Chrome's limit for host → extension messages is 1 MB; we use it in both directions. */
export const MAX_MESSAGE_BYTES = 1_000_000;
/** Raw bytes per `blob.get` chunk (base64 in the message, so ~700 KB on the wire). */
export const BLOB_CHUNK_BYTES = 512 * 1024;
/** Results larger than this are returned as `{ blobId, size }` instead of inline. */
export const INLINE_RESULT_BYTES = 768 * 1024;

/** Storage keys owned by M4 (documented in docs/wiki/Storage-Keys.md). */
export const BRIDGE_STORAGE_KEYS = {
  /** `BridgeSettings`. */
  settings: 'bf:settings',
  /** `BridgeLogEntry[]`, newest last, at most `MAX_BRIDGE_LOG` entries. */
  log: 'bf:bridge-log',
  /** `Suite[]`. */
  suites: 'bf:suites',
} as const;
export const MAX_BRIDGE_LOG = 200;

export interface BridgeSettings {
  /** "Allow outside control": off by default. While on, the worker keeps the native port open. */
  outsideControl: boolean;
}

export interface BridgeLogEntry {
  at: string;
  method: string;
  ok: boolean;
  /** Short human summary: workflow name, run id, error message. Never secrets. */
  detail?: string;
}

// ---------- JSON-RPC envelope ----------

export type RpcId = number | string;
export interface RpcRequest<M extends BridgeMethod = BridgeMethod> {
  jsonrpc: '2.0';
  id: RpcId;
  method: M;
  params: BridgeParams[M];
}
export interface RpcSuccess<M extends BridgeMethod = BridgeMethod> { jsonrpc: '2.0'; id: RpcId; result: BridgeResults[M] }
export interface RpcFailure { jsonrpc: '2.0'; id: RpcId | null; error: RpcError }
export type RpcResponse = RpcSuccess | RpcFailure;
export interface RpcNotification<N extends BridgeNotificationName = BridgeNotificationName> {
  jsonrpc: '2.0';
  method: N;
  params: BridgeNotifications[N];
}
export interface RpcError {
  code: number;
  message: string;
  /** BlockFlow error code (`src/core/errors.ts`) when the failure came from the engine or a block. */
  data?: { code?: string; [key: string]: unknown };
}

/** Standard JSON-RPC codes plus BlockFlow's range (-32000 … -32099). */
export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** Socket client did not send a valid `auth` first. Host only. */
  unauthorized: -32001,
  /** The extension's "Allow outside control" is off (or the extension is not connected). */
  disabled: -32002,
  /** Message over `MAX_MESSAGE_BYTES`. */
  tooLarge: -32003,
  /** Unknown workflow, run, suite, blob or tab. */
  notFound: -32004,
  /** The workflow / script did not validate; `data.issues` has the issues. */
  invalidWorkflow: -32005,
  /** The extension is not connected to the native host. Host only. */
  notConnected: -32006,
  /** Protocol version mismatch. */
  version: -32007,
} as const;

// ---------- methods ----------

/** A workflow source: a script (`blockflow-script`), a graph file (`blockflow-workflows`) or one workflow, as JSON text or parsed. */
export type WorkflowSource = unknown;

export interface WorkflowSummary { id: string; name: string; enabled: boolean; viaBridge?: boolean }

export interface BridgeParams {
  /** Socket only (handled by the native host, never forwarded): must be the first message. */
  auth: { token: string; protocol: number; client?: string };
  /** Handshake with the extension. */
  hello: { protocol: number; client?: string };
  validate: { source: WorkflowSource };
  /** Imports into the editor's workflow list, tagged "via bridge". `replace`: replace a bridge workflow of the same name. */
  import: { source: WorkflowSource; replace?: boolean };
  list: Record<string, never>;
  /**
   * Run a saved workflow (`workflowId`) or an inline source (not saved). Resolves when the run finishes.
   * While it runs, the extension sends `run.started` and `run.step` notifications carrying this request's id.
   * `secrets` overlay the stored secrets for this run only and are never stored.
   */
  run: { workflowId?: string; source?: WorkflowSource; secrets?: Record<string, string>; timeoutSeconds?: number };
  report: { runIds?: string[]; workflowId?: string; limit?: number; format: 'json' | 'junit' | 'html' };
  /** Page outline (M1.3 snapshot) of a URL (opened in a background tab, then closed) or an existing tab. */
  snapshot: { url?: string; tabId?: number };
  stop: { runId: string };
  /**
   * One chunk of a large result (`BlobRef.blobId`) or of a step screenshot: `screenshot:<StepRecord.screenshot>`
   * returns the image bytes (`mime` set). Result blobs expire 10 minutes after their last read.
   */
  'blob.get': { blobId: string; offset: number };
  'suite.list': Record<string, never>;
  /** Run a saved suite (`suiteId` or `name`) or an inline one (`suite`). */
  'suite.run': { suiteId?: string; name?: string; suite?: SuiteInput; secrets?: Record<string, string>; formats?: ('json' | 'junit' | 'html')[] };
}

export interface BridgeResults {
  auth: { ok: true; extensionConnected: boolean };
  hello: { protocol: number; extensionVersion: string; browser: string; extensionId: string };
  validate: { ok: boolean; issues: Issue[]; workflows: { name: string; nodes: number }[] };
  import: { workflows: WorkflowSummary[]; issues: Issue[] };
  list: { workflows: WorkflowSummary[] };
  run: { run: RunRecord } | BlobRef;
  report: { format: 'json' | 'junit' | 'html'; content: string } | BlobRef;
  snapshot: { url: string; title: string; outline: string } | BlobRef;
  stop: { stopped: boolean };
  'blob.get': { data: string; offset: number; size: number; done: boolean; mime?: string };
  'suite.list': { suites: Suite[] };
  /** `reports`: the combined reports asked for in `formats` (JUnit: one testcase per workflow). */
  'suite.run': { result: SuiteResult; reports?: Partial<Record<'json' | 'junit' | 'html', string>> } | BlobRef;
}

/** A large result, fetched with repeated `blob.get` calls; the concatenated bytes are the UTF-8 JSON of the real result. */
export interface BlobRef { blobId: string; size: number }

export type BridgeMethod = keyof BridgeParams;

export interface BridgeNotifications {
  /** `requestId` = id of the `run` / `suite.run` request (as the extension received it). */
  'run.started': { requestId: RpcId; runId: string; workflowName: string };
  'run.step': { requestId: RpcId; runId: string; step: StepRecord };
  /** One workflow of a `suite.run` finished. */
  'suite.progress': { requestId: RpcId; index: number; total: number; workflowName: string; status: string };
  /** Extension → host: outside control was switched off; the host closes client connections. */
  'bridge.disabled': Record<string, never>;
}
export type BridgeNotificationName = keyof BridgeNotifications;

// ---------- suites (M4.4) ----------

export interface Suite {
  id: string;
  name: string;
  /** Saved workflow ids, run in this order. */
  workflowIds: string[];
  /** Stop at the first failed workflow (the rest are reported as skipped). Default false. */
  stopOnFailure?: boolean;
}
export interface SuiteInput { name: string; workflowIds?: string[]; sources?: WorkflowSource[]; stopOnFailure?: boolean }
export interface SuiteResult {
  suiteId?: string;
  name: string;
  status: 'passed' | 'failed';
  startedAt: string;
  finishedAt: string;
  runs: RunRecord[];
  /** Names of workflows not run because of `stopOnFailure`. */
  skipped: string[];
}

// ---------- paths (Node side; documented here so every package agrees) ----------
//
// Socket:  $BLOCKFLOW_SOCKET, else $XDG_RUNTIME_DIR/blockflow.sock, else ~/.config/blockflow/blockflow.sock;
//          Windows: \\.\pipe\blockflow-<username>. Mode 0600 (unix).
// Token:   $BLOCKFLOW_TOKEN_FILE, else ~/.config/blockflow/token (0600, 32 random bytes hex, created by the host if missing).
// The browser launches the host with its own environment, so the CLI sets BLOCKFLOW_SOCKET / BLOCKFLOW_TOKEN_FILE
// on the browser process to get a private socket for its own profile.
