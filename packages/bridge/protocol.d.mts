// Types for protocol.mjs (the runtime mirror of src/core/bridgeProtocol.ts).
export declare const BRIDGE_PROTOCOL_VERSION: 1;
export declare const NATIVE_HOST_NAME: 'dev.akibh.blockflow';
export declare const MAX_MESSAGE_BYTES: number;
export declare const BLOB_CHUNK_BYTES: number;
export declare const INLINE_RESULT_BYTES: number;
export declare const RPC_ERRORS: Readonly<{
  parse: -32700;
  invalidRequest: -32600;
  methodNotFound: -32601;
  invalidParams: -32602;
  internal: -32603;
  unauthorized: -32001;
  disabled: -32002;
  tooLarge: -32003;
  notFound: -32004;
  invalidWorkflow: -32005;
  notConnected: -32006;
  version: -32007;
}>;
export declare const BRIDGE_METHODS: readonly string[];
export declare const BRIDGE_NOTIFICATIONS: readonly string[];
