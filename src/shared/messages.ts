import type { FormFieldRow } from '../core/page';
import type { RecordedStep } from '../core/recording';
import type { PickerMode, PickerSync } from '../dom/picker';
import type { RecorderMode } from '../dom/recorder';
import type { Workflow } from '../core/types';
import type { SuiteResult } from '../core/bridgeProtocol';
import type { RunOptions } from '../core/runs';

/**
 * Messages between the editor page, the background worker and the element picker.
 *
 *   editor ──start-pick──▶ background ──(opens page, injects picker)──▶ picker
 *   picker ──picked──────▶ background ──pick-result──▶ editor
 *   editor ──run-workflow / stop-run──▶ background (progress comes back through storage: bf:runs)
 */

/** Editor → background: let the user pick an element. `url` is the page to open first (optional). */
export interface StartPickMessage {
  type: 'bf:start-pick';
  url?: string;
  /**
   * block: the block's own URL setting (the picker tab is sent there unless it already shows it).
   * upstream: the URL of an Open Tab before the block, a hint (the picker tab only moves when it shows another site).
   */
  urlFrom?: 'block' | 'upstream';
  /** watch / action: pick one element (changes the hint); form: pick any element of a form, and get all of the form's fields back (Fill Form). */
  mode?: PickerMode;
}

/**
 * Picker → background. Picked inside a frame, the locators already start with `frame=… >> ` and
 * `url` is the frame's; the background replaces it with the tab's.
 */
export interface PickedMessage {
  type: 'bf:picked';
  selector: string;
  candidates?: string[];
  url: string;
  sample: string;
}

/** Picker in one frame → background → the pickers in every frame of that tab (see `PickerSync`). */
export interface PickerSyncMessage {
  type: 'bf:picker-sync';
  sync: PickerSync;
}

/** Recorder in one frame → background → the recorders in every frame of that tab: the toolbar's mode. */
export interface RecorderSyncMessage {
  type: 'bf:recorder-sync';
  mode: RecorderMode;
}

/** Picker → background. */
export interface PickCancelledMessage {
  type: 'bf:pick-cancelled';
}

/** Background → editor. */
export interface PickResultMessage {
  type: 'bf:pick-result';
  selector: string;
  /** Other locators for the same element, best first. */
  candidates?: string[];
  url: string;
  sample: string;
  /** For mode "form": the form's fields. */
  fields?: FormFieldRow[];
}

/** Background → editor: picking could not start (restricted page, no tab...). */
export interface PickErrorMessage {
  type: 'bf:pick-error';
  message: string;
}

/**
 * Editor → background: the "📸 Snapshot page" button (Open Tab). Opens or reuses the editor's picker tab
 * on `url` (or the last-used web tab without one), runs the `snapshot` page op there and answers with
 * `bf:snapshot-result`.
 */
export interface SnapshotPageMessage {
  type: 'bf:snapshot-page';
  url?: string;
}

/** Background → editor: the snapshot as text to copy (see `snapshotDocument` in core/page.ts), or why it failed. */
export interface SnapshotResultMessage {
  type: 'bf:snapshot-result';
  /** Set on success. */
  text?: string;
  lines?: number;
  truncated?: boolean;
  /** Set on failure. */
  error?: string;
}

/** Editor → background: run this workflow once, now (the Run button). Sends what is on the canvas. */
export interface RunWorkflowMessage {
  type: 'bf:run-workflow';
  workflow: Workflow;
  /** M5: traced run, debug run (breakpoints), or Run from here (`startAt`). */
  options?: RunOptions;
}

/** Editor → background: the Stop button. */
export interface StopRunMessage {
  type: 'bf:stop-run';
  runId: string;
}

/** Editor → background: answer a Manual Step. */
export interface AnswerPromptMessage {
  type: 'bf:answer-prompt';
  runId: string;
  ok: boolean;
}

/** Editor → background: record what the user does on `url`, for this workflow. */
export interface StartRecordingMessage {
  type: 'bf:start-recording';
  workflowId: string;
  url: string;
}

/** Editor or the recorder's toolbar → background. */
export interface StopRecordingMessage {
  type: 'bf:stop-recording';
}

/** Recorder → background: one thing the user did. */
export interface RecordedMessage {
  type: 'bf:recorded';
  step: RecordedStep;
}

/**
 * Editor → background: run the saved suite `suiteId` (Suites page). The background runs it with
 * `runSuite` (src/browser/suites.ts) and answers with `bf:suite-progress` after each workflow and one
 * `bf:suite-result` at the end (runtime broadcasts, like `bf:snapshot-result`).
 */
export interface RunSuiteMessage {
  type: 'bf:run-suite';
  suiteId: string;
}

/** Background → editor: one workflow of a suite finished (`status` is the run's, or `skipped`). */
export interface SuiteProgressMessage {
  type: 'bf:suite-progress';
  suiteId: string;
  index: number;
  total: number;
  workflowName: string;
  status: string;
}

/** Background → editor: the suite finished (`result`) or could not run (`error`, e.g. an unknown workflow). */
export interface SuiteResultMessage {
  type: 'bf:suite-result';
  suiteId: string;
  result?: SuiteResult;
  error?: string;
}

/** Every message in this file. Messages not listed here (`bf:parse-html`) are ignored by `isExtensionMessage`. */
export type ExtensionMessage =
  | StartPickMessage
  | PickedMessage
  | PickCancelledMessage
  | PickResultMessage
  | PickErrorMessage
  | RunWorkflowMessage
  | StopRunMessage
  | AnswerPromptMessage
  | StartRecordingMessage
  | StopRecordingMessage
  | RecordedMessage
  | PickerSyncMessage
  | RecorderSyncMessage
  | SnapshotPageMessage
  | SnapshotResultMessage
  | RunSuiteMessage
  | SuiteProgressMessage
  | SuiteResultMessage;

/** Runtime list of the `type` values above; keep it in sync with `ExtensionMessage`. */
const TYPES = new Set<string>([
  'bf:start-pick',
  'bf:picked',
  'bf:pick-cancelled',
  'bf:pick-result',
  'bf:pick-error',
  'bf:run-workflow',
  'bf:stop-run',
  'bf:answer-prompt',
  'bf:start-recording',
  'bf:stop-recording',
  'bf:recorded',
  'bf:picker-sync',
  'bf:recorder-sync',
  'bf:snapshot-page',
  'bf:snapshot-result',
  'bf:run-suite',
  'bf:suite-progress',
  'bf:suite-result',
]);

/**
 * Type guard for `runtime.onMessage` listeners: true for an object whose `type` is one of ours.
 * Checks only the `type`, not the payload's shape.
 */
export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && TYPES.has(type);
}
