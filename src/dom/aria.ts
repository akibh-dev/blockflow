/**
 * Just enough of ARIA to find elements the way a user (or a screen reader) describes them:
 * "the Submit button", "the Email textbox". A simplified version of the HTML-AAM role mapping and
 * the accessible name algorithm, the same idea Playwright's getByRole uses.
 *
 * Runs inside web pages: no imports from the extension, DOM only.
 */

const INPUT_ROLES: Record<string, string> = {
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  number: 'spinbutton',
  email: 'textbox',
  tel: 'textbox',
  text: 'textbox',
  url: 'textbox',
  search: 'searchbox',
};

const TAG_ROLES: Record<string, string> = {
  button: 'button',
  textarea: 'textbox',
  option: 'option',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  ul: 'list',
  ol: 'list',
  menu: 'list',
  li: 'listitem',
  nav: 'navigation',
  main: 'main',
  header: 'banner',
  footer: 'contentinfo',
  aside: 'complementary',
  form: 'form',
  dialog: 'dialog',
  table: 'table',
  tr: 'row',
  td: 'cell',
  th: 'columnheader',
  article: 'article',
  fieldset: 'group',
  hr: 'separator',
  progress: 'progressbar',
  output: 'status',
  p: 'paragraph',
};

/** Roles whose name comes from their text content. */
const NAME_FROM_CONTENT = new Set([
  'button',
  'link',
  'heading',
  'cell',
  'columnheader',
  'rowheader',
  'option',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'checkbox',
  'radio',
  'switch',
  'treeitem',
  'tooltip',
  'listitem',
  'row',
]);

/**
 * Explicit `role` (first token) or the implicit role from INPUT_ROLES / TAG_ROLES and a few special
 * cases (links need href, select is combobox or listbox, img with alt="" is presentation, section
 * is region only when named). Null when the element has no role in this model.
 */
export function getRole(element: Element): string | null {
  const explicit = element.getAttribute('role')?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  const tag = element.localName;
  if (tag === 'input') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase();
    if ((type === 'text' || type === 'search' || type === 'email' || type === 'tel' || type === 'url') && element.hasAttribute('list')) {
      return 'combobox';
    }
    return INPUT_ROLES[type] ?? (type === '' ? 'textbox' : null);
  }
  if (tag === 'a' || tag === 'area') return element.hasAttribute('href') ? 'link' : null;
  if (tag === 'select') {
    const select = element as HTMLSelectElement;
    return select.multiple || select.size > 1 ? 'listbox' : 'combobox';
  }
  if (tag === 'img') return element.getAttribute('alt') === '' ? 'presentation' : 'img';
  if (tag === 'section') return accessibleName(element) ? 'region' : null;
  return TAG_ROLES[tag] ?? null;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Name-from-content text: skips aria-hidden/hidden/script/style, uses aria-label and img alt, spaces block elements. */
function textOf(node: Node, seen: Set<Node>): string {
  if (seen.has(node)) return '';
  seen.add(node);
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const element = node as Element;
  if (element.getAttribute('aria-hidden') === 'true' || element.hasAttribute('hidden')) return '';
  const tag = element.localName;
  if (tag === 'script' || tag === 'style' || tag === 'template' || tag === 'noscript') return '';
  const label = element.getAttribute('aria-label');
  if (label) return ` ${label} `;
  if (tag === 'img') return ` ${element.getAttribute('alt') ?? ''} `;
  if (tag === 'input') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'button' || type === 'submit' || type === 'reset') return ` ${(element as HTMLInputElement).value} `;
    return '';
  }
  let text = '';
  for (const child of element.childNodes) text += textOf(child, seen);
  // Block-level children read as separate words.
  return /^(div|p|li|h[1-6]|br|tr|td|th|section|article)$/.test(tag) ? ` ${text} ` : text;
}

function byIds(element: Element, ids: string): string {
  const root = element.getRootNode() as Document | ShadowRoot;
  return ids
    .split(/\s+/)
    .map((id) => {
      const target = root.getElementById?.(id) ?? element.ownerDocument.getElementById(id);
      return target ? textOf(target, new Set()) : '';
    })
    .join(' ');
}

function labelsText(element: Element): string {
  const labels = (element as HTMLInputElement).labels;
  if (!labels || labels.length === 0) return '';
  return Array.from(labels)
    .map((label) => textOf(label, new Set([element])))
    .join(' ');
}

/** The name a screen reader would announce for the element. */
export function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const name = normalize(byIds(element, labelledBy));
    if (name) return name;
  }
  const ariaLabel = normalize(element.getAttribute('aria-label') ?? '');
  if (ariaLabel) return ariaLabel;

  const tag = element.localName;
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    const type = (element.getAttribute('type') ?? '').toLowerCase();
    if (tag === 'input' && (type === 'button' || type === 'submit' || type === 'reset')) {
      const value = (element as HTMLInputElement).value;
      return normalize(value || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : ''));
    }
    if (tag === 'input' && type === 'image') return normalize(element.getAttribute('alt') ?? '');
    const fromLabels = normalize(labelsText(element));
    if (fromLabels) return fromLabels;
    return normalize(element.getAttribute('title') ?? element.getAttribute('placeholder') ?? '');
  }
  if (tag === 'img' || tag === 'area') return normalize(element.getAttribute('alt') ?? element.getAttribute('title') ?? '');
  if (tag === 'fieldset') {
    const legend = element.querySelector(':scope > legend');
    if (legend) return normalize(textOf(legend, new Set()));
  }
  if (tag === 'table') {
    const caption = element.querySelector(':scope > caption');
    if (caption) return normalize(textOf(caption, new Set()));
  }
  const role = getRole(element);
  if (role && NAME_FROM_CONTENT.has(role)) {
    const text = normalize(textOf(element, new Set()));
    if (text) return text;
  }
  return normalize(element.getAttribute('title') ?? '');
}

/** Hidden from assistive technology: aria-hidden, the hidden attribute, or display:none / visibility:hidden. */
export function isHiddenForAria(element: Element): boolean {
  if (element.closest('[aria-hidden="true"], [hidden]')) return true;
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = view.getComputedStyle(current);
    if (style.display === 'none') return true;
    if (current === element && style.visibility === 'hidden') return true;
  }
  return false;
}

/** checked state for checkboxes, radios and switches (native or ARIA). */
export function checkedState(element: Element): boolean | null {
  const tag = element.localName;
  if (tag === 'input') {
    const type = (element as HTMLInputElement).type;
    if (type === 'checkbox' || type === 'radio') return (element as HTMLInputElement).checked;
  }
  const aria = element.getAttribute('aria-checked') ?? element.getAttribute('aria-pressed');
  if (aria === 'true') return true;
  if (aria === 'false') return false;
  return null;
}
