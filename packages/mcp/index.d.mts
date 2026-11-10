// Types for index.mjs (the package is plain ESM; these are for TypeScript users and the repo's tests).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface BridgeCallOptions {
  /** Receives each `run.*` / `suite.progress` notification for this call: `{ jsonrpc, method, params }`. */
  onNotification?: (notification: { jsonrpc?: '2.0'; method: string; params: any }) => void;
  /** 0 = no limit. */
  timeoutMs?: number;
}

/** What `connectBridge` from blockflow-bridge/client returns; a fake implements it in tests. */
export interface BridgeClient {
  call(method: string, params?: unknown, options?: BridgeCallOptions): Promise<any>;
  close(): void | Promise<void>;
  /** Resolves when the connection ends. */
  closed?: Promise<unknown>;
}

export interface BridgeSession {
  call(method: string, params?: unknown, options?: BridgeCallOptions): Promise<any>;
  close(): Promise<void>;
}

export interface BlockflowServerOptions {
  /** Opens a bridge connection (default: `connectBridge` from blockflow-bridge/client). Called lazily, again after a drop. */
  connect?: () => Promise<BridgeClient>;
  /** Where resources are looked up: `<packageDir>/resources/*` first, then the repo's docs. */
  resourceDirs?: { packageDir: string; repoDir: string };
}

export function createBlockflowServer(options?: BlockflowServerOptions): {
  server: McpServer;
  session: BridgeSession;
  close(): Promise<void>;
};

export function fetchBlob(session: Pick<BridgeSession, 'call'>, blobId: string): Promise<{ bytes: Buffer; mime?: string }>;
export function repairPrompt(url: string, goal: string): string;
export const INSTRUCTIONS: string;
export const VERSION: string;
/** The real connector: `connectBridge` from blockflow-bridge/client with these options (socket/token default from the environment). */
export function defaultConnector(options?: { socketPath?: string; tokenFile?: string; timeoutMs?: number }): () => Promise<BridgeClient>;
