export declare const NOT_REACHABLE: string;
export declare class BridgeError extends Error {
  constructor(code: number, message: string, data?: { code?: string; [key: string]: unknown });
  /** JSON-RPC error code (RPC_ERRORS). */
  code: number;
  data?: { code?: string; [key: string]: unknown };
}
export type Notification = { jsonrpc: '2.0'; method: string; params: any };
export type CallOptions = { onNotification?: (notification: Notification) => void; timeoutMs?: number };
export type BridgeConnection = {
  call(method: string, params?: unknown, options?: CallOptions): Promise<any>;
  close(): void;
  extensionConnected: boolean;
  /** Resolves when the socket closes. */
  closed: Promise<void>;
};
export declare function connectBridge(options?: {
  socketPath?: string;
  tokenFile?: string;
  client?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}): Promise<BridgeConnection>;
