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

/** The locator resolves (from the element's document) to exactly this element. */
function finds(locator: string, element: Element): boolean {
  try {
    const found = resolveLocator(locator, element.ownerDocument);
    return found.length === 1 && found[0] === element;
  } catch {
    return false;
  }
}

/**
 * Up to `max` locators for `element`, best first. Ideas are tried in this order and kept only if
 * they match exactly this element: testid, label / placeholder (form fields), role+name,
 * role+name exact (not form fields), text (not form fields), alt, title, `tag[name=...]` (form
 * fields; radios add `[value=...]`). The generated CSS selector is always appended last.
 */
export function locatorCandidates(element: Element, max = 5): string[] {
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

  const unique = [...new Set(ideas)].filter((idea) => finds(idea, element));
  const css = generateSelector(element);
  return [...unique.slice(0, Math.max(0, max - 1)), ...(unique.includes(css) ? [] : [css])];
}

/** The first candidate, or the generated CSS selector. Used by the recorder and Detect fields. */
export function bestLocator(element: Element): string {
  return locatorCandidates(element)[0] ?? generateSelector(element);
}
