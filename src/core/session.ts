import type { Payload } from './types';

/**
 * A run's tabs, by name ("main", "popup"…), carried in the payload under `$session` so it
 * survives timers and worker restarts like any other data. Open Tab adds a tab; every page
 * block finds its tab here.
 */

/** Payload key holding the run's tabs. */
export const SESSION_KEY = '$session';
/** Tab name used when a block's Tab setting is empty. */
export const DEFAULT_TAB = 'main';

interface Session {
  tabs: Record<string, number>;
}

function readSession(payload: Payload): Session {
  const raw = payload[SESSION_KEY];
  if (raw && typeof raw === 'object' && 'tabs' in raw && raw.tabs && typeof raw.tabs === 'object') {
    return { tabs: { ...(raw.tabs as Record<string, number>) } };
  }
  return { tabs: {} };
}

/** Tab id stored under `name` (blank = `main`), or undefined. */
export function sessionTab(payload: Payload, name: string): number | undefined {
  const id = readSession(payload).tabs[name.trim() || DEFAULT_TAB];
  return typeof id === 'number' ? id : undefined;
}

/** Like `sessionTab`, but throws a user-facing error when the tab is not in the run. */
export function requireSessionTab(payload: Payload, name: string): number {
  const tab = name.trim() || DEFAULT_TAB;
  const id = sessionTab(payload, tab);
  if (id === undefined) {
    throw new Error(`No tab named "${tab}" in this run. Put an Open Tab block (tab name "${tab}") before this block.`);
  }
  return id;
}

/** Copy of `payload` with `tabId` stored under `name`. */
export function withSessionTab(payload: Payload, name: string, tabId: number): Payload {
  const session = readSession(payload);
  session.tabs[name.trim() || DEFAULT_TAB] = tabId;
  return { ...payload, [SESSION_KEY]: session };
}

/** Copy of `payload` without the tab `name` (Close Tab). */
export function withoutSessionTab(payload: Payload, name: string): Payload {
  const session = readSession(payload);
  delete session.tabs[name.trim() || DEFAULT_TAB];
  return { ...payload, [SESSION_KEY]: session };
}
