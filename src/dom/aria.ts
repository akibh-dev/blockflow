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
  // A slot shows the nodes assigned to it (shadow DOM), or its own fallback content.
  const assigned = tag === 'slot' ? ((element as HTMLSlotElement).assignedNodes?.({ flatten: true }) ?? []) : [];
  for (const child of assigned.length > 0 ? assigned : Array.from(element.childNodes)) text += textOf(child, seen);
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

/** Results remembered while {@link withAriaMemo} runs. */
let memo: { names: Map<Element, string>; hidden: Map<Element, boolean> } | null = null;

/**
 * Runs `fn` with names and hidden states remembered per element. Only for synchronous work that does
 * not change the page: a page snapshot resolves hundreds of locators, each asking the same elements again.
 */
export function withAriaMemo<T>(fn: () => T): T {
  if (memo) return fn();
  memo = { names: new Map(), hidden: new Map() };
  try {
    return fn();
  } finally {
    memo = null;
  }
}

/** The name a screen reader would announce for the element. */
export function accessibleName(element: Element): string {
  if (!memo) return computeName(element);
  let name = memo.names.get(element);
  if (name === undefined) memo.names.set(element, (name = computeName(element)));
  return name;
}

function computeName(element: Element): string {
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
  // A <section> without a role attribute is a region only when it has a name, so asking getRole here would
  // come straight back (endless recursion). Regions never take their name from content anyway.
  const role = element.localName === 'section' && !element.hasAttribute('role') ? null : getRole(element);
  if (role && NAME_FROM_CONTENT.has(role)) {
    const text = normalize(textOf(element, new Set()));
    if (text) return text;
  }
  return normalize(element.getAttribute('title') ?? '');
}

/** Hidden from assistive technology: aria-hidden, the hidden attribute, or display:none / visibility:hidden. */
export function isHiddenForAria(element: Element): boolean {
  if (!memo) return computeHidden(element);
  let hidden = memo.hidden.get(element);
  if (hidden === undefined) memo.hidden.set(element, (hidden = computeHidden(element)));
  return hidden;
}

function computeHidden(element: Element): boolean {
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

/** `aria-pressed` of toggle buttons: true / false, null when the element has none (or "mixed"). */
export function pressedState(element: Element): boolean | null {
  const aria = element.getAttribute('aria-pressed');
  return aria === 'true' ? true : aria === 'false' ? false : null;
}

/** `aria-expanded` (menus, accordions, comboboxes): null when the element does not say. */
export function expandedState(element: Element): boolean | null {
  const aria = element.getAttribute('aria-expanded');
  return aria === 'true' ? true : aria === 'false' ? false : null;
}

/** Selected: a native `<option>`'s `selected`, else `aria-selected` (tabs, grid cells, rows); null when neither. */
export function selectedState(element: Element): boolean | null {
  if (element.localName === 'option') return (element as HTMLOptionElement).selected;
  const aria = element.getAttribute('aria-selected');
  return aria === 'true' ? true : aria === 'false' ? false : null;
}

const NATIVE_DISABLED = new Set(['button', 'input', 'select', 'textarea', 'option', 'optgroup', 'fieldset']);

/**
 * Disabled as Playwright's getByRole sees it: a native control with `disabled` (or inside a disabled
 * fieldset, outside its first legend, or a disabled optgroup), or `aria-disabled="true"` on it or an
 * ancestor. Always true or false.
 */
export function disabledState(element: Element): boolean {
  if (NATIVE_DISABLED.has(element.localName)) {
    if (element.hasAttribute('disabled')) return true;
    const fieldset = element.parentElement?.closest('fieldset[disabled]');
    if (fieldset) {
      const legend = fieldset.querySelector(':scope > legend');
      if (!legend || !legend.contains(element)) return true;
    }
    if (element.localName === 'option' && element.closest('optgroup[disabled]')) return true;
  }
  return element.closest('[aria-disabled="true"]') !== null;
}

/**
 * The description a screen reader adds after the name: `aria-describedby` text, else
 * `aria-description`, else `title` when the title did not already give the name.
 */
export function accessibleDescription(element: Element): string {
  const describedBy = element.getAttribute('aria-describedby');
  if (describedBy) {
    const text = normalize(byIds(element, describedBy));
    if (text) return text;
  }
  const description = normalize(element.getAttribute('aria-description') ?? '');
  if (description) return description;
  const title = normalize(element.getAttribute('title') ?? '');
  return title && title !== accessibleName(element) ? title : '';
}
