import { locatorCandidates } from './bestLocator';
import { ElementNavigator, countMatches, generateSelector, sampleText } from './selector';

/** What the picker reports on confirm; sent to the background as `bf:picked` by picker.content.ts. */
export interface PickResult {
  /** A structural CSS selector (stable when the element's text changes, as watched prices do). */
  selector: string;
  /** Readable locators that find exactly this element, best first (see bestLocator.ts). */
  candidates: string[];
  /** `location.href` of the page (or frame) the element was picked on. */
  url: string;
  /** The element's text, whitespace-collapsed, up to 120 characters. */
  sample: string;
}

/** What the pick is for; only changes the hint on the toolbar. */
export type PickerMode = 'watch' | 'action' | 'form';

/**
 * Messages between the pickers in the frames of one tab (the background relays them as
 * `bf:picker-sync`). Only the top frame has a toolbar. A frame that locks an element tells the others
 * to let go of theirs and sends the toolbar its state; the toolbar's buttons (and keys pressed in any
 * frame) come back as commands that only the frame holding the pick carries out. Esc always ends up
 * in the top frame, which cancels.
 */
export type PickerSync =
  | { kind: 'locked'; from: string }
  | { kind: 'state'; from: string; selector: string; matches: number; canBroaden: boolean; canNarrow: boolean }
  | { kind: 'command'; from: string; action: 'broaden' | 'narrow' | 'confirm' | 'cancel' };

/** How a picker talks to the pickers in the tab's other frames. */
export interface PickerChannel {
  post(message: PickerSync): void;
  /** Returns a function that stops listening. */
  listen(handler: (message: PickerSync) => void): () => void;
}

/** Callbacks for {@link startPicker}. Exactly one of them is called, once, unless `stop()` comes first. */
export interface PickerOptions {
  onPick(result: PickResult): void;
  onCancel(): void;
  /** Defaults to the global document. Tests pass their own. */
  document?: Document;
  /** Picks the hint text. Default `watch`. */
  mode?: PickerMode;
  /** False inside iframes: no toolbar; the top frame's toolbar shows this frame's pick through `channel`. */
  toolbar?: boolean;
  /** Links the pickers of one tab's frames. Without it the picker works on its own document only. */
  channel?: PickerChannel;
}

/** Returned by {@link startPicker}. */
export interface PickerHandle {
  /** Removes the picker without calling onPick/onCancel. */
  stop(): void;
  /** For tests: the current CSS selector, how many elements it matches, and whether a click locked it. */
  state(): { selector: string | null; matches: number; locked: boolean };
}

/** The toolbar's hint before anything is picked, per mode. */
export const PICKER_HINTS: Record<PickerMode, string> = {
  watch: 'Click the part of the page to watch. Esc to cancel.',
  action: 'Click the element this step should use. Esc to cancel.',
  form: 'Click any field of the form. Esc to cancel.',
};

const STYLE = `
  :host { all: initial; }
  .box { position: fixed; box-sizing: border-box; pointer-events: none; border: 2px solid #ef4444;
         background: rgba(239, 68, 68, 0.15); border-radius: 2px; transition: all 60ms ease-out; }
  .bar { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); display: flex;
         flex-wrap: wrap; align-items: center; gap: 8px; max-width: min(94vw, 920px); padding: 10px 12px;
         border-radius: 10px; background: #18181b; color: #fafafa; pointer-events: auto;
         font: 13px/1.3 system-ui, sans-serif; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45); }
  .hint { color: #a1a1aa; }
  .sel { flex: 1 1 200px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
         font: 12px ui-monospace, monospace; background: #27272a; padding: 4px 6px; border-radius: 5px; }
  .count { color: #a1a1aa; white-space: nowrap; }
  button { font: inherit; color: inherit; background: #3f3f46; border: 0; border-radius: 6px;
           padding: 5px 10px; cursor: pointer; }
  button:hover:not(:disabled) { background: #52525b; }
  button:disabled { opacity: 0.4; cursor: default; }
  button.primary { background: #16a34a; }
  button.primary:hover:not(:disabled) { background: #22c55e; }
  [hidden] { display: none !important; }
`;

const BAR = `
  <div class="bar" role="dialog" aria-label="BlockFlow element picker">
    <span class="hint"></span>
    <code class="sel" hidden></code>
    <span class="count" hidden></span>
    <button data-act="broaden" title="Select the parent element (↑)" disabled>▲ Broader</button>
    <button data-act="narrow" title="Back toward the clicked element (↓)" disabled>▼ Narrower</button>
    <button data-act="confirm" class="primary" title="Use this element (Enter)" disabled>✓ Use this</button>
    <button data-act="cancel" title="Cancel (Esc)">✕</button>
  </div>
`;

type Action = Extract<PickerSync, { kind: 'command' }>['action'];
type PickState = { selector: string; matches: number; canBroaden: boolean; canNarrow: boolean };

/**
 * Point-and-click element picker. Shows a highlight on hover; click locks, then refine.
 * Adds a shadow-root overlay (`#blockflow-picker-host`) and capture-phase listeners on the window
 * that swallow the page's own pointer events until it confirms, cancels or is stopped.
 * Elements inside open shadow roots are picked themselves (through `composedPath()`), not their host.
 */
export function startPicker(options: PickerOptions): PickerHandle {
  const doc = options.document ?? document;
  const win = doc.defaultView as Window & typeof globalThis;
  const hasToolbar = options.toolbar !== false;
  const channel = options.channel;
  const self = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  const host = doc.createElement('div');
  host.id = 'blockflow-picker-host';
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${STYLE}</style><div class="box" hidden></div>${hasToolbar ? BAR : ''}`;
  doc.documentElement.appendChild(host);

  const box = shadow.querySelector('.box') as HTMLElement;
  const hint = shadow.querySelector('.hint') as HTMLElement | null;
  const selectorText = shadow.querySelector('.sel') as HTMLElement | null;
  const countText = shadow.querySelector('.count') as HTMLElement | null;
  const button = (name: string) => shadow.querySelector(`[data-act="${name}"]`) as HTMLButtonElement;
  if (hint) hint.textContent = PICKER_HINTS[options.mode ?? 'watch'];

  let navigator: ElementNavigator | null = null;
  let currentSelector: string | null = null;
  /** The pick held by a picker in another frame, as shown on this (top) toolbar. */
  let remote: PickState | null = null;
  let done = false;

  const isOwn = (event: Event) => event.composedPath().includes(host);
  /** The element really under the pointer, also inside open shadow roots (event.target is the host there). */
  const targetOf = (event: Event): EventTarget | null => event.composedPath()[0] ?? event.target;
  const isPickable = (target: EventTarget | null): target is Element => {
    const node = target as Node | null;
    return !!node && node.nodeType === 1 && node !== doc.documentElement && node !== doc.body;
  };

  function highlight(element: Element | null): void {
    if (!element) {
      box.hidden = true;
      return;
    }
    const rect = element.getBoundingClientRect();
    box.hidden = false;
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  }

  /** Fills the toolbar (top frame only). */
  function show(state: PickState | null, inFrame: boolean): void {
    if (!hint || !selectorText || !countText) return;
    hint.hidden = state !== null;
    selectorText.hidden = state === null;
    countText.hidden = state === null;
    if (state) {
      const text = inFrame ? `(in a frame) ${state.selector}` : state.selector;
      selectorText.textContent = text;
      selectorText.title = text;
      countText.textContent = state.matches === 1 ? '1 match' : `${state.matches} matches`;
    }
    button('broaden').disabled = !state?.canBroaden;
    button('narrow').disabled = !state?.canNarrow;
    button('confirm').disabled = state === null;
  }

  function render(): void {
    if (!navigator) {
      currentSelector = null;
      highlight(null);
      show(remote, true);
      return;
    }
    const element = navigator.current;
    currentSelector = generateSelector(element);
    const state: PickState = { selector: currentSelector, matches: countMatches(doc, currentSelector), canBroaden: navigator.canBroaden(), canNarrow: navigator.canNarrow() };
    highlight(element);
    if (hasToolbar) show(state, false);
    else channel?.post({ kind: 'state', from: self, ...state });
  }

  function cleanup(): void {
    if (done) return;
    done = true;
    for (const [type, handler] of listeners) win.removeEventListener(type, handler, true);
    unlisten?.();
    host.remove();
  }

  function confirm(): void {
    if (!navigator || !currentSelector) return;
    const candidates = locatorCandidates(navigator.current);
    const result: PickResult = {
      selector: currentSelector,
      candidates,
      url: win.location.href,
      sample: sampleText(navigator.current),
    };
    cleanup();
    options.onPick(result);
  }

  function cancel(): void {
    cleanup();
    options.onCancel();
  }

  /** A toolbar button or key: carried out here when this frame holds the pick, else sent to the frame that does. */
  function perform(action: Action): void {
    if (action === 'cancel') {
      if (hasToolbar) cancel();
      else channel?.post({ kind: 'command', from: self, action });
      return;
    }
    if (!navigator) {
      if (remote || !hasToolbar) channel?.post({ kind: 'command', from: self, action });
      return;
    }
    if (action === 'confirm') return confirm();
    if (action === 'broaden') navigator.broaden();
    else navigator.narrow();
    render();
  }

  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onMove = (event: Event) => {
    if (navigator || isOwn(event)) return;
    const target = targetOf(event);
    highlight(isPickable(target) ? target : null);
  };

  // Leaving this frame (for another one) hides the hover box, unless something is locked here.
  const onOut = (event: Event) => {
    if (!navigator && !(event as MouseEvent).relatedTarget) highlight(null);
  };

  const onClick = (event: Event) => {
    if (isOwn(event)) return;
    swallow(event);
    const target = targetOf(event);
    if (!isPickable(target)) return;
    navigator = new ElementNavigator(target);
    remote = null;
    channel?.post({ kind: 'locked', from: self });
    render();
  };

  // The page must not react to the clicks we use for picking (links, buttons, forms...).
  const onOtherPointer = (event: Event) => {
    if (!isOwn(event)) swallow(event);
  };

  const onKey = (event: Event) => {
    const key = (event as KeyboardEvent).key;
    // A frame without the toolbar forwards keys: the pick may be held by another frame.
    const holding = navigator !== null || remote !== null || !hasToolbar;
    const action: Action | null =
      key === 'Escape' ? 'cancel' : !holding ? null : key === 'Enter' ? 'confirm' : key === 'ArrowUp' ? 'broaden' : key === 'ArrowDown' ? 'narrow' : null;
    if (!action) return;
    swallow(event);
    perform(action);
  };

  const onLayout = () => {
    if (navigator) highlight(navigator.current);
  };

  shadow.addEventListener('click', (event) => {
    const target = (event.target as Element).closest('button[data-act]');
    if (!target || (target as HTMLButtonElement).disabled) return;
    event.stopPropagation();
    perform(target.getAttribute('data-act') as Action);
  });

  const unlisten = channel?.listen((message) => {
    if (done || message.from === self) return;
    if (message.kind === 'locked') {
      navigator = null;
      remote = null;
      render();
    } else if (message.kind === 'state') {
      if (!hasToolbar) return;
      const { selector, matches, canBroaden, canNarrow } = message;
      remote = { selector, matches, canBroaden, canNarrow };
      navigator = null;
      render();
    } else if (message.action === 'cancel') {
      if (hasToolbar) cancel();
    } else if (navigator) {
      perform(message.action);
    }
  });

  const listeners: [string, EventListener][] = [
    ['mousemove', onMove],
    ['mouseout', onOut],
    ['click', onClick],
    ['mousedown', onOtherPointer],
    ['mouseup', onOtherPointer],
    ['pointerdown', onOtherPointer],
    ['pointerup', onOtherPointer],
    ['dblclick', onOtherPointer],
    ['auxclick', onOtherPointer],
    ['keydown', onKey],
    ['scroll', onLayout],
    ['resize', onLayout],
  ];
  for (const [type, handler] of listeners) win.addEventListener(type, handler, true);
  render();

  return {
    stop: cleanup,
    state: () => ({
      selector: currentSelector,
      matches: currentSelector ? countMatches(doc, currentSelector) : 0,
      locked: navigator !== null,
    }),
  };
}
