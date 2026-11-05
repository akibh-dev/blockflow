import { locatorCandidates } from './bestLocator';
import { ElementNavigator, countMatches, generateSelector, sampleText } from './selector';

/** What the picker reports on confirm; sent to the background as `bf:picked` by picker.content.ts. */
export interface PickResult {
  /** A structural CSS selector (stable when the element's text changes, as watched prices do). */
  selector: string;
  /** Readable locators that find exactly this element, best first (see bestLocator.ts). */
  candidates: string[];
  /** `location.href` of the page the element was picked on. */
  url: string;
  /** The element's text, whitespace-collapsed, up to 120 characters. */
  sample: string;
}

/** Callbacks for {@link startPicker}. Exactly one of them is called, once, unless `stop()` comes first. */
export interface PickerOptions {
  onPick(result: PickResult): void;
  onCancel(): void;
  /** Defaults to the global document. Tests pass their own. */
  document?: Document;
}

/** Returned by {@link startPicker}. */
export interface PickerHandle {
  /** Removes the picker without calling onPick/onCancel. */
  stop(): void;
  /** For tests: the current CSS selector, how many elements it matches, and whether a click locked it. */
  state(): { selector: string | null; matches: number; locked: boolean };
}

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

const TEMPLATE = `
  <style>${STYLE}</style>
  <div class="box" hidden></div>
  <div class="bar" role="dialog" aria-label="BlockFlow element picker">
    <span class="hint">Click the part of the page to watch. Esc to cancel.</span>
    <code class="sel" hidden></code>
    <span class="count" hidden></span>
    <button data-act="broaden" title="Select the parent element (↑)" disabled>▲ Broader</button>
    <button data-act="narrow" title="Back toward the clicked element (↓)" disabled>▼ Narrower</button>
    <button data-act="confirm" class="primary" title="Use this element (Enter)" disabled>✓ Use this</button>
    <button data-act="cancel" title="Cancel (Esc)">✕</button>
  </div>
`;

/**
 * Point-and-click element picker. Shows a highlight on hover; click locks, then refine.
 * Adds a shadow-root overlay (`#blockflow-picker-host`) and capture-phase listeners on the window
 * that swallow the page's own pointer events until it confirms, cancels or is stopped.
 */
export function startPicker(options: PickerOptions): PickerHandle {
  const doc = options.document ?? document;
  const win = doc.defaultView as Window & typeof globalThis;

  const host = doc.createElement('div');
  host.id = 'blockflow-picker-host';
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = TEMPLATE;
  doc.documentElement.appendChild(host);

  const box = shadow.querySelector('.box') as HTMLElement;
  const hint = shadow.querySelector('.hint') as HTMLElement;
  const selectorText = shadow.querySelector('.sel') as HTMLElement;
  const countText = shadow.querySelector('.count') as HTMLElement;
  const button = (name: string) => shadow.querySelector(`[data-act="${name}"]`) as HTMLButtonElement;

  let navigator: ElementNavigator | null = null;
  let currentSelector: string | null = null;
  let done = false;

  const isOwn = (event: Event) => event.composedPath().includes(host);
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

  function render(): void {
    if (!navigator) {
      currentSelector = null;
      highlight(null);
      hint.hidden = false;
      selectorText.hidden = true;
      countText.hidden = true;
      for (const name of ['broaden', 'narrow', 'confirm']) button(name).disabled = true;
      return;
    }
    const element = navigator.current;
    currentSelector = generateSelector(element);
    const matches = countMatches(doc, currentSelector);
    highlight(element);
    hint.hidden = true;
    selectorText.hidden = false;
    selectorText.textContent = currentSelector;
    selectorText.title = currentSelector;
    countText.hidden = false;
    countText.textContent = matches === 1 ? '1 match' : `${matches} matches`;
    button('broaden').disabled = !navigator.canBroaden();
    button('narrow').disabled = !navigator.canNarrow();
    button('confirm').disabled = false;
  }

  function cleanup(): void {
    if (done) return;
    done = true;
    for (const [type, handler] of listeners) win.removeEventListener(type, handler, true);
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

  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onMove = (event: Event) => {
    if (navigator || isOwn(event)) return;
    highlight(isPickable(event.target) ? event.target : null);
  };

  const onClick = (event: Event) => {
    if (isOwn(event)) return;
    swallow(event);
    if (!isPickable(event.target)) return;
    navigator = new ElementNavigator(event.target);
    render();
  };

  // The page must not react to the clicks we use for picking (links, buttons, forms...).
  const onOtherPointer = (event: Event) => {
    if (!isOwn(event)) swallow(event);
  };

  const onKey = (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (key === 'Escape') {
      swallow(event);
      cancel();
    } else if (key === 'Enter' && navigator) {
      swallow(event);
      confirm();
    } else if (key === 'ArrowUp' && navigator) {
      swallow(event);
      navigator.broaden();
      render();
    } else if (key === 'ArrowDown' && navigator) {
      swallow(event);
      navigator.narrow();
      render();
    }
  };

  const onLayout = () => {
    if (navigator) highlight(navigator.current);
  };

  shadow.addEventListener('click', (event) => {
    const target = (event.target as Element).closest('button[data-act]');
    if (!target || (target as HTMLButtonElement).disabled) return;
    event.stopPropagation();
    switch (target.getAttribute('data-act')) {
      case 'broaden':
        navigator?.broaden();
        render();
        break;
      case 'narrow':
        navigator?.narrow();
        render();
        break;
      case 'confirm':
        confirm();
        break;
      case 'cancel':
        cancel();
        break;
    }
  });

  const listeners: [string, EventListener][] = [
    ['mousemove', onMove],
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

  return {
    stop: cleanup,
    state: () => ({
      selector: currentSelector,
      matches: currentSelector ? countMatches(doc, currentSelector) : 0,
      locked: navigator !== null,
    }),
  };
}
