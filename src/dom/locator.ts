import { FILTERS, LocatorSyntaxError, nestedLocator, parseLocatorAlternatives, parseLocatorSteps, parseRoleSelector, roleState, unquoteValue, visibleFilter } from '../core/locatorSyntax';
import type { LocatorStep as Step } from '../core/locatorSyntax';
import { accessibleName, checkedState, disabledState, expandedState, getRole, isHiddenForAria, pressedState, selectedState } from './aria';

/**
 * Finds elements from a locator string, Playwright style. Runs inside web pages: DOM only.
 *
 *   #login button, css=form input[name=email]   CSS (the default); `a >>> b` pierces open shadow roots
 *   text=Sign in                                 visible text, case-insensitive, substring
 *   text="Sign in"                               exact text (quotes)
 *   text=/sign\s?in/i                            regular expression
 *   role=button[name="Submit"]                   ARIA role (+ name, exact, checked, pressed, expanded,
 *                                                selected, disabled, level, include-hidden)
 *   label=Email                                  form control by its label (or aria-label)
 *   placeholder=you@example.com                  by placeholder
 *   testid=login                                 data-testid / data-test / data-cy / data-qa
 *   alt=Logo, title=Close                        by alt / title attribute
 *   xpath=//form//button, //form//button         XPath
 *   A >> B                                       B inside A
 *   A >> nth=0, nth=-1                           first / last of the matches so far
 *   A >> has-text=Apple, has-not-text=…          filters: keep matches whose text has / lacks it
 *   A >> has=<locator>, has-not=<locator>        keep matches with / without such an element inside
 *                                                (quote it when it has steps: has="li >> text=x")
 *   A >> visible, visible=false                  keep visible (or hidden) matches
 *   A || B                                       what A or B matches (binds loosest)
 */

/** An invalid locator (syntax, unknown engine, bad CSS/XPath/regex). The agent reports it as a Fatal error. */
export class LocatorError extends Error {}

/**
 * The locator goes into an iframe this page cannot look into (another origin). The extension then
 * runs `rest` inside that frame itself (src/browser/pageDriver.ts).
 */
export class FrameBoundaryError extends LocatorError {
  constructor(
    readonly src: string,
    readonly rest: string,
    /** The `<iframe>` element, so the agent can say where the frame is on screen (real input). */
    readonly frame?: Element,
  ) {
    super(`The element is inside a frame from another site (${src})`);
  }
}

const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];
const SKIP_TEXT = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link']);

/** Runs `fn`, rethrowing syntax errors from src/core/locatorSyntax.ts as {@link LocatorError}. */
function syntax<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof LocatorSyntaxError) throw new LocatorError(error.message);
    throw error;
  }
}

/** {@link parseLocatorSteps} (one alternative, no `||`), with syntax errors rethrown as {@link LocatorError}. */
export function parseLocator(source: string): Step[] {
  return syntax(() => parseLocatorSteps(source));
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function unquote(body: string): { value: string; quoted: boolean } {
  const match = /^(["'])([\s\S]*)\1$/.exec(body.trim());
  return match ? { value: (match[2] as string).replace(/\\(.)/g, '$1'), quoted: true } : { value: body.trim(), quoted: false };
}

/**
 * Text matching shared by every engine: /regex/flags, "exact" (quoted), or case-insensitive
 * substring. `exact` forces an exact match for unquoted text too.
 */
export function textMatcher(body: string, exact = false): (text: string) => boolean {
  const regex = /^\/([\s\S]+)\/([dgimsuyv]*)$/.exec(body.trim());
  if (regex) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(regex[1] as string, regex[2]);
    } catch {
      throw new LocatorError(`Invalid regular expression: ${body}`);
    }
    return (text) => pattern.test(normalize(text));
  }
  const { value, quoted } = unquote(body);
  const wanted = normalize(value);
  if (quoted || exact) return (text) => normalize(text) === wanted;
  const lower = wanted.toLowerCase();
  return (text) => normalize(text).toLowerCase().includes(lower);
}

/** The scope (if an element) and every descendant, including inside open shadow roots, in tree order. */
function allElements(scope: ParentNode): Element[] {
  const list: Element[] = [];
  if (scope instanceof Element) list.push(scope);
  const walk = (root: ParentNode) => {
    for (const element of Array.from(root.querySelectorAll('*'))) {
      list.push(element);
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(scope);
  return list;
}

/** CSS, where `>>>` steps into open shadow roots. */
function queryCss(selector: string, scope: ParentNode): Element[] {
  const segments = selector.split('>>>').map((segment) => segment.trim());
  let current: ParentNode[] = [scope];
  segments.forEach((segment, index) => {
    if (!segment) throw new LocatorError(`Invalid CSS: ${selector}`);
    const found: Element[] = [];
    for (const root of current) {
      try {
        found.push(...Array.from(root.querySelectorAll(segment)));
      } catch {
        throw new LocatorError(`Invalid CSS selector: ${segment}`);
      }
    }
    current =
      index < segments.length - 1
        ? found.flatMap((element) => (element.shadowRoot ? [element.shadowRoot] : []))
        : found;
  });
  return current as Element[];
}

function ownText(element: Element): string {
  if (element.localName === 'input') {
    const type = (element as HTMLInputElement).type;
    if (type === 'button' || type === 'submit' || type === 'reset') return (element as HTMLInputElement).value;
  }
  return element.textContent ?? '';
}

/** The smallest elements whose text matches (a button, not every ancestor of it). */
function queryText(body: string, scope: ParentNode): Element[] {
  const matches = textMatcher(body);
  return allElements(scope).filter((element) => {
    if (SKIP_TEXT.has(element.localName) || element.closest('head')) return false;
    if (!matches(ownText(element))) return false;
    return !Array.from(element.children).some((child) => !SKIP_TEXT.has(child.localName) && matches(ownText(child)));
  });
}

/** Parsed `role=name[name=...][exact][checked][pressed][expanded][selected][disabled][level=N][include-hidden]`. */
interface RoleQuery {
  role: string;
  name?: (text: string) => boolean;
  /** Yes/no states to match, with the reader of each. */
  states: { read: (element: Element) => boolean | null; wanted: boolean }[];
  level?: number;
  includeHidden: boolean;
}

const STATE_READERS: Record<string, (element: Element) => boolean | null> = {
  checked: checkedState,
  pressed: pressedState,
  expanded: expandedState,
  selected: selectedState,
  disabled: disabledState,
};

function parseRole(body: string): RoleQuery {
  const selector = syntax(() => parseRoleSelector(body));
  const query: RoleQuery = { role: selector.role, states: [], includeHidden: false };
  let exact = false;
  let nameBody: string | undefined;
  for (const option of selector.options) {
    if (option.key === 'name') nameBody = option.value ?? '';
    else if (option.key === 'exact') exact = true;
    else if (option.key === 'level') query.level = Number(unquoteValue(option.value ?? ''));
    else if (option.key === 'include-hidden') query.includeHidden = true;
    else query.states.push({ read: STATE_READERS[option.key] as (element: Element) => boolean | null, wanted: syntax(() => roleState(option)) });
  }
  if (nameBody !== undefined) {
    // Unlike text=, a quoted role name is still a case-insensitive substring unless [exact] is set.
    const { value } = unquote(nameBody);
    query.name = /^\/[\s\S]+\/[dgimsuyv]*$/.test(nameBody.trim()) ? textMatcher(nameBody) : textMatcher(value, exact);
  }
  return query;
}

function queryRole(body: string, scope: ParentNode): Element[] {
  const query = parseRole(body);
  return allElements(scope).filter((element) => {
    if (getRole(element) !== query.role) return false;
    if (query.name && !query.name(accessibleName(element))) return false;
    // An element without the state (no aria-pressed...) matches neither [pressed] nor [pressed=false].
    if (query.states.some(({ read, wanted }) => read(element) !== wanted)) return false;
    if (query.level !== undefined) {
      const level = Number(element.getAttribute('aria-level') ?? /^h([1-6])$/.exec(element.localName)?.[1]);
      if (level !== query.level) return false;
    }
    // Last: it reads computed styles up the tree, the most expensive test.
    return query.includeHidden || !isHiddenForAria(element);
  });
}

/** Controls of matching `<label>`s (by `.control` or the first field inside), plus elements whose aria-label or aria-labelledby text matches. */
function queryLabel(body: string, scope: ParentNode): Element[] {
  const matches = textMatcher(body);
  const results = new Set<Element>();
  for (const element of allElements(scope)) {
    if (element.localName === 'label' && matches(element.textContent ?? '')) {
      const control =
        (element as HTMLLabelElement).control ?? element.querySelector('input, select, textarea, [contenteditable]');
      if (control) results.add(control);
    }
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel && matches(ariaLabel)) results.add(element);
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
        .join(' ');
      if (matches(text)) results.add(element);
    }
  }
  return [...results];
}

function queryAttribute(attribute: string, body: string, scope: ParentNode): Element[] {
  const matches = textMatcher(body);
  return allElements(scope).filter((element) => {
    const value = element.getAttribute(attribute);
    return value !== null && matches(value);
  });
}

/** Exact (case-sensitive) value of any of TEST_ID_ATTRIBUTES. Does not use textMatcher. */
function queryTestId(body: string, scope: ParentNode): Element[] {
  const { value } = unquote(body);
  return allElements(scope).filter((element) => TEST_ID_ATTRIBUTES.some((attribute) => element.getAttribute(attribute) === value));
}

/** XPath evaluated with the scope as context node. Does not see into shadow roots. */
function queryXpath(body: string, scope: ParentNode): Element[] {
  const doc = scope instanceof Document ? scope : (scope as Node).ownerDocument;
  if (!doc) return [];
  let snapshot: XPathResult;
  try {
    snapshot = doc.evaluate(body, scope as Node, null, 7 /* ORDERED_NODE_SNAPSHOT_TYPE */, null);
  } catch {
    throw new LocatorError(`Invalid XPath: ${body}`);
  }
  const found: Element[] = [];
  for (let i = 0; i < snapshot.snapshotLength; i += 1) {
    const node = snapshot.snapshotItem(i);
    if (node && node.nodeType === Node.ELEMENT_NODE) found.push(node as Element);
  }
  return found;
}

function queryStep(step: Step, scope: ParentNode): Element[] {
  switch (step.engine) {
    case 'css':
      return queryCss(step.body, scope);
    case 'text':
      return queryText(step.body, scope);
    case 'role':
      return queryRole(step.body, scope);
    case 'label':
      return queryLabel(step.body, scope);
    case 'placeholder':
      return queryAttribute('placeholder', step.body, scope);
    case 'alt':
      return queryAttribute('alt', step.body, scope);
    case 'title':
      return queryAttribute('title', step.body, scope);
    case 'testid':
      return queryTestId(step.body, scope);
    case 'xpath':
      return queryXpath(step.body, scope);
    default:
      throw new LocatorError(`Unknown locator type "${step.engine}"`);
  }
}

/** Deduplicated and sorted by document position. */
function inDocumentOrder(elements: Element[]): Element[] {
  return [...new Set(elements)].sort((a, b) => {
    if (a === b) return 0;
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
}

/**
 * Visible the way actions mean it (the agent's own check is the same): connected, no `[hidden]` or
 * `display:none` on it or an ancestor, no `visibility:hidden|collapse` on itself, and, when the page has
 * layout (not jsdom or a parsed document), a non-empty box.
 */
export function isVisibleElement(element: Element): boolean {
  if (!element.isConnected || element.closest('[hidden]')) return false;
  const view = element.ownerDocument.defaultView;
  if (view) {
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = view.getComputedStyle(current);
      if (style.display === 'none') return false;
      if (current === element && (style.visibility === 'hidden' || style.visibility === 'collapse')) return false;
    }
  }
  if (!(element.ownerDocument.documentElement.getBoundingClientRect().width > 0)) return true;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** Whether `inner` (a whole locator) finds something strictly inside `element`. Other-origin frames count as no. */
function contains(element: Element, inner: string): boolean {
  try {
    return resolveLocator(inner, element).some((found) => found !== element);
  } catch (error) {
    if (error instanceof FrameBoundaryError) return false;
    throw error;
  }
}

/** A filter step (FILTERS) applied to the matches so far, like Playwright's `locator.filter()`. */
function applyFilter(step: Step, current: Element[]): Element[] {
  switch (step.engine) {
    case 'has-text':
    case 'has-not-text': {
      if (!step.body) throw new LocatorError(`${step.engine}= needs the text to look for`);
      const matches = textMatcher(step.body);
      const wanted = step.engine === 'has-text';
      return current.filter((element) => matches(ownText(element)) === wanted);
    }
    case 'has':
    case 'has-not': {
      const inner = syntax(() => nestedLocator(step.body));
      // Fail on a bad inner locator even when there is nothing to filter yet.
      syntax(() => parseLocatorAlternatives(inner));
      const wanted = step.engine === 'has';
      return current.filter((element) => contains(element, inner) === wanted);
    }
    case 'visible': {
      const wanted = syntax(() => visibleFilter(step.body));
      return current.filter((element) => isVisibleElement(element) === wanted);
    }
    default:
      throw new LocatorError(`Unknown filter "${step.engine}"`);
  }
}

/**
 * Every element the locator matches, in document order. Throws LocatorError for invalid locators.
 * `A || B` resolves each alternative and merges the matches.
 *
 * `frame=<css>` searches inside every matching same-origin frame. Matching frames from another origin
 * are skipped; only when the whole locator finds nothing does it throw {@link FrameBoundaryError} for
 * the first skipped frame, so the extension can continue inside that frame.
 */
export function resolveLocator(source: string, root: ParentNode = document): Element[] {
  const alternatives = syntax(() => parseLocatorAlternatives(source));
  if (alternatives.length === 1) return resolveSteps(alternatives[0] as Step[], root);
  const found: Element[] = [];
  let skipped: FrameBoundaryError | null = null;
  for (const steps of alternatives) {
    try {
      found.push(...resolveSteps(steps, root));
    } catch (error) {
      if (!(error instanceof FrameBoundaryError)) throw error;
      skipped ??= error;
    }
  }
  if (found.length === 0 && skipped) throw skipped;
  return inDocumentOrder(found);
}

/** One alternative: steps searched one inside the other, filters narrowing the matches so far. */
function resolveSteps(steps: Step[], root: ParentNode): Element[] {
  let current: Element[] | null = null;
  let scopes: ParentNode[] = [root];
  /** The first cross-origin frame skipped, with the steps that would have searched it. */
  let skipped: FrameBoundaryError | null = null;
  for (const [index, step] of steps.entries()) {
    if (FILTERS.has(step.engine)) {
      if (current === null) throw new LocatorError(`${step.engine}= filters the matches of the step before it; start with a locator (e.g. role=listitem >> ${step.engine}=…)`);
      current = applyFilter(step, current);
      scopes = current;
      continue;
    }
    if (step.engine === 'nth') {
      const position = Number(step.body);
      if (!Number.isInteger(position)) throw new LocatorError(`nth needs a whole number: nth=${step.body}`);
      const list: Element[] = current ?? [];
      const picked: Element | undefined = position < 0 ? list[list.length + position] : list[position];
      current = picked ? [picked] : [];
      scopes = current;
      continue;
    }
    if (step.engine === 'frame') {
      // frame=<css of the iframe>: the following steps search inside that frame's document.
      const frames = inDocumentOrder(scopes.flatMap((scope) => queryCss(step.body, scope))).filter((element) => element.localName === 'iframe' || element.localName === 'frame');
      const documents: ParentNode[] = [];
      for (const frame of frames) {
        let inner: Document | null = null;
        try {
          inner = (frame as HTMLIFrameElement).contentDocument;
        } catch {
          inner = null;
        }
        if (inner) documents.push(inner);
        else if (!skipped) {
          const rest = steps.slice(index + 1).map((next) => `${next.engine}=${next.body}`).join(' >> ');
          skipped = new FrameBoundaryError((frame as HTMLIFrameElement).src, rest, frame);
        }
      }
      current = frames;
      scopes = documents;
      continue;
    }
    const found: Element[] = [];
    for (const scope of scopes) {
      for (const element of queryStep(step, scope)) {
        // "B inside A" means strictly inside.
        if (current && element === scope) continue;
        found.push(element);
      }
    }
    current = inDocumentOrder(found);
    scopes = current;
  }
  const result = current ?? [];
  if (result.length === 0 && skipped) throw skipped;
  return result;
}

/** Short description of an element for messages: button#save.primary "Save changes". */
export function describeElement(element: Element): string {
  let text = `${element.localName}`;
  if (element.id) text += `#${element.id}`;
  const classes = Array.from(element.classList).slice(0, 2);
  if (classes.length > 0) text += `.${classes.join('.')}`;
  const label = normalize(accessibleName(element) || element.textContent || '').slice(0, 40);
  return label ? `${text} "${label}"` : text;
}
