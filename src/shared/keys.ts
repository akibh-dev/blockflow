/** Keys used in browser.storage.local. */
export const STORAGE_KEYS = {
  workflows: 'bf:workflows',
  logs: 'bf:logs',
  runs: 'bf:runs',
  pendingPick: 'bf:pending-pick',
  watchTabs: 'bf:watch-tabs',
  timerPrefix: 'bf:timer:',
  statePrefix: 'bf:state:',
} as const;

export const MAX_LOG_ENTRIES = 300;
/** Run history kept in storage, newest last. */
export const MAX_RUNS = 40;
