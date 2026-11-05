/**
 * CSS selector generation for the element picker (the same idea as uBlock Origin's picker):
 * you click something on the page and we work out a short, readable selector for it.
 *
 * Heuristics, in order of preference for each element on the way up from the target:
 *   1. a stable-looking id               #price
 *   2. a test/automation attribute       span[data-testid="price"]
 *   3. tag + stable classes              span.price.big
 * We add :nth-of-type only when siblings would otherwise be ambiguous, and keep adding
 * ancestors until the selector matches exactly one element.
 */

/** The CSS.escape algorithm from the CSSOM spec (jsdom does not ship CSS.escape). */
export function cssEscape(value: string): string {
  const string = String(value);
  const length = string.length;
  const first = string.charCodeAt(0);
  let result = '';
  if (length === 1 && first === 0x2d) return `\\${string}`;
  for (let index = 0; index < length; index += 1) {
    const code = string.charCodeAt(index);
    if (code === 0x0000) {
      result += '\uFFFD';
      continue;
    }
    if (
      (code >= 0x0001 && code <= 0x001f) ||
      code === 0x007f ||
      (index === 0 && code >= 0x0030 && code <= 0x0039) ||
      (index === 1 && code >= 0x0030 && code <= 0x0039 && first === 0x2d)
    ) {
      result += `\\${code.toString(16)} `;
      continue;
    }
    if (
      code >= 0x0080 ||
      code === 0x002d ||
      code === 0x005f ||
      (code >= 0x0030 && code <= 0x0039) ||
      (code >= 0x0041 && code <= 0x005a) ||
      (code >= 0x0061 && code <= 0x007a)
    ) {
      result += string.charAt(index);
      continue;
    }
    result += `\\${string.charAt(index)}`;
  }
  return result;
}

const STABLE_ATTRIBUTES = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'name', 'aria-label'];
const STATE_CLASSES = new Set([
  'active', 'hover', 'focus', 'focused', 'selected', 'open', 'opened', 'closed', 'show', 'shown',
  'hidden', 'visible', 'loading', 'loaded', 'disabled', 'enabled', 'current', 'checked', 'expanded',
  'collapsed', 'is-active', 'is-open', 'is-hidden', 'ng-star-inserted',
]);
const GENERATED_PREFIX = /^(css|sc|jsx|svelte|emotion|styled|chakra|mui|Mui|makeStyles)-/;

/** Ids like "price" are good anchors; ids like ":r1:", "ember123" or "a8f3c2d9e1" are not. */
export function isStableId(id: string): boolean {
  return (
    /^[A-Za-z][\w-]{0,40}$/.test(id) &&
    !/\d{3,}/.test(id) &&
    !/^[a-f0-9]{8,}$/i.test(id) &&
    !GENERATED_PREFIX.test(id)
  );
}

/** Rejects state classes (`active`, `open`...), CSS-in-JS prefixes, 3+ digit runs and random-looking hashes. */
export function isStableClass(name: string): boolean {
  if (!/^[A-Za-z_][\w-]{0,30}$/.test(name)) return false;
  if (STATE_CLASSES.has(name)) return false;
  if (GENERATED_PREFIX.test(name)) return false;
  if (/\d{3,}/.test(name)) return false;
  // Random-looking hashes such as "aB3dE9fGh2": mixed case + digits, no separators.
  if (/^[A-Za-z0-9]{8,}$/.test(name) && /[a-z]/.test(name) && /[A-Z]/.test(name) && /\d/.test(name)) {
    return false;
  }
  return true;
}

function quoteAttribute(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`;
}

/** One element's own selector: stable id, else STABLE_ATTRIBUTES (value ≤ 60 chars), else tag + up to two stable classes. */
function baseSegment(element: Element): { text: string; isId: boolean } {
  const tag = element.tagName.toLowerCase();
  const id = element.getAttribute('id');
  if (id && isStableId(id)) return { text: `#${cssEscape(id)}`, isId: true };

  for (const attribute of STABLE_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value && value.length <= 60) {
      return { text: `${tag}[${attribute}=${quoteAttribute(value)}]`, isId: false };
    }
  }

  const classes = Array.from(element.classList).filter(isStableClass).slice(0, 2);
  return { text: tag + classes.map((name) => `.${cssEscape(name)}`).join(''), isId: false };
}

/** baseSegment plus `:nth-of-type(n)` when another sibling matches it too. */
function segmentFor(element: Element): string {
  const { text, isId } = baseSegment(element);
  if (isId) return text;
  const parent = element.parentElement;
  if (!parent) return text;

  const matching = Array.from(parent.children).filter((sibling) => sibling.matches(text));
  if (matching.length <= 1) return text;

  const sameTag = Array.from(parent.children).filter((sibling) => sibling.tagName === element.tagName);
  return `${text}:nth-of-type(${sameTag.indexOf(element) + 1})`;
}

/** How many elements a plain CSS selector matches in `doc` (0 when the selector is invalid). */
export function countMatches(doc: Document, selector: string): number {
  try {
    return doc.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

function matchesOnly(doc: Document, selector: string, element: Element): boolean {
  try {
    const found = doc.querySelectorAll(selector);
    return found.length === 1 && found[0] === element;
  } catch {
    return false;
  }
}

/** Short selector that matches exactly `element` (when it is attached to the document). */
export function generateSelector(element: Element): string {
  const doc = element.ownerDocument;
  if (element === doc.documentElement) return 'html';

  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== doc.documentElement) {
    parts.unshift(segmentFor(current));
    const selector = parts.join(' > ');
    if (matchesOnly(doc, selector, element)) return selector;
    current = current.parentElement;
  }
  return parts.join(' > ');
}

/** Visible text of the element, shortened, for showing what was picked. */
export function sampleText(element: Element, max = 120): string {
  const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Lets the user widen or narrow the pick, like uBlock's slider: "broaden" moves to the parent,
 * "narrow" moves back down toward the element that was originally clicked.
 */
export class ElementNavigator {
  private readonly chain: Element[];
  private index = 0;

  constructor(start: Element) {
    this.chain = [start];
  }

  get current(): Element {
    return this.chain[this.index] as Element;
  }

  /** False at the child of `<body>`: body and html are never offered. */
  canBroaden(): boolean {
    const parent = this.current.parentElement;
    const doc = this.current.ownerDocument;
    return !!parent && parent !== doc.body && parent !== doc.documentElement;
  }

  canNarrow(): boolean {
    return this.index > 0;
  }

  broaden(): Element {
    if (this.canBroaden()) {
      if (this.index === this.chain.length - 1) {
        this.chain.push(this.current.parentElement as Element);
      }
      this.index += 1;
    }
    return this.current;
  }

  narrow(): Element {
    if (this.canNarrow()) this.index -= 1;
    return this.current;
  }
}
