import type { CdpListener, CdpSend } from './cdpSessions';

/** Injected by the per-run Host. Features never attach/detach the browser independently. */
export interface M3Runtime {
  runId: string;
  withTab<T>(tabId: number, fn: (send: CdpSend) => Promise<T>): Promise<T>;
  /** Cleanup can reset existing overrides while ordinary callbacks are fenced off. */
  cleanupTab<T>(tabId: number, fn: (send: CdpSend) => Promise<T>): Promise<T>;
  subscribe(tabId: number, listener: CdpListener): () => void;
  isClosed(): boolean;
  /** Mutable state on a shared browser tab may only belong to one run at a time. */
  claim(tabId: number, feature: 'route' | 'emulation'): void;
}
