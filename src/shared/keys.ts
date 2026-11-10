/** Keys used in browser.storage.local. */
export const STORAGE_KEYS = {
  /** `Workflow[]`: every saved workflow. Written by the editor (autosave), read by the worker (onChanged → diffWorkflows). */
  workflows: 'bf:workflows',
  /** `LogEntry[]`: run log, newest last, capped at MAX_LOG_ENTRIES (stores.ts `appendLog`). */
  logs: 'bf:logs',
  /** `RunRecord[]`: run history, newest last, capped at MAX_RUNS (stores.ts `saveRun` / `updateRuns`). */
  runs: 'bf:runs',
  /** `Record<string, string>`: named secrets for `{{secret.x}}`. Written by the editor's Secrets page. */
  secrets: 'bf:secrets',
  /** `PendingPrompt[]`: Manual Steps waiting for an answer (prompts.ts), shown as the editor's banner. */
  prompts: 'bf:prompts',
  /** `RecordingState`: the one recording in progress or just stopped (recording.ts); the editor removes it after converting. */
  recording: 'bf:recording',
  /** `{ editorTabId, mode }`: the pick in progress, so the result can return to the editor tab (picking.ts). */
  pendingPick: 'bf:pending-pick',
  /** `Record<url, tabId>`: background tabs BlockFlow opened per watched URL (pageReader.ts). */
  watchTabs: 'bf:watch-tabs',
  /** `OnboardingState`: first-run hints the user closed (the editor's "Try it" card). Editor only. */
  onboarding: 'bf:onboarding',
  /** Prefix of `StoredTimer` records, one per scheduled timer: `bf:timer:<timer key>` (scheduler.ts). */
  timerPrefix: 'bf:timer:',
  /** Prefix of block state (`ctx.state`): `bf:state:<workflowId>::<nodeId>::<key>` (host.ts `StorageState`). */
  statePrefix: 'bf:state:',
  /** `BridgeSettings` (`src/core/bridgeProtocol.ts`): "Allow outside control". Editor Settings page writes it; the worker reacts. */
  settings: 'bf:settings',
  /** `BridgeLogEntry[]`: every outside (bridge) request, newest last, capped at MAX_BRIDGE_LOG. Worker writes. */
  bridgeLog: 'bf:bridge-log',
  /** `Suite[]`: named, ordered lists of workflows (M4.4). Editor Suites page writes it. */
  suites: 'bf:suites',
} as const;

/** Log lines kept in `bf:logs`; older ones are dropped on append. */
export const MAX_LOG_ENTRIES = 300;
/** Run history kept in storage, newest last. */
export const MAX_RUNS = 40;
