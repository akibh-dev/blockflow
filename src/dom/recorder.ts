import { bestLocator } from './bestLocator';
import { checkedState } from './aria';
import type { RecordedStep } from '../core/recording';

/**
 * The recorder: watches what the user does in a page and reports steps (click, fill, select,
 * check, Enter), plus "assert" steps picked from its toolbar. src/core/recording.ts turns the steps
 * into blocks. Runs inside pages: DOM only.
 */

export interface RecorderOptions {
  onStep(step: RecordedStep): void;
  /** The toolbar's Stop button. */
  onStop(): void;
  document?: Document;
}

export interface RecorderHandle {
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

const TEXT_TYPES = new Set(['', 'text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date', 'time', 'datetime-local', 'month', 'week']);
const CLICKABLE = 'button, a, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], input[type="submit"], input[type="button"], input[type="image"], summary';

function isTextField(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  if (element.localName === 'textarea') return true;
  return element.localName === 'input' && TEXT_TYPES.has((element as HTMLInputElement).type);
}

export function startRecorder(options: RecorderOptions): RecorderHandle {
  const doc = options.document ?? document;
  const win = doc.defaultView as Window;
  let mode: 'record' | 'assert-text' | 'assert-visible' = 'record';
  let pendingFill: HTMLInputElement | HTMLTextAreaElement | null = null;
  /** The value last recorded per field: input, change and blur can all report the same typing. */
  const recorded = new WeakMap<Element, string>();

  const host = doc.createElement('blockflow-recorder');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = TOOLBAR;
  doc.documentElement.append(host);
  const buttons = Array.from(shadow.querySelectorAll<HTMLButtonElement>('button'));

  const setMode = (next: typeof mode) => {
    mode = next;
    for (const button of buttons) button.classList.toggle('on', button.dataset.act === next);
    (shadow.querySelector('.hint') as HTMLElement).textContent = next === 'record' ? 'Recording' : 'Click an element to check';
  };

  const fromToolbar = (event: Event) => event.composedPath().includes(host);

  const flushFill = () => {
    if (!pendingFill) return;
    const field = pendingFill;
    pendingFill = null;
    if (recorded.get(field) === field.value) return;
    recorded.set(field, field.value);
    const secret = field.localName === 'input' && field.type === 'password';
    options.onStep({ kind: 'fill', locator: bestLocator(field), value: secret ? '' : field.value, ...(secret ? { secret: true } : {}) });
  };

  const onClick = (event: Event) => {
    if (fromToolbar(event)) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (mode !== 'record') {
      event.preventDefault();
      event.stopImmediatePropagation();
      const element = target.closest(CLICKABLE) ?? target;
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
    const element = target.closest(CLICKABLE) ?? target;
    options.onStep({ kind: 'click', locator: bestLocator(element), text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) });
  };

  const onInput = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element) || fromToolbar(event)) return;
    if (isTextField(target)) {
      if (pendingFill && pendingFill !== target) flushFill();
      pendingFill = target;
    }
  };

  const onChange = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element) || fromToolbar(event)) return;
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
    const target = event.target;
    if (key !== 'Enter' || !(target instanceof Element) || !isTextField(target) || target.localName === 'textarea') return;
    pendingFill = target;
    flushFill();
    options.onStep({ kind: 'press', locator: bestLocator(target), key: 'Enter' });
  };

  shadow.addEventListener('click', (event) => {
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
      host.remove();
    },
  };
}
