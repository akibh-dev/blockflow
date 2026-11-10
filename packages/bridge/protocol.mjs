// Mirror of the constants in src/core/bridgeProtocol.ts (the TypeScript source of truth for types).
// tests/bridge/protocol.test.ts fails if the two drift apart.
export const BRIDGE_PROTOCOL_VERSION = 1;
export const NATIVE_HOST_NAME = 'dev.akibh.blockflow';
export const MAX_MESSAGE_BYTES = 1_000_000;
export const BLOB_CHUNK_BYTES = 512 * 1024;
export const INLINE_RESULT_BYTES = 768 * 1024;
export const RPC_ERRORS = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unauthorized: -32001,
  disabled: -32002,
  tooLarge: -32003,
  notFound: -32004,
  invalidWorkflow: -32005,
  notConnected: -32006,
  version: -32007,
});
/** Methods a socket client may call (forwarded to the extension), plus `auth` (host only). */
export const BRIDGE_METHODS = Object.freeze(['auth', 'hello', 'validate', 'import', 'list', 'run', 'report', 'snapshot', 'stop', 'blob.get', 'suite.list', 'suite.run']);
export const BRIDGE_NOTIFICATIONS = Object.freeze(['run.started', 'run.step', 'suite.progress', 'bridge.disabled']);
