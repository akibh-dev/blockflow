import { accessibleName, getRole } from './aria';
import { resolveLocator } from './locator';
import { generateSelector } from './selector';

/**
 * Locators for one element, best first: what a person (or Playwright codegen) would write.
 * Only locators that find exactly this element are returned; a CSS selector is always last.
 * Runs inside pages (picker, recorder, page agent).
 */

const TEST_IDS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];

function quote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function short(text: string | null | undefined, max = 60): string | null {
  const value = (text ?? '').replace(/\s+/g, ' ').trim();
  return value && value.length <= max ? value : null;
}

/**
 * The locator resolves (from the element's document) to exactly this element. `cache` (locator →
 * matches, one per document) saves resolving the same idea again for similar elements.
 */
function finds(locator: string, element: Element, cache?: Map<string, Element[]>): boolean {
  let found = cache?.get(locator);
  if (!found) {
    try {
      found = resolveLocator(locator, element.ownerDocument);
    } catch {
      found = [];
    }
    cache?.set(locator, found);
  }
  return found.length === 1 && found[0] === element;
}

/**
 * Locator ideas for `element`, best first, not yet checked: testid, label / placeholder (form fields),
 * role+name, role+name exact (not form fields), text (not form fields), alt, title, `tag[name=...]`
 * (form fields; radios add `[value=...]`).
 */
function locatorIdeas(element: Element): string[] {
  const ideas: string[] = [];
  const testId = TEST_IDS.map((name) => element.getAttribute(name)).find(Boolean);
  if (testId) ideas.push(`testid=${testId}`);

  const role = getRole(element);
  const name = short(accessibleName(element));
  const formField = ['input', 'select', 'textarea'].includes(element.localName);
  if (formField) {
    const label = short((element as HTMLInputElement).labels?.[0]?.textContent) ?? short(element.getAttribute('aria-label'));
    if (label) ideas.push(`label=${quote(label)}`);
    const placeholder = short(element.getAttribute('placeholder'));
    if (placeholder) ideas.push(`placeholder=${quote(placeholder)}`);
  }
  if (role && name && role !== 'paragraph' && role !== 'presentation') ideas.push(`role=${role}[name=${quote(name)}]`);
  if (role && name && !formField) ideas.push(`role=${role}[name=${quote(name)}][exact]`);
  if (!formField) {
    const text = short(element.textContent, 40);
    if (text) ideas.push(`text=${quote(text)}`);
  }
  const alt = short(element.getAttribute('alt'));
  if (alt) ideas.push(`alt=${quote(alt)}`);
  const title = short(element.getAttribute('title'));
  if (title) ideas.push(`title=${quote(title)}`);
  const nameAttr = element.getAttribute('name');
  if (nameAttr && formField) {
    const value = (element as HTMLInputElement).type === 'radio' ? `[value=${quote((element as HTMLInputElement).value)}]` : '';
    ideas.push(`${element.localName}[name=${quote(nameAttr)}]${value}`);
  }
  return [...new Set(ideas)];
}

/** Containers whose text tells one repeated element from another ("the Delete button of the Apple row"). */
const SCOPE_ROLES = new Set(['listitem', 'row', 'article', 'group', 'region', 'form', 'dialog', 'navigation', 'cell']);

/**
 * The first short text in `container` outside `element`, when it is safe to write unquoted after
 * `has-text=` (an unquoted has-text is a case-insensitive substring, which suits a whole row's text).
 */
function distinctText(container: Element, element: Element): string | null {
  const walker = container.ownerDocument.createTreeWalker(container, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (element.contains(node)) continue;
    const parent = node.parentElement;
    if (parent && ['script', 'style', 'template', 'noscript'].includes(parent.localName)) continue;
    const text = short(node.textContent, 40);
    if (text && /^[^"'/>|[\]\\=]+$/.test(text)) return text;
  }
  return null;
}

/**
 * For elements no simple idea finds on its own (the same "Delete" button in every row): the simple
 * ideas inside the nearest containers with a role, picked by their text:
 * `role=listitem >> has-text=Apple >> role=button[name="Delete"]`.
 */
function scopedIdeas(element: Element): string[] {
  const own = locatorIdeas(element)
    .filter((idea) => idea.startsWith('role=') || idea.startsWith('text=') || idea.startsWith('label=') || idea.startsWith('placeholder='))
    .slice(0, 2);
  if (own.length === 0) return [];
  const ideas: string[] = [];
  let container = element.parentElement;
  for (let depth = 0; container && depth < 8 && ideas.length < 4; depth += 1, container = container.parentElement) {
    const role = getRole(container);
    if (!role || !SCOPE_ROLES.has(role)) continue;
    const text = distinctText(container, element);
    if (text) for (const idea of own) ideas.push(`role=${role} >> has-text=${text} >> ${idea}`);
  }
  return ideas;
}

/**
 * Up to `max` locators for `element`, best first: the {@link locatorIdeas} that match exactly this
 * element (else the {@link scopedIdeas} that do). The generated CSS selector is always appended last.
 */
export function locatorCandidates(element: Element, max = 5): string[] {
  let unique = locatorIdeas(element).filter((idea) => finds(idea, element));
  if (unique.length === 0) unique = scopedIdeas(element).filter((idea) => finds(idea, element));
  const css = generateSelector(element);
  return [...unique.slice(0, Math.max(0, max - 1)), ...(unique.includes(css) ? [] : [css])];
}

/**
 * The first idea that finds exactly this element, else the generated CSS selector. Same answer as
 * {@link bestLocator}, but stops at the first match, and with a `cache` shared between calls (one per
 * document, not kept across page changes) each idea is resolved once: page snapshots call it for
 * hundreds of elements.
 */
export function firstLocator(element: Element, cache?: Map<string, Element[]>): string {
  for (const idea of locatorIdeas(element)) if (finds(idea, element, cache)) return idea;
  for (const idea of scopedIdeas(element)) if (finds(idea, element, cache)) return idea;
  return generateSelector(element);
}

/** The first candidate, or the generated CSS selector. Used by the recorder and Detect fields. */
export function bestLocator(element: Element): string {
  return locatorCandidates(element)[0] ?? generateSelector(element);
}
