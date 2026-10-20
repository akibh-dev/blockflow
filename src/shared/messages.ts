/**
 * Messages between the editor page, the background worker and the element picker.
 *
 *   editor ──start-pick──▶ background ──(opens page, injects picker)──▶ picker
 *   picker ──picked──────▶ background ──pick-result──▶ editor
 */

/** Editor → background: let the user pick an element. `url` is the page to open first (optional). */
export interface StartPickMessage {
  type: 'bf:start-pick';
  url?: string;
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
}

/** Background → editor: picking could not start (restricted page, no tab...). */
export interface PickErrorMessage {
  type: 'bf:pick-error';
  message: string;
}

export type ExtensionMessage =
  | StartPickMessage
  | PickedMessage
  | PickCancelledMessage
  | PickResultMessage
  | PickErrorMessage;

const TYPES = new Set<string>([
  'bf:start-pick',
  'bf:picked',
  'bf:pick-cancelled',
  'bf:pick-result',
  'bf:pick-error',
]);

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && TYPES.has(type);
}
