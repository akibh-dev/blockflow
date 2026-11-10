/**
 * The bridge connection state the worker shows the editor's Settings page (M4). Its own module, so the
 * editor can read it without loading the worker side (`bridge.ts`).
 */

/** storage.session key: `BridgeStatus`, written by the worker, shown by the Settings page. */
export const BRIDGE_STATUS_KEY = 'bf:bridge-status';

/** waiting: reconnecting after a close; failed: gave up after MAX_RECONNECTS closes in a row (switch off and on to retry). */
export type BridgeState = 'off' | 'connecting' | 'connected' | 'waiting' | 'failed';

export interface BridgeStatus {
  state: BridgeState;
  /** ISO time of the last change. */
  since: string;
  /** Why the last connection closed (the browser's message, e.g. "Specified native messaging host not found."). */
  error?: string;
  /** Failed connections in a row (reconnect backoff). */
  attempts?: number;
}
