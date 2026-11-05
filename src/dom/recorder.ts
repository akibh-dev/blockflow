import { bestLocator } from './bestLocator';
import { accessibleName, checkedState } from './aria';
import { composedParent } from './selector';
import type { RecordedStep } from '../core/recording';

/**
 * The recorder: watches what the user does in a page and reports steps (click, fill, select,
 * check, Enter), plus "assert" steps picked from its toolbar. src/core/recording.ts turns the steps
 * into blocks. Runs inside pages: DOM only. Elements inside open shadow roots are recorded themselves
 * (through `composedPath()`), with `>>>` CSS when no readable locator finds them.
 */

/** Toolbar modes: record what the user does, or turn the next click into a check. */
export type RecorderMode = 'record' | 'assert-text' | 'assert-visible';

/** How the recorders in one tab's frames share the toolbar's mode (relayed by the background). */
export interface RecorderChannel {
  post(mode: RecorderMode): void;
  /** Returns a function that stops listening. */
  listen(handler: (mode: RecorderMode) => void): () => void;
}

/** Callbacks for {@link startRecorder}. */
export interface RecorderOptions {
  /** One user action, as soon as it is known (fills are reported when the field is left or Enter is pressed). */
  onStep(step: RecordedStep): void;
  /** The toolbar's Stop button. */
  onStop(): void;
  /** Defaults to the global document. Tests pass their own. */
  document?: Document;
  /** False inside iframes: only the top frame shows the toolbar. */
  toolbar?: boolean;
  /** Shares the assert mode with the other frames, so "Assert text" then a click inside a frame works. */
  channel?: RecorderChannel;
}

/** Returned by {@link startRecorder}. */
export interface RecorderHandle {
  /** Reports a pending fill, removes the listeners and the toolbar. Does not call onStop. */
  stop(): void;
}

const TOOLBAR = `
<style>
  :host { all: initial; }
  .bar { position: fixed; z-index: 2147483647; right: 16px; bottom: 16px; display: flex; gap: 6px; align-items: center;
    padding: 8px 10px; border-radius: 10px; background: #1b1e24; color: #fff; font: 13px system-ui, sans-serif;
    box-shadow: 0 6px 24px rgba(0,0,0,.35); }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #ef4444; animation: pulse 1.2s infinite; }
  @keyframes pulse { 50% { opacity: .35 } }
  button { font: inherit; color: #fff; background: #374151; border: 1px solid #4b5563; border-radius: 6px; padding: 4px 8px; cursor: pointer; }
  button.on { background: #2563eb; border-color: #2563eb; }
  button.stop { background: #b91c1c; border-color: #b91c1c; }
  .hint { color: #cbd5e1; }
</style>
<div class="bar" part="bar">
  <span class="dot"></span><span class="hint">Recording</span>
  <button data-act="assert-text" title="Next click: check this element's text instead of clicking it">Assert text</button>
  <button data-act="assert-visible" title="Next click: check this element is visible">Assert visible</button>
  <button data-act="stop" class="stop">Stop</button>
</div>`;

/** Input types recorded as `fill` (unlike the agent's TEXT_INPUTS, color and range are left out). */
const TEXT_TYPES = new Set(['', 'text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date', 'time', 'datetime-local', 'month', 'week']);
/** A click is recorded on the closest of these around the target, so a click on an icon inside a button records the button. */
const CLICKABLE = 'button, a, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], input[type="submit"], input[type="button"], input[type="image"], summary';

function isTextField(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  if (element.localName === 'textarea') return true;
  return element.localName === 'input' && TEXT_TYPES.has((element as HTMLInputElement).type);
}

/** `closest`, continuing from a shadow root to its host. */
function closestComposed(element: Element, selector: string): Element | null {
  for (let current: Element | null = element; current; current = composedParent(current)) {
    if (current.matches(selector)) return current;
  }
  return null;
}

/** The element the event really happened on: inside open shadow roots `event.target` is only the host. */
function targetOf(event: Event): Element | null {
  const target = event.composedPath()[0] ?? event.target;
  return target && (target as Node).nodeType === 1 ? (target as Element) : null;
}

/** What a password field is called (label, name, id, placeholder), for naming its secret. */
function fieldName(field: Element): string {
  return accessibleName(field) || field.getAttribute('name') || field.id || field.getAttribute('placeholder') || '';
}

/**
 * Starts recording `document`: adds the toolbar (`<blockflow-recorder>` with an open shadow root,
 * unless `toolbar: false`) and capture-phase click/input/change/keydown listeners on the window, plus
 * `pagehide` to flush typing. In record mode the page's events are not touched; in an assert mode the
 * next click is swallowed.
 */
export function startRecorder(options: RecorderOptions): RecorderHandle {
  const doc = options.document ?? document;
  const win = doc.defaultView as Window;
  let mode: RecorderMode = 'record';
  let pendingFill: HTMLInputElement | HTMLTextAreaElement | null = null;
  /** The value last recorded per field: input, change and blur can all report the same typing. */
  const recorded = new WeakMap<Element, string>();

  const host = options.toolbar === false ? null : doc.createElement('blockflow-recorder');
  const shadow = host?.attachShadow({ mode: 'open' });
  if (host && shadow) {
    shadow.innerHTML = TOOLBAR;
    doc.documentElement.append(host);
  }
  const buttons = Array.from(shadow?.querySelectorAll<HTMLButtonElement>('button') ?? []);

  const setMode = (next: RecorderMode, tellOthers = true) => {
    mode = next;
    for (const button of buttons) button.classList.toggle('on', button.dataset.act === next);
    const hint = shadow?.querySelector('.hint') as HTMLElement | null | undefined;
    if (hint) hint.textContent = next === 'record' ? 'Recording' : 'Click an element to check';
    if (tellOthers) options.channel?.post(next);
  };
  const unlisten = options.channel?.listen((next) => setMode(next, false));

  const fromToolbar = (event: Event) => !!host && event.composedPath().includes(host);

  /** Reports the field being typed in as one `fill` step, unless that value was already reported. Passwords are sent empty with `secret: true`. */
  const flushFill = () => {
    if (!pendingFill) return;
    const field = pendingFill;
    pendingFill = null;
    if (recorded.get(field) === field.value) return;
    recorded.set(field, field.value);
    const secret = field.localName === 'input' && field.type === 'password';
    options.onStep({
      kind: 'fill',
      locator: bestLocator(field),
      value: secret ? '' : field.value,
      ...(secret ? { secret: true, field: fieldName(field) } : {}),
    });
  };

  const onClick = (event: Event) => {
    if (fromToolbar(event)) return;
    const target = targetOf(event);
    if (!target) return;
    if (mode !== 'record') {
      event.preventDefault();
      event.stopImmediatePropagation();
      const element = closestComposed(target, CLICKABLE) ?? target;
      const locator = bestLocator(element);
      if (mode === 'assert-text') options.onStep({ kind: 'assert-text', locator, text: (element.textContent ?? '').replace(/\s+/g, ' ').trim() });
      else options.onStep({ kind: 'assert-visible', locator });
      setMode('record');
      return;
    }
    // Fields, checkboxes and selects are recorded by their input/change events instead.
    if (isTextField(target) || target.localName === 'select' || target.localName === 'option' || checkedState(target) !== null) return;
    const label = target.closest('label') as HTMLLabelElement | null;
    if (label?.control && (checkedState(label.control) !== null || isTextField(label.control))) return;
    flushFill();
    const element = closestComposed(target, CLICKABLE) ?? target;
    options.onStep({ kind: 'click', locator: bestLocator(element), text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) });
  };

  const onInput = (event: Event) => {
    const target = targetOf(event);
    if (!target || fromToolbar(event)) return;
    if (isTextField(target)) {
      if (pendingFill && pendingFill !== target) flushFill();
      pendingFill = target;
    }
  };

  const onChange = (event: Event) => {
    const target = targetOf(event);
    if (!target || fromToolbar(event)) return;
    if (isTextField(target)) {
      pendingFill = target;
      flushFill();
    } else if (target.localName === 'select') {
      flushFill();
      const select = target as HTMLSelectElement;
      const labels = Array.from(select.selectedOptions).map((option) => option.label || option.value);
      options.onStep({ kind: 'select', locator: bestLocator(select), value: labels.join(' | ') });
    } else if (checkedState(target) !== null) {
      flushFill();
      options.onStep({ kind: 'check', locator: bestLocator(target), checked: checkedState(target) === true });
    }
  };

  const onKeyDown = (event: Event) => {
    const key = (event as KeyboardEvent).key;
    const target = targetOf(event);
    if (key !== 'Enter' || !target || !isTextField(target) || target.localName === 'textarea') return;
    pendingFill = target;
    flushFill();
    options.onStep({ kind: 'press', locator: bestLocator(target), key: 'Enter' });
  };

  shadow?.addEventListener('click', (event) => {
    const act = (event.target as HTMLElement).closest('button')?.dataset.act;
    if (act === 'stop') {
      flushFill();
      options.onStop();
    } else if (act === 'assert-text' || act === 'assert-visible') setMode(mode === act ? 'record' : act);
  });

  const listeners: [string, (event: Event) => void][] = [
    ['click', onClick],
    ['input', onInput],
    ['change', onChange],
    ['keydown', onKeyDown],
  ];
  for (const [type, handler] of listeners) win.addEventListener(type, handler, true);
  // Typing then leaving the page (a link) still counts.
  win.addEventListener('pagehide', flushFill);

  return {
    stop() {
      flushFill();
      for (const [type, handler] of listeners) win.removeEventListener(type, handler, true);
      win.removeEventListener('pagehide', flushFill);
      unlisten?.();
      host?.remove();
    },
  };
}
