import { browser } from 'wxt/browser';
import { CodedError } from '../core/errors';
import { DebuggerSessions } from './cdpSessions';
import type { CdpListener, CdpSend } from './cdpSessions';

/**
 * Real mouse and keyboard input through the Chrome DevTools Protocol (`debugger` API, optional
 * permission, Chromium only). Events made this way are `isTrusted: true`, which some sites require.
 * The browser shows "BlockFlow started debugging this browser" while attached. Runs retain one
 * attachment per tab; calls outside a run attach only for the action. Shared leases prevent one
 * operation from detaching another's session.
 */

/** Sends one CDP command to the attached tab. */
type Send = CdpSend;

/** True if the optional "debugger" permission is granted (false where the API does not exist). */
export async function hasDebugger(): Promise<boolean> {
  try {
    return Boolean(browser.debugger) && await browser.permissions.contains({ permissions: ['debugger'] });
  } catch {
    return false;
  }
}

/** API-initiated detach does not emit onDetach; detect that transport failure too. */
const isDetachedError = (error: unknown) => /debugger is not attached|no tab with (?:given )?id|no target with given id|target closed/i.test(String(error));

const sessions = new DebuggerSessions({
  available: hasDebugger,
  attach: (tabId) => browser.debugger.attach({ tabId }, '1.3'),
  detach: async (tabId) => {
    try { await browser.debugger.detach({ tabId }); }
    catch (error) { if (!isDetachedError(error)) throw error; }
  },
  send: async (tabId, method, params) => {
    try { return await browser.debugger.sendCommand({ tabId }, method, params); }
    catch (error) {
      if (!isDetachedError(error)) throw error;
      sessions.detached(tabId);
      throw new CodedError('step.failed', 'The debugger was detached or the tab closed. Run the workflow again; do not close the debugging bar during a run.');
    }
  },
});

let listening = false;
let debuggerApi: typeof browser.debugger | undefined;
function listenToDebugger(): void {
  const api = browser.debugger;
  // Optional API namespaces may appear only after their permission is granted.
  if (!api || debuggerApi === api) return;
  debuggerApi = api;
  api.onDetach.addListener((source) => {
    if (source.tabId !== undefined) sessions.detached(source.tabId);
  });
  api.onEvent.addListener((source, method, params) => {
    if (source.tabId !== undefined) sessions.event(source.tabId, method, params);
  });
}

/** Called synchronously from defineBackground: MV3 listeners must exist before the worker idles. */
export function initialiseDebuggerSessions(): void {
  if (listening) return;
  listening = true;
  browser.tabs.onRemoved.addListener((tabId) => sessions.detached(tabId));
  browser.permissions.onAdded.addListener(listenToDebugger);
  browser.permissions.onRemoved.addListener((permissions) => {
    if (permissions.permissions?.includes('debugger')) sessions.invalidateAll();
  });
  listenToDebugger();
}

export const startDebuggerRun = (runId: string, setup?: (tabId: number, send: CdpSend) => Promise<void>): void => sessions.startRun(runId, setup);
export const finishDebuggerRun = (runId: string): Promise<{ usedDebugger?: boolean }> => sessions.finishRun(runId);

/** Subscribe inside a withDebugger callback; the browser listener itself is registered at startup. */
export const onDebuggerEvent = (tabId: number, listener: CdpListener): (() => void) => sessions.subscribe(tabId, listener);

/** A scoped action shares its run's attachment; an unscoped action releases its lease in finally. */
export function withDebugger<T>(tabId: number, fn: (send: Send) => Promise<T>, runId?: string): Promise<T> {
  return sessions.withSession(tabId, fn, runId);
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
};

const MODIFIERS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

/** CDP `modifiers` bit mask for Playwright modifier names (Alt 1, Control 2, Meta 4, Shift 8). */
export function modifierMask(modifiers: readonly string[] = []): number {
  return modifiers.reduce((sum, name) => sum | (MODIFIERS[name.toLowerCase()] ?? 0), 0);
}

/** CDP `buttons` bit of a pressed button. */
const BUTTON_BITS = { left: 1, right: 2, middle: 4 } as const;

/**
 * Moves the mouse to (x, y) in CSS pixels of the viewport, then presses and releases `clicks` times
 * (clickCount increases, so 2 is a double click). `hoverOnly` stops after the move. `modifiers` are
 * held throughout (Alt, Control, Meta, Shift).
 */
export async function mouseClick(
  send: Send,
  x: number,
  y: number,
  options: { button?: 'left' | 'middle' | 'right'; clicks?: number; hoverOnly?: boolean; modifiers?: readonly string[] } = {},
): Promise<void> {
  const button = options.button ?? 'left';
  const modifiers = modifierMask(options.modifiers);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', modifiers });
  if (options.hoverOnly) return;
  for (let click = 1; click <= (options.clicks ?? 1); click += 1) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: BUTTON_BITS[button], clickCount: click, modifiers });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: click, modifiers });
  }
}

/** Modifier keys as CDP sends them: bit, key, code, Windows key code. */
const MODIFIER_KEYS = [
  { bit: 2, key: 'Control', code: 'ControlLeft', keyCode: 17 },
  { bit: 1, key: 'Alt', code: 'AltLeft', keyCode: 18 },
  { bit: 4, key: 'Meta', code: 'MetaLeft', keyCode: 91 },
  { bit: 8, key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
];

/** Mac keyboards use Meta (⌘) where others use Control: the target of `ControlOrMeta`. */
const isMac = () => /Mac/.test(globalThis.navigator?.platform ?? '');
/** Pointer moves between the two points of a real drag. */
const DRAG_STEPS = 5;
/** How long each early move waits for Chrome to report that a native (HTML5) drag started. */
const DRAG_START_WAIT_MS = 150;

/**
 * A real mouse drag from one point to another in the tab's viewport. Press at `from`, move in steps to
 * `to`, release. Native HTML5 drags are intercepted (`Input.setInterceptDrags`): when the page starts one,
 * Chrome reports its data (`Input.dragIntercepted`) and the rest goes through `Input.dispatchDragEvent`
 * (dragEnter, dragOver, drop), the way Playwright does it; without a native drag the moves stay plain
 * mouse moves with the left button held (sliders, pointer-based sortables). Returns which it was.
 */
export async function mouseDrag(tabId: number, from: { x: number; y: number }, to: { x: number; y: number }, options: { modifiers?: readonly string[]; runId?: string } = {}): Promise<'html5' | 'pointer'> {
  const modifiers = modifierMask(options.modifiers);
  let intercepted: unknown;
  let wake: (() => void) | undefined;
  const listener = (method: string, params?: object) => {
    if (method !== 'Input.dragIntercepted') return;
    intercepted = (params as { data?: unknown } | undefined)?.data;
    wake?.();
  };
  const waitForDrag = () =>
    intercepted !== undefined
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, DRAG_START_WAIT_MS);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
  return withDebugger(tabId, async (send) => {
    const unsubscribe = onDebuggerEvent(tabId, listener);
    try {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', modifiers });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, modifiers });
      const intercepting = await send('Input.setInterceptDrags', { enabled: true }).then(
        () => true,
        () => false,
      );
      let dragging = false;
      try {
        for (let step = 1; step <= DRAG_STEPS; step += 1) {
          const x = from.x + ((to.x - from.x) * step) / DRAG_STEPS;
          const y = from.y + ((to.y - from.y) * step) / DRAG_STEPS;
          if (dragging) {
            await send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data: intercepted, modifiers });
            continue;
          }
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, modifiers });
          if (intercepting) await waitForDrag();
          if (intercepted !== undefined) {
            dragging = true;
            await send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data: intercepted, modifiers });
            await send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data: intercepted, modifiers });
          }
        }
        // A native drag ends with the drop (Chrome then sends dragend); no mouse release, as in Playwright.
        if (dragging) await send('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data: intercepted, modifiers });
        else await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, modifiers });
      } finally {
        if (intercepting) await send('Input.setInterceptDrags', { enabled: false }).catch(() => {});
      }
      return dragging ? 'html5' : 'pointer';
    } finally {
      unsubscribe();
    }
  }, options.runId);
}

/**
 * Presses a key or combo like "Enter", "a", "Control+a", "Shift+Tab", "Control+Shift+K",
 * "ControlOrMeta+A" (Meta on a Mac, else Control). The modifier keys go down first and come up last,
 * as on a keyboard. Text is only sent without modifiers other than Shift; Shift+a types "A".
 */
export async function pressKey(send: Send, combo: string): Promise<void> {
  const parts = combo.split('+').map((part) => part.trim());
  const typed = parts.pop() || combo;
  const modifiers = parts.reduce((sum, part) => {
    const lower = part.toLowerCase();
    return sum | (lower === 'controlormeta' ? (isMac() ? 4 : 2) : (MODIFIERS[lower] ?? 0));
  }, 0);
  const name = modifiers & 8 && /^[a-z]$/.test(typed) ? typed.toUpperCase() : typed;
  const known = KEYS[name];
  const printable = !known && name.length === 1;
  const code = known?.code ?? (printable ? (/[a-z]/i.test(name) ? `Key${name.toUpperCase()}` : /\d/.test(name) ? `Digit${name}` : '') : name);
  const keyCode = known?.keyCode ?? (printable ? name.toUpperCase().charCodeAt(0) : 0);
  const text = (modifiers & ~8) === 0 ? (known?.text ?? (printable ? name : undefined)) : undefined;
  const held = MODIFIER_KEYS.filter((modifier) => modifiers & modifier.bit);
  let down = 0;
  for (const modifier of held) {
    down |= modifier.bit;
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.keyCode, modifiers: down });
  }
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: name, code, windowsVirtualKeyCode: keyCode, modifiers, ...(text ? { text } : {}) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: keyCode, modifiers });
  for (const modifier of [...held].reverse()) {
    down &= ~modifier.bit;
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.keyCode, modifiers: down });
  }
}

/** Text at the caret as one input, no key events (Playwright's `keyboard.insertText`). */
export async function insertText(send: Send, text: string): Promise<void> {
  if (text) await send('Input.insertText', { text });
}

/** Click into a field, select what is there, and type over it. */
export async function typeInto(send: Send, x: number, y: number, text: string): Promise<void> {
  await mouseClick(send, x, y);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, commands: ['selectAll'] });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  if (text) await send('Input.insertText', { text });
  else await pressKey(send, 'Backspace');
}

/** Screenshot of a tab even when it is not showing (debugger permission needed). */
export async function captureWithDebugger(tabId: number, runId?: string): Promise<string | null> {
  if (!(await hasDebugger())) return null;
  return withDebugger(tabId, async (send) => {
    // A background tab may not paint: give it 4 s, then go without a screenshot.
    const shot = (await Promise.race([
      send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }),
      new Promise((resolve) => setTimeout(() => resolve({}), 4_000)),
    ])) as { data?: string };
    return shot.data ? `data:image/jpeg;base64,${shot.data}` : null;
  }, runId);
}
