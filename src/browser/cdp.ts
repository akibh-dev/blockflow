import { browser } from 'wxt/browser';
import { CodedError } from '../core/errors';

/**
 * Real mouse and keyboard input through the Chrome DevTools Protocol (`debugger` API, optional
 * permission, Chromium only). Events made this way are `isTrusted: true`, which some sites require.
 * The browser shows "BlockFlow started debugging this browser" while attached, so each action
 * attaches and detaches again.
 */

/** Sends one CDP command to the attached tab. */
type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/** True if the optional "debugger" permission is granted (false where the API does not exist). */
export async function hasDebugger(): Promise<boolean> {
  try {
    return await browser.permissions.contains({ permissions: ['debugger'] });
  } catch {
    return false;
  }
}

/**
 * Attaches the debugger to `tabId` (protocol 1.3), runs `fn`, and always detaches. Throws a readable
 * error when the permission is missing.
 */
export async function withDebugger<T>(tabId: number, fn: (send: Send) => Promise<T>): Promise<T> {
  if (!(await hasDebugger()) || !browser.debugger) {
    throw new CodedError(
      'permission.missing',
      'Real input needs the "debugger" permission (Chrome, Edge, Brave). Tick "Use real mouse and keyboard" in the step settings again to grant it.',
    );
  }
  const target = { tabId };
  try {
    await browser.debugger.attach(target, '1.3');
  } catch (error) {
    // Already attached by an earlier action that did not finish: reuse it.
    if (!String(error).includes('already attached')) throw error;
  }
  try {
    return await fn((method, params) => browser.debugger.sendCommand(target, method, params));
  } finally {
    await browser.debugger.detach(target).catch(() => {});
  }
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

/**
 * Moves the mouse to (x, y) in CSS pixels of the viewport, then presses and releases `clicks` times
 * (clickCount increases, so 2 is a double click). `hoverOnly` stops after the move.
 */
export async function mouseClick(send: Send, x: number, y: number, options: { button?: 'left' | 'right'; clicks?: number; hoverOnly?: boolean } = {}): Promise<void> {
  const button = options.button ?? 'left';
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  if (options.hoverOnly) return;
  for (let click = 1; click <= (options.clicks ?? 1); click += 1) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: click });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: click });
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
export async function captureWithDebugger(tabId: number): Promise<string | null> {
  if (!(await hasDebugger())) return null;
  return withDebugger(tabId, async (send) => {
    // A background tab may not paint: give it 4 s, then go without a screenshot.
    const shot = (await Promise.race([
      send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }),
      new Promise((resolve) => setTimeout(() => resolve({}), 4_000)),
    ])) as { data?: string };
    return shot.data ? `data:image/jpeg;base64,${shot.data}` : null;
  });
}
