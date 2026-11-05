import { accessibleName, checkedState, getRole } from './aria';
import { FrameBoundaryError, LocatorError, describeElement, resolveLocator, textMatcher } from './locator';
import { bestLocator } from './bestLocator';
import type { AgentCall, AgentRequest, AgentResponse, FormFieldRow } from '../core/page';

/**
 * The page agent: runs inside a web page (injected by src/entrypoints/agent.content.ts) and
 * carries out one request at a time: click, fill, select, read, wait...
 *
 * Like Playwright, every action first waits until its element is ready: there is exactly one
 * match, it is visible, enabled, not moving, and not covered by something else. The agent retries
 * inside the page for `budgetMs`, then answers "pending" with the reason, and the extension asks
 * again until the step's timeout. Short calls keep working across page navigations, which destroy
 * the page's scripts (and this agent) mid-wait.
 *
 * Only `import type` from the extension: this file is bundled into the content script.
 */

/** Pause between attempts while `run` keeps retrying inside its budget. */
const RETRY_EVERY_MS = 50;

/** Not possible yet (missing, hidden, disabled, moving, covered): retried, then answered as `pending`. */
class Pending extends Error {}
/** Will never work (bad locator, strict-mode violation, wrong element type): answered as `error` at once. */
class Fatal extends Error {}

/** The `result` of a `done` answer. Must stay structured-cloneable: it goes back through `executeScript`. */
type Done = Record<string, unknown>;

/** One agent per document. Stored on `globalThis.__blockflowAgent` by agent.content.ts. */
export interface Agent {
  /**
   * Carries out one request, retrying every 50 ms for up to `call.budgetMs`. Never throws: every
   * outcome (including unexpected exceptions) is an {@link AgentResponse}.
   */
  run(call: AgentCall): Promise<AgentResponse>;
}

/** `window`, typed with its constructors (HTMLInputElement, MouseEvent...), which may differ per window. */
export type PageWindow = Window & typeof globalThis;

/**
 * `doc` defaults to the window's own document. Pass a parsed document (DOMParser) to scrape HTML
 * that was fetched rather than shown in a tab: it has no layout, so visibility checks are skipped.
 */
export function createAgent(win: PageWindow = window as PageWindow, doc: Document = win.document): Agent {
  /** Last seen position of an element, to tell when it stopped moving (animations). */
  const lastRects = new WeakMap<Element, string>();

  // A browser has layout; jsdom (unit tests) does not, so geometry checks are skipped there.
  const hasLayout = () => doc.documentElement.getBoundingClientRect().width > 0;

  const sleep = (ms: number) => new Promise<void>((resolve) => win.setTimeout(resolve, ms));

  // --- finding ------------------------------------------------------------

  /** Every match. Invalid locators become Fatal; FrameBoundaryError passes through to `run`. */
  function all(locator: string): Element[] {
    try {
      return resolveLocator(locator, doc);
    } catch (error) {
      if (error instanceof FrameBoundaryError) throw error;
      if (error instanceof LocatorError) throw new Fatal(error.message);
      throw error;
    }
  }

  /** Exactly one element, as Playwright's strict mode: two matches is a mistake worth knowing about. */
  function one(locator: string): Element {
    const found = all(locator);
    if (found.length === 0) throw new Pending(`waiting for ${locator}: no element matches`);
    if (found.length > 1) {
      const sample = found.slice(0, 3).map(describeElement).join(', ');
      throw new Fatal(
        `${locator} matches ${found.length} elements (${sample}${found.length > 3 ? ', …' : ''}). ` +
          'Make it more specific, or add ">> nth=0" for the first one.',
      );
    }
    return found[0] as Element;
  }

  // --- state checks ---------------------------------------------------------

  /** `[hidden]` on it or an ancestor, `display:none` on it or an ancestor, or `visibility:hidden|collapse` on itself. */
  function hiddenByStyle(element: Element): boolean {
    if (element.closest('[hidden]')) return true;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = (current.ownerDocument.defaultView ?? win).getComputedStyle(current);
      if (style.display === 'none') return true;
      if (current === element && (style.visibility === 'hidden' || style.visibility === 'collapse')) return true;
    }
    return false;
  }

  /** Connected, not hidden by style, and (when there is layout) a non-empty box. Opacity is not checked. */
  function isVisible(element: Element): boolean {
    if (!element.isConnected || hiddenByStyle(element)) return false;
    if (!hasLayout()) return true;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /** Not `disabled`, not inside a disabled fieldset (outside its legend), no `aria-disabled="true"` ancestor. */
  function isEnabled(element: Element): boolean {
    if ((element as HTMLButtonElement).disabled === true) return false;
    if (element.closest('fieldset[disabled]') && !element.closest('legend')) return false;
    return element.closest('[aria-disabled="true"]') === null;
  }

  function isEditable(element: Element): boolean {
    if ((element as HTMLInputElement).readOnly === true) return false;
    return element.getAttribute('aria-readonly') !== 'true';
  }

  /** Two looks 50 ms apart at the same place. */
  function isStable(element: Element): boolean {
    if (!hasLayout()) return true;
    const rect = element.getBoundingClientRect();
    const key = `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`;
    const previous = lastRects.get(element);
    lastRects.set(element, key);
    return previous === key;
  }

  /** Center of the element's box in its own document's viewport coordinates. */
  function center(element: Element): { x: number; y: number } {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  /**
   * Where the content of `frame` (an `<iframe>` in this document or in a same-origin frame below it)
   * starts, in this window's viewport: its box, plus border and padding, plus the offsets of the
   * frames it sits in.
   */
  function frameContentOrigin(frame: Element): { x: number; y: number } {
    const view = frame.ownerDocument.defaultView ?? win;
    const rect = frame.getBoundingClientRect();
    const style = view.getComputedStyle(frame);
    const outer = documentOrigin(frame.ownerDocument);
    return {
      x: outer.x + rect.left + frame.clientLeft + (parseFloat(style.paddingLeft) || 0),
      y: outer.y + rect.top + frame.clientTop + (parseFloat(style.paddingTop) || 0),
    };
  }

  /** Where a (same-origin) document's viewport starts in this window's viewport: (0, 0) for our own. */
  function documentOrigin(owner: Document): { x: number; y: number } {
    const frame = owner === doc ? null : owner.defaultView?.frameElement;
    return frame ? frameContentOrigin(frame) : { x: 0, y: 0 };
  }

  /** For `locate` into a cross-origin frame: bring the frame on screen, then say where its content starts. */
  function frameOffset(frame: Element): { x: number; y: number } {
    if (hasLayout() && typeof (frame as HTMLElement).scrollIntoView === 'function') {
      const rect = frame.getBoundingClientRect();
      const view = frame.ownerDocument.defaultView ?? win;
      if (rect.top < 0 || rect.left < 0 || rect.bottom > view.innerHeight || rect.right > view.innerWidth) {
        (frame as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' });
      }
    }
    return frameContentOrigin(frame);
  }

  /** What a real click at the element's center would hit. Null = fine. */
  function coveredBy(element: Element): Element | null {
    // Inside a same-origin iframe, coordinates and hit-testing belong to the frame's own document.
    const own = element.ownerDocument;
    if (!hasLayout() || typeof own.elementFromPoint !== 'function') return null;
    const { x, y } = center(element);
    let hit = own.elementFromPoint(x, y);
    // Step into shadow roots, so a hit on a web component's internals counts.
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    if (!hit) return null;
    if (hit === element || element.contains(hit)) return null;
    // A styled checkbox is often hidden under its label: clicking the label is the same thing.
    const label = hit.closest('label') as HTMLLabelElement | null;
    if (label && (label.control === element || label.contains(element))) return null;
    let root: Node = hit.getRootNode();
    while (root instanceof (own.defaultView ?? win).ShadowRoot) {
      if (root.host === element || element.contains(root.host)) return null;
      root = root.host.getRootNode();
    }
    return hit;
  }

  /** Throws Pending with the reason when the element is not ready yet. */
  function ready(element: Element, needs: { enabled?: boolean; editable?: boolean; hit?: boolean }): void {
    if (!isVisible(element)) throw new Pending(`waiting for ${describeElement(element)} to be visible`);
    if (needs.enabled && !isEnabled(element)) throw new Pending(`waiting for ${describeElement(element)} to be enabled`);
    if (needs.editable && !isEditable(element)) throw new Pending(`waiting for ${describeElement(element)} to be editable (it is read-only)`);
    if (typeof (element as HTMLElement).scrollIntoView === 'function' && hasLayout()) {
      const rect = element.getBoundingClientRect();
      const view = element.ownerDocument.defaultView ?? win;
      if (rect.top < 0 || rect.left < 0 || rect.bottom > view.innerHeight || rect.right > view.innerWidth) {
        (element as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' });
      }
    }
    if (!isStable(element)) throw new Pending(`waiting for ${describeElement(element)} to stop moving`);
    if (needs.hit) {
      const cover = coveredBy(element);
      if (cover) throw new Pending(`${describeElement(element)} is covered by ${describeElement(cover)}`);
    }
  }

  // --- events -------------------------------------------------------------

  interface KeyInfo {
    key: string;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
  }

  /**
   * Dispatches one synthetic pointer/mouse event (composed, so it crosses shadow boundaries).
   * Pointer events are skipped where `PointerEvent` does not exist. Returns false if it was cancelled.
   */
  function mouse(target: Element, type: string, x: number, y: number, button: number, detail: number): boolean {
    const init: MouseEventInit = {
      bubbles: type !== 'mouseenter' && type !== 'mouseleave',
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      button,
      buttons: type.endsWith('down') ? 1 << (button === 2 ? 1 : button === 1 ? 2 : 0) : 0,
      detail,
    };
    const PointerCtor = (win as unknown as { PointerEvent?: typeof PointerEvent }).PointerEvent;
    if (type.startsWith('pointer') && PointerCtor) {
      return target.dispatchEvent(new PointerCtor(type, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    }
    if (type.startsWith('pointer')) return true;
    return target.dispatchEvent(new win.MouseEvent(type, init));
  }

  /** Focuses the element, or its closest focusable ancestor (a click on a span inside a button focuses the button). */
  function focus(element: Element): void {
    const focusable = (element.closest('a[href], button, input, select, textarea, [tabindex], [contenteditable=""], [contenteditable="true"]') ??
      element) as HTMLElement;
    if (typeof focusable.focus === 'function') focusable.focus();
  }

  /**
   * The full synthetic sequence: hover events, then per press pointerdown, mousedown (+ focus unless
   * cancelled), pointerup, mouseup, click (or contextmenu); `dblclick` after two presses.
   */
  function click(element: Element, action: 'click' | 'double' | 'right' | 'hover'): void {
    const { x, y } = hasLayout() ? center(element) : { x: 0, y: 0 };
    const button = action === 'right' ? 2 : 0;
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
      mouse(element, type, x, y, 0, 0);
    }
    if (action === 'hover') return;
    const presses = action === 'double' ? 2 : 1;
    for (let press = 1; press <= presses; press += 1) {
      mouse(element, 'pointerdown', x, y, button, press);
      if (mouse(element, 'mousedown', x, y, button, press)) focus(element);
      mouse(element, 'pointerup', x, y, button, press);
      mouse(element, 'mouseup', x, y, button, press);
      if (action === 'right') mouse(element, 'contextmenu', x, y, button, press);
      // A dispatched click still runs the element's default action: follow a link, toggle a checkbox, submit a form.
      else mouse(element, 'click', x, y, button, press);
    }
    if (action === 'double') mouse(element, 'dblclick', x, y, button, 2);
  }

  function inputEvent(element: Element, data: string | null, inputType = 'insertText'): void {
    const InputCtor = (win as unknown as { InputEvent?: typeof InputEvent }).InputEvent;
    element.dispatchEvent(
      InputCtor
        ? new InputCtor('input', { bubbles: true, composed: true, inputType, data })
        : new win.Event('input', { bubbles: true, composed: true }),
    );
  }

  function changeEvent(element: Element): void {
    element.dispatchEvent(new win.Event('change', { bubbles: true }));
  }

  /**
   * Sets a value through the prototype's setter. Frameworks like React replace the element's own
   * `value` property to track changes; going around it makes them see the new value as a change.
   */
  function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
    const proto =
      element.localName === 'textarea'
        ? win.HTMLTextAreaElement.prototype
        : element.localName === 'select'
          ? win.HTMLSelectElement.prototype
          : win.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
  }

  const TEXT_INPUTS = new Set(['', 'text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']);

  /** What kind of text field the element is, or null when it cannot be typed into. */
  function textKind(element: Element): 'input' | 'textarea' | 'editable' | null {
    if (element.localName === 'textarea') return 'textarea';
    if (element.localName === 'input') return TEXT_INPUTS.has((element as HTMLInputElement).type) ? 'input' : null;
    if ((element as HTMLElement).isContentEditable || ['', 'true', 'plaintext-only'].includes(element.getAttribute('contenteditable') ?? 'x')) return 'editable';
    return null;
  }

  /**
   * `fill`: set the whole value at once (native setter + input + change). `type`: clear, then per
   * character keydown/keypress/input/keyup, honouring a cancelled keydown or keypress.
   * Contenteditable uses `execCommand('insertText')` when available.
   */
  function fill(element: Element, value: string, mode: 'fill' | 'type'): void {
    const kind = textKind(element);
    if (!kind) {
      const type = element.localName === 'input' ? ` type=${(element as HTMLInputElement).type}` : '';
      throw new Fatal(`${describeElement(element)}${type} cannot be typed into. Use Select Option, Check or Click instead.`);
    }
    focus(element);
    if (kind === 'editable') {
      const selection = win.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      const inserted = typeof doc.execCommand === 'function' && doc.execCommand('insertText', false, value);
      if (!inserted) {
        element.textContent = value;
        inputEvent(element, value);
      }
      return;
    }
    const field = element as HTMLInputElement | HTMLTextAreaElement;
    if (mode === 'fill') {
      setNativeValue(field, value);
      inputEvent(field, value);
    } else {
      setNativeValue(field, '');
      inputEvent(field, null, 'deleteContentBackward');
      for (const char of value) {
        const info: KeyInfo = { key: char, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
        const allowed = key(field, 'keydown', info);
        if (allowed && key(field, 'keypress', info)) {
          setNativeValue(field, field.value + char);
          inputEvent(field, char);
        }
        key(field, 'keyup', info);
      }
    }
    changeEvent(field);
  }

  function optionMatches(option: HTMLOptionElement, wanted: string): boolean {
    return option.value === wanted || option.label.trim() === wanted.trim() || (option.textContent ?? '').trim() === wanted.trim();
  }

  /** Picks options of a native `<select>` by value, label or text. A missing or disabled option is Pending. */
  function select(element: Element, values: string[]): Done {
    if (element.localName !== 'select') throw new Fatal(`${describeElement(element)} is not a <select>. Use Click to open custom dropdowns.`);
    const field = element as HTMLSelectElement;
    const options = Array.from(field.options);
    const chosen = values.map((wanted) => {
      const option = options.find((candidate) => optionMatches(candidate, wanted));
      if (!option) {
        const known = options.slice(0, 8).map((candidate) => candidate.label || candidate.value).join(', ');
        throw new Pending(`waiting for option "${wanted}" in ${describeElement(element)} (has: ${known})`);
      }
      if (option.disabled) throw new Pending(`option "${wanted}" is disabled`);
      return option;
    });
    if (chosen.length > 1 && !field.multiple) throw new Fatal(`${describeElement(element)} accepts one option, got ${chosen.length}`);
    focus(field);
    if (field.multiple) {
      for (const option of options) option.selected = chosen.includes(option);
    } else if (chosen[0]) {
      setNativeValue(field, chosen[0].value);
    }
    inputEvent(field, null, 'insertReplacementText');
    changeEvent(field);
    return { selected: chosen.map((option) => option.value) };
  }

  /** Clicks a checkbox/radio/switch only when its state differs, then verifies the new state. */
  function check(element: Element, checked: boolean): Done {
    const before = checkedState(element);
    if (before === null) throw new Fatal(`${describeElement(element)} is not a checkbox, radio or switch`);
    if (before === checked) return { changed: false, checked };
    if (!checked && (element as HTMLInputElement).type === 'radio') throw new Fatal('A radio button cannot be unchecked; check another one instead');
    click(element, 'click');
    if (checkedState(element) !== checked) throw new Fatal(`Clicking ${describeElement(element)} did not ${checked ? 'check' : 'uncheck'} it`);
    return { changed: true, checked };
  }

  const TRUTHY = new Set(['true', 'yes', 'on', '1', 'checked']);

  /** One form field from text, whatever kind of field it is. */
  function setField(element: Element, value: string): Done {
    if (element.localName === 'select') {
      return select(element, value.split('|').map((part) => part.trim()).filter(Boolean));
    }
    if (checkedState(element) !== null || getRole(element) === 'switch') {
      return check(element, TRUTHY.has(value.trim().toLowerCase()));
    }
    if (element.localName === 'input' && (element as HTMLInputElement).type === 'file') {
      throw new Fatal('File inputs cannot be filled with text (Upload File comes in a later version)');
    }
    fill(element, value, 'fill');
    return { value };
  }

  // --- keyboard -------------------------------------------------------------

  /** "Control+Shift+a" → key "a" plus modifier flags (ctrl/control, shift, alt, meta/cmd/command). */
  function parseKey(combo: string): KeyInfo {
    const parts = combo.split('+').map((part) => part.trim());
    const keyName = parts.pop() || combo;
    const has = (name: string) => parts.some((part) => part.toLowerCase() === name);
    return {
      key: keyName,
      ctrlKey: has('control') || has('ctrl'),
      shiftKey: has('shift'),
      altKey: has('alt'),
      metaKey: has('meta') || has('cmd') || has('command'),
    };
  }

  /** Dispatches one synthetic KeyboardEvent; returns false when the page cancelled it. */
  function key(target: Element, type: 'keydown' | 'keypress' | 'keyup', info: KeyInfo): boolean {
    const code = info.key.length === 1 ? (/[a-z]/i.test(info.key) ? `Key${info.key.toUpperCase()}` : /\d/.test(info.key) ? `Digit${info.key}` : '') : info.key;
    return target.dispatchEvent(new win.KeyboardEvent(type, { ...info, code, bubbles: true, cancelable: true, composed: true }));
  }

  /** Visible, enabled, tabIndex >= 0 elements in DOM order (positive tabindex ordering is not modelled). */
  function tabbables(): HTMLElement[] {
    return Array.from(
      doc.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex], [contenteditable=""], [contenteditable="true"]'),
    ).filter((element) => element.tabIndex >= 0 && isEnabled(element) && isVisible(element));
  }

  /**
   * Dispatches the key events, then does what the browser would have done, because synthetic key
   * events have no default action: type the character, Enter submits a form, Tab moves focus.
   */
  function press(target: Element, combo: string): Done {
    const info = parseKey(combo);
    const allowed = key(target, 'keydown', info);
    const printable = info.key.length === 1 && !info.ctrlKey && !info.metaKey && !info.altKey;
    if (allowed && (printable || info.key === 'Enter') && key(target, 'keypress', info)) {
      const kind = textKind(target);
      if (printable && (kind === 'input' || kind === 'textarea')) {
        const field = target as HTMLInputElement;
        setNativeValue(field, field.value + info.key);
        inputEvent(field, info.key);
      } else if (info.key === 'Enter' && kind === 'textarea') {
        const field = target as HTMLTextAreaElement;
        setNativeValue(field, `${field.value}\n`);
        inputEvent(field, null, 'insertLineBreak');
      } else if (info.key === 'Enter' && kind === 'input') {
        const form = (target as HTMLInputElement).form;
        if (form) {
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else form.submit();
        }
      } else if (info.key === 'Enter' && (target.localName === 'a' || target.localName === 'button')) {
        (target as HTMLElement).click();
      }
    }
    if (allowed) {
      if (info.key === 'Backspace' && (textKind(target) === 'input' || textKind(target) === 'textarea')) {
        const field = target as HTMLInputElement;
        setNativeValue(field, field.value.slice(0, -1));
        inputEvent(field, null, 'deleteContentBackward');
      } else if (info.key === 'Tab') {
        const list = tabbables();
        const index = list.indexOf(target as HTMLElement);
        const next = list[(index + (info.shiftKey ? -1 : 1) + list.length) % list.length];
        next?.focus();
      } else if (info.ctrlKey && info.key.toLowerCase() === 'a' && (target as HTMLInputElement).select) {
        (target as HTMLInputElement).select();
      }
    }
    key(target, 'keyup', info);
    return { key: combo };
  }

  // --- reading ------------------------------------------------------------

  /**
   * Not strict: uses the first match. count/exists/visible/checked/enabled answer even with no match;
   * text/value/attribute/has-class wait (Pending) for one.
   */
  function read(request: Extract<AgentRequest, { op: 'read' }>): Done {
    const found = all(request.locator);
    const count = found.length;
    if (request.kind === 'count') return { found: true, text: String(count), count };
    if (request.kind === 'exists') return { found: true, text: String(count > 0), count };
    const element = found[0];
    // Yes/no questions: a missing element is a valid "false", not something to wait for.
    if (request.kind === 'visible') return { found: true, text: String(found.some(isVisible)), count };
    if (request.kind === 'checked') return { found: true, text: String(element ? checkedState(element) === true : false), count };
    if (request.kind === 'enabled') return { found: true, text: String(element ? isEnabled(element) && isVisible(element) : false), count };
    if (!element) throw new Pending(`waiting for ${request.locator}: no element matches`);
    const name = request.name ?? '';
    let text: string;
    if (request.kind === 'attribute') text = element.getAttribute(name) ?? '';
    else if (request.kind === 'has-class') text = String(element.classList.contains(name));
    else if (request.kind === 'value') text = 'value' in element ? String((element as HTMLInputElement).value) : '';
    // textContent, as Watch Element always used, so existing watchers keep comparing like with like.
    else text = element.textContent ?? '';
    return { found: true, text, count };
  }

  /** Pending until the state holds. Text states search `innerText` of the locator's matches (or of body). */
  function wait(request: Extract<AgentRequest, { op: 'wait' }>): Done {
    const { state, locator, text } = request;
    if (state === 'text' || state === 'no-text') {
      if (!text) throw new Fatal('Wait For text needs the text to look for');
      const scope = locator ? all(locator) : [doc.body];
      const matches = textMatcher(text);
      const present = scope.some((element) => element && matches((element as HTMLElement).innerText ?? element.textContent ?? ''));
      if (present !== (state === 'text')) {
        throw new Pending(state === 'text' ? `waiting for text ${text}` : `waiting for text ${text} to disappear`);
      }
      return { state };
    }
    if (!locator) throw new Fatal(`Wait For "${state}" needs an element`);
    const found = all(locator);
    const visible = found.filter(isVisible);
    switch (state) {
      case 'attached':
        if (found.length === 0) throw new Pending(`waiting for ${locator} to appear in the page`);
        break;
      case 'detached':
        if (found.length > 0) throw new Pending(`waiting for ${locator} to be removed`);
        break;
      case 'visible':
        if (visible.length === 0) throw new Pending(`waiting for ${locator} to be visible`);
        break;
      case 'hidden':
        if (visible.length > 0) throw new Pending(`waiting for ${locator} to be hidden`);
        break;
      case 'enabled':
        if (!visible.some(isEnabled)) throw new Pending(`waiting for ${locator} to be enabled`);
        break;
    }
    return { state, count: found.length };
  }

  // --- scraping -------------------------------------------------------------

  const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'poster', 'data-src']);

  function textOf(element: Element): string {
    return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  /** Attribute value; URL attributes (href, src, action, poster, data-src) are made absolute against `doc.baseURI`. */
  function attributeOf(element: Element, name: string): string {
    const value = element.getAttribute(name) ?? '';
    if (!value || !URL_ATTRIBUTES.has(name)) return value;
    try {
      return new URL(value, doc.baseURI).href;
    } catch {
      return value;
    }
  }

  function extract(request: Extract<AgentRequest, { op: 'extract' }>): Done {
    const items = all(request.locator);
    if (items.length === 0) throw new Pending(`waiting for ${request.locator}: no element matches`);
    const picked = request.limit && request.limit > 0 ? items.slice(0, request.limit) : items;
    const fields = request.fields.length > 0 ? request.fields : [{ name: 'text' }];
    const values = picked.map((item) =>
      fields.map((field) => {
        let target: Element | undefined = item;
        if (field.locator?.trim()) {
          try {
            target = resolveLocator(field.locator, item)[0];
          } catch (error) {
            throw new Fatal(`Field "${field.name}": ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return !target ? '' : field.attribute?.trim() ? attributeOf(target, field.attribute.trim()) : textOf(target);
      }),
    );
    // Columns + arrays, not objects: Chrome sorts object keys when it passes results back.
    return { columns: fields.map((field) => field.name), values, count: values.length };
  }

  /** Strict match; the table is the element, its closest table, or the first table inside it. */
  function table(locator: string): Done {
    const found = one(locator);
    const tableElement = found.localName === 'table' ? found : found.closest('table') ?? found.querySelector('table');
    if (!tableElement) throw new Fatal(`${describeElement(found)} is not a table`);
    const rows = Array.from((tableElement as HTMLTableElement).rows);
    const headerRow = (tableElement as HTMLTableElement).tHead?.rows[0] ?? rows.find((row) => row.querySelector('th')) ?? rows[0];
    if (!headerRow) return { columns: [], values: [], count: 0 };
    const headers = Array.from(headerRow.cells).map((cell, index) => textOf(cell) || `column${index + 1}`);
    const body = rows.filter((row) => row !== headerRow && row.parentElement?.localName !== 'thead' && row.cells.length > 0);
    const values = body.map((row) => headers.map((_header, index) => (row.cells[index] ? textOf(row.cells[index] as Element) : '')));
    return { columns: headers, values, count: values.length };
  }

  function pageInfo(): Done {
    const meta: Record<string, string> = {};
    for (const tag of Array.from(doc.querySelectorAll('meta[name], meta[property]'))) {
      const key = tag.getAttribute('name') ?? tag.getAttribute('property');
      if (key) meta[key] = tag.getAttribute('content') ?? '';
    }
    const jsonLd = Array.from(doc.querySelectorAll('script[type="application/ld+json"]')).flatMap((script) => {
      try {
        return [JSON.parse(script.textContent ?? '')];
      } catch {
        return [];
      }
    });
    const canonical = doc.querySelector('link[rel="canonical"]');
    return {
      url: doc.URL,
      title: doc.title,
      description: meta.description ?? meta['og:description'] ?? '',
      canonical: canonical ? attributeOf(canonical, 'href') : '',
      lang: doc.documentElement.lang,
      meta,
      jsonLd,
      links: doc.querySelectorAll('a[href]').length,
    };
  }

  /** localStorage / sessionStorage / `document.cookie` (HttpOnly cookies are invisible here). */
  function storage(request: Extract<AgentRequest, { op: 'storage' }>): Done {
    if (request.area === 'cookies') {
      // Cookies the page can see (not HttpOnly ones).
      const cookies = Object.fromEntries(
        doc.cookie
          .split(';')
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            const index = part.indexOf('=');
            return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
          }),
      );
      return request.key ? { value: cookies[request.key] ?? null } : { value: cookies };
    }
    const area = request.area === 'local' ? win.localStorage : win.sessionStorage;
    if (request.key) return { value: area.getItem(request.key) };
    const everything: Record<string, string> = {};
    for (let i = 0; i < area.length; i += 1) {
      const key = area.key(i);
      if (key !== null) everything[key] = area.getItem(key) ?? '';
    }
    return { value: everything };
  }

  function scroll(request: Extract<AgentRequest, { op: 'scroll' }>): Done {
    const scroller = doc.scrollingElement ?? doc.documentElement;
    if (request.to === 'element') {
      if (!request.locator) throw new Fatal('Scroll to an element needs the element');
      const element = one(request.locator);
      (element as HTMLElement).scrollIntoView?.({ block: 'center' });
    } else {
      win.scrollTo(0, request.to === 'top' ? 0 : scroller.scrollHeight);
    }
    return { height: scroller.scrollHeight, y: win.scrollY };
  }

  /**
   * Puts files on an `<input type=file>` through a DataTransfer. The locator may point at the input,
   * a label for it, or an element containing it. No visibility check: the input is often hidden.
   */
  function upload(locator: string, files: { name: string; type: string; base64: string }[]): Done {
    const found = one(locator);
    const input = (found.localName === 'input' ? found : (found as HTMLLabelElement).control ?? found.querySelector('input[type="file"]')) as HTMLInputElement | null;
    if (!input || input.localName !== 'input' || input.type !== 'file') throw new Fatal(`${describeElement(found)} is not a file input. Point at the <input type="file"> (it may be hidden).`);
    if (!isEnabled(input)) throw new Pending(`waiting for ${describeElement(input)} to be enabled`);
    if (files.length > 1 && !input.multiple) throw new Fatal(`${describeElement(input)} takes one file, got ${files.length}`);
    if (typeof win.DataTransfer !== 'function') throw new Fatal('This page cannot receive files (no DataTransfer)');
    const transfer = new win.DataTransfer();
    for (const file of files) {
      const binary = win.atob(file.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      transfer.items.add(new win.File([bytes], file.name, { type: file.type }));
    }
    input.files = transfer.files;
    inputEvent(input, null, 'insertReplacementText');
    changeEvent(input);
    return { files: files.map((file) => file.name) };
  }

  /**
   * For real (debugger) input: same waits as the action, then the center in this document's viewport
   * coordinates. Elements in same-origin iframes get their frames' offsets added; for cross-origin
   * frames the driver adds the `offset` of the `frame` answer.
   */
  function locate(request: Extract<AgentRequest, { op: 'locate' }>): Done {
    const element = one(request.locator);
    const kind = element.localName === 'select' ? 'select' : checkedState(element) !== null ? 'check' : textKind(element) ? 'text' : 'other';
    ready(element, { enabled: true, editable: request.purpose === 'fill' || (request.purpose === 'set-field' && kind === 'text'), hit: true });
    // Same-origin frames around it must be on screen too.
    for (let owner = element.ownerDocument; owner !== doc; ) {
      const frame = owner.defaultView?.frameElement;
      if (!frame) break;
      frameOffset(frame);
      owner = frame.ownerDocument;
    }
    const { x, y } = center(element);
    const origin = documentOrigin(element.ownerDocument);
    return { x: x + origin.x, y: y + origin.y, kind };
  }

  // --- forms ----------------------------------------------------------------

  /** "Email · email", "Country · select: BD, US", for the Fill Form editor. */
  function hint(element: Element): string {
    const name = accessibleName(element) || element.getAttribute('name') || '';
    if (element.localName === 'select') {
      const options = Array.from((element as HTMLSelectElement).options)
        .filter((option) => option.value !== '')
        .slice(0, 6)
        .map((option) => option.label || option.value);
      return `${name} · select: ${options.join(', ')}${(element as HTMLSelectElement).options.length > 7 ? ', …' : ''}`;
    }
    if (checkedState(element) !== null) return `${name} · ${(element as HTMLInputElement).type || getRole(element)}: true / false`;
    if (element.localName === 'textarea') return `${name} · text`;
    return `${name} · ${(element as HTMLInputElement).type || 'text'}`;
  }

  /** The fields of the form around the picked element, for Fill Form's "Detect fields". */
  function detectForm(locator: string): Done {
    const picked = all(locator)[0];
    if (!picked) throw new Pending(`waiting for ${locator}`);
    const root = picked.closest('form') ?? picked;
    const skip = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file']);
    const fields: FormFieldRow[] = Array.from(root.querySelectorAll('input, select, textarea, [contenteditable=""], [contenteditable="true"], [role="switch"], [role="checkbox"]'))
      .filter((element) => !(element.localName === 'input' && skip.has((element as HTMLInputElement).type)))
      .filter((element) => isVisible(element) || ((element as HTMLInputElement).type === 'checkbox' || (element as HTMLInputElement).type === 'radio'))
      .map((element) => ({ locator: bestLocator(element), value: '', hint: hint(element) }));
    return { fields, form: root.localName === 'form' ? bestLocator(root) : null };
  }

  // --- dispatch -------------------------------------------------------------

  /** One try at the request. Throws Pending (retry), Fatal (give up) or FrameBoundaryError (hand over). */
  function attempt(request: AgentRequest): Done {
    switch (request.op) {
      case 'click': {
        const element = one(request.locator);
        if (!request.force) ready(element, { enabled: request.action !== 'hover', hit: true });
        click(element, request.action);
        return { clicked: describeElement(element), url: win.location.href };
      }
      case 'fill': {
        const element = one(request.locator);
        ready(element, { enabled: true, editable: true });
        fill(element, request.value, request.mode);
        return { value: request.value };
      }
      case 'set-field': {
        const element = one(request.locator);
        ready(element, { enabled: true, editable: checkedState(element) === null && element.localName !== 'select' });
        return setField(element, request.value);
      }
      case 'select': {
        const element = one(request.locator);
        ready(element, { enabled: true });
        return select(element, request.values);
      }
      case 'check': {
        const element = one(request.locator);
        ready(element, { enabled: true });
        return check(element, request.checked);
      }
      case 'press': {
        let target: Element = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : doc.body;
        if (request.locator) {
          target = one(request.locator);
          ready(target, { enabled: true });
          focus(target);
        }
        return press(target, request.key);
      }
      case 'read':
        return read(request);
      case 'wait':
        return wait(request);
      case 'detect-form':
        return detectForm(request.locator);
      case 'info':
        return { url: doc.URL, title: doc.title };
      case 'extract':
        return extract(request);
      case 'table':
        return table(request.locator);
      case 'page-info':
        return pageInfo();
      case 'storage':
        return storage(request);
      case 'scroll':
        return scroll(request);
      case 'upload':
        return upload(request.locator, request.files);
      case 'locate':
        return locate(request);
    }
  }

  return {
    async run({ request, budgetMs }: AgentCall): Promise<AgentResponse> {
      const deadline = Date.now() + Math.max(0, budgetMs);
      for (;;) {
        try {
          return { status: 'done', result: attempt(request) };
        } catch (error) {
          if (error instanceof FrameBoundaryError) {
            const offset = request.op === 'locate' && error.frame ? frameOffset(error.frame) : undefined;
            return { status: 'frame', src: error.src, rest: error.rest, ...(offset ? { offset } : {}) };
          }
          if (error instanceof Fatal) return { status: 'error', message: error.message };
          if (!(error instanceof Pending)) {
            return { status: 'error', message: error instanceof Error ? error.message : String(error) };
          }
          if (Date.now() >= deadline) return { status: 'pending', reason: error.message };
        }
        await sleep(RETRY_EVERY_MS);
      }
    },
  };
}
