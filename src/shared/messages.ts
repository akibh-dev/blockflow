import type { FormFieldRow } from '../core/page';
import type { Workflow } from '../core/types';

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
  /** form: pick any element of a form, and get all of the form's fields back (Fill Form). */
  mode?: 'element' | 'form';
}

/** Picker → background. */
export interface PickedMessage {
  type: 'bf:picked';
  selector: string;
  url: string;
  sample: string;
}

/** Picker → background. */
export interface PickCancelledMessage {
  type: 'bf:pick-cancelled';
}

/** Background → editor. */
export interface PickResultMessage {
  type: 'bf:pick-result';
  selector: string;
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

/** Editor → background: run this workflow once, now (the Run button). Sends what is on the canvas. */
export interface RunWorkflowMessage {
  type: 'bf:run-workflow';
  workflow: Workflow;
}

/** Editor → background: the Stop button. */
export interface StopRunMessage {
  type: 'bf:stop-run';
  runId: string;
}

export type ExtensionMessage =
  | StartPickMessage
  | PickedMessage
  | PickCancelledMessage
  | PickResultMessage
  | PickErrorMessage
  | RunWorkflowMessage
  | StopRunMessage;

const TYPES = new Set<string>([
  'bf:start-pick',
  'bf:picked',
  'bf:pick-cancelled',
  'bf:pick-result',
  'bf:pick-error',
  'bf:run-workflow',
  'bf:stop-run',
]);

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && TYPES.has(type);
}
