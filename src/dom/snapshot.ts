import { accessibleName, checkedState, getRole, withAriaMemo } from './aria';
import { firstLocator } from './bestLocator';
import { generateSelector } from './selector';
import { withFramePath } from './framePath';
import type { SnapshotElement, SnapshotResult } from '../core/page';

/**
 * Page snapshot for authoring (the `snapshot` page op): an outline of the accessibility tree, like
 * Playwright's ARIA snapshot, with a ready-made locator for every element a step could target.
 *
 *   - heading "Sign in" [level=1] [ref=e1] locator=role=heading[name="Sign in"]
 *   - textbox "Email" [ref=e2] locator=label="Email"
 *   - button "Sign in" [disabled] [ref=e3] locator=role=button[name="Sign in"]
 *   - list
 *     - listitem: Apples
 *
 * Hidden elements (display:none, visibility:hidden, `hidden`, aria-hidden) are left out. Open shadow
 * roots are walked as the browser renders them (slots filled) and marked `[shadow]` on their host;
 * same-origin frames are walked with `frame=… >> ` locators, other frames are marked `[cross-origin]`.
 *
 * Built in two passes: a cheap walk into a tree, then rendering until the line cap, so locators (the
 * expensive part) are only worked out for lines that are shown. Runs inside pages: DOM only.
 */

/** Roles a step can target: these get a `[ref]`, a locator and an entry in `elements`. */
const TARGETS = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
  'heading',
  'img',
  'dialog',
  'alertdialog',
  'table',
  'form',
]);
/** Landmarks and groups that are targets only when they have a name ("navigation "Breadcrumb""). */
const NAMED_TARGETS = new Set(['navigation', 'region', 'main', 'banner', 'contentinfo', 'complementary', 'group', 'list', 'listitem', 'article', 'tabpanel', 'menu', 'toolbar']);
/** Roles whose content is not walked (it is their value or their options). */
const LEAVES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'slider', 'spinbutton', 'img', 'progressbar', 'separator', 'meter']);
const SKIP_TAGS = new Set(['script', 'style', 'template', 'noscript', 'head', 'meta', 'link', 'title', 'base']);
const TEST_IDS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];
/** Time spent on readable locators before falling back to generated CSS (very big pages). */
const LOCATOR_BUDGET_MS = 4_000;
const MAX_TEXT = 120;
const MAX_NAME = 100;

interface TextItem {
  kind: 'text';
  text: string;
}
interface ElementItem {
  kind: 'element';
  element: Element;
  /** Null for a shadow host without a role (shown by tag name). */
  role: string | null;
  name: string;
  children: Item[];
  shadow: boolean;
  /** Frames: `same` (content walked), `cross` (cannot be read). */
  frame?: 'same' | 'cross';
  /** Locator prefix of the frames this element is in. */
  framePath: string[];
  inShadow: boolean;
}
type Item = TextItem | ElementItem;

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function quote(text: string): string {
  return JSON.stringify(text);
}

/** The role shown in the outline: aria.ts's role, plus fields aria.ts gives none (password, date, file...). */
function snapshotRole(element: Element): string | null {
  const role = getRole(element);
  if (role) return role === 'presentation' || role === 'none' || role === 'generic' ? null : role;
  if (element.localName === 'input') {
    const type = (element as HTMLInputElement).type;
    if (type === 'hidden') return null;
    return type === 'file' || type === 'color' ? 'button' : 'textbox';
  }
  const editable = element.getAttribute('contenteditable');
  if ((editable === '' || editable === 'true' || editable === 'plaintext-only') && !element.parentElement?.closest('[contenteditable]')) return 'textbox';
  return null;
}

/** Native selects and fields: their content is their value or options, shown on their own line. */
function isLeaf(element: Element, role: string): boolean {
  if (role === 'listbox' || role === 'combobox') return element.localName === 'select' || element.localName === 'input';
  return LEAVES.has(role);
}

function isDisabled(element: Element): boolean {
  if ((element as HTMLButtonElement).disabled === true) return true;
  if (element.closest('fieldset[disabled]') && !element.closest('legend')) return true;
  return element.closest('[aria-disabled="true"]') !== null;
}

/** What the composed (rendered) tree has under `node`: a shadow root's content, a slot's assigned nodes. */
function childrenOf(node: Element): Node[] {
  if (node.shadowRoot) return Array.from(node.shadowRoot.childNodes);
  if (node.localName === 'slot') {
    const assigned = (node as HTMLSlotElement).assignedNodes?.({ flatten: true }) ?? [];
    if (assigned.length > 0) return assigned;
  }
  return Array.from(node.childNodes);
}

/** CSS selectors of the same-origin frames from the top readable document down to `doc` (`[]` for the top). */
function framePathOf(doc: Document): string[] {
  const path: string[] = [];
  for (let current: Document = doc; ; ) {
    let frame: Element | null = null;
    try {
      frame = current.defaultView?.frameElement ?? null;
    } catch {
      frame = null;
    }
    if (!frame) return path;
    path.unshift(generateSelector(frame));
    current = frame.ownerDocument;
  }
}

export interface SnapshotOptions {
  maxLines: number;
  /** Clock, for the locator time budget (tests pass a fake one). */
  now?: () => number;
}

/** The outline of `root` (the page's body, or one element and its content). */
export function takeSnapshot(root: Element, options: SnapshotOptions): Omit<SnapshotResult, 'url' | 'title'> {
  // Locators for hundreds of elements ask for the same names and hidden states over and over.
  return withAriaMemo(() => snapshotOf(root, options));
}

function snapshotOf(root: Element, options: SnapshotOptions): Omit<SnapshotResult, 'url' | 'title'> {
  const now = options.now ?? (() => Date.now());
  const maxLines = Math.max(10, Math.floor(options.maxLines));
  // The walk stops collecting well past what can be shown, so a huge page does not cost a full walk.
  let budget = maxLines * 3;
  let cut = false;

  function hidden(element: Element): 'subtree' | 'self' | false {
    if (element.getAttribute('aria-hidden') === 'true' || (element.hasAttribute('hidden') && element.getAttribute('hidden') !== 'until-found')) return 'subtree';
    const view = element.ownerDocument.defaultView;
    if (!view) return false;
    const style = view.getComputedStyle(element);
    if (style.display === 'none') return 'subtree';
    // visibility is inherited but a child can be visible again.
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return 'self';
    return false;
  }

  function build(nodes: Node[], framePath: string[], inShadow: boolean, skipText: boolean, into: Item[] = []): Item[] {
    for (const node of nodes) {
      if (budget <= 0) {
        cut = true;
        return into;
      }
      if (node.nodeType === 3) {
        if (skipText) continue;
        const text = normalize(node.textContent ?? '');
        if (!text) continue;
        const last = into[into.length - 1];
        if (last?.kind === 'text') last.text = `${last.text} ${text}`;
        else {
          into.push({ kind: 'text', text });
          budget -= 1;
        }
        continue;
      }
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      if (SKIP_TAGS.has(element.localName)) continue;
      const hide = hidden(element);
      if (hide === 'subtree') continue;
      // visibility:hidden hides the element's own text; its children decide for themselves.
      const hideText = skipText || hide === 'self';
      const childShadow = inShadow || element.shadowRoot !== null;

      if (element.localName === 'iframe' || element.localName === 'frame') {
        if (hide) continue;
        let inner: Document | null = null;
        try {
          inner = (element as HTMLIFrameElement).contentDocument;
        } catch {
          inner = null;
        }
        const item: ElementItem = {
          kind: 'element',
          element,
          role: 'iframe',
          name: normalize(element.getAttribute('title') ?? element.getAttribute('name') ?? ''),
          children: [],
          shadow: false,
          frame: inner ? 'same' : 'cross',
          framePath,
          inShadow,
        };
        budget -= 1;
        into.push(item);
        const body = inner?.body ?? inner?.documentElement;
        if (body) item.children = build(childrenOf(body), [...framePath, generateSelector(element)], false, false);
        continue;
      }

      const role = hide ? null : snapshotRole(element);
      // A label's text is the name of its field, which has its own line.
      const labelText = element.localName === 'label' && (element as HTMLLabelElement).control != null;
      if (!role) {
        if (element.shadowRoot && !hide) {
          budget -= 1;
          into.push({ kind: 'element', element, role: null, name: '', children: build(childrenOf(element), framePath, childShadow, hideText), shadow: true, framePath, inShadow });
        } else {
          build(childrenOf(element), framePath, childShadow, hideText || labelText, into);
        }
        continue;
      }
      const target = TARGETS.has(role) || TEST_IDS.some((attribute) => element.hasAttribute(attribute));
      const labelled = element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby');
      // Names from content cost a walk of the content: only worked out where they are shown.
      const name = target || labelled || NAMED_TARGETS.has(role) ? normalize(accessibleName(element)) : '';
      budget -= 1;
      into.push({
        kind: 'element',
        element,
        role,
        name,
        children: isLeaf(element, role) ? [] : build(childrenOf(element), framePath, childShadow, false),
        shadow: element.shadowRoot !== null,
        framePath,
        inShadow,
      });
    }
    return into;
  }

  // A part of the page is its own first line; it may sit in a same-origin frame (`frame=#pay >> form`).
  const whole = root.localName === 'body' || root === root.ownerDocument.documentElement;
  const items = whole ? build(childrenOf(root), [], false, false) : build([root], framePathOf(root.ownerDocument), false, false);

  // --- render ---------------------------------------------------------------

  const lines: string[] = [];
  const elements: SnapshotElement[] = [];
  const locatorDeadline = now() + LOCATOR_BUDGET_MS;
  /** Set when rendering reaches the line cap. */
  let stopped = false;
  let refs = 0;
  // Locator results per document: 400 "Edit" buttons try the same ideas, which are resolved once.
  const caches = new Map<Document, Map<string, Element[]>>();

  function locatorFor(item: ElementItem): string {
    const doc = item.element.ownerDocument;
    let cache = caches.get(doc);
    if (!cache) caches.set(doc, (cache = new Map()));
    const inner = item.frame ? generateSelector(item.element) : now() < locatorDeadline ? firstLocator(item.element, cache) : generateSelector(item.element);
    // A frame's own locator is the `frame=` step that later steps continue from.
    return withFramePath(item.framePath, item.frame ? `frame=${inner}` : inner);
  }

  function isTarget(item: ElementItem): boolean {
    if (item.frame) return true;
    if (!item.role) return TEST_IDS.some((attribute) => item.element.hasAttribute(attribute));
    if (TARGETS.has(item.role) || TEST_IDS.some((attribute) => item.element.hasAttribute(attribute))) return true;
    return NAMED_TARGETS.has(item.role) && item.name !== '' && (item.element.hasAttribute('aria-label') || item.element.hasAttribute('aria-labelledby') || item.role === 'region');
  }

  function render(list: Item[], depth: number): void {
    for (const item of list) {
      if (lines.length >= maxLines - 1) {
        stopped = true;
        return;
      }
      const indent = '  '.repeat(depth);
      if (item.kind === 'text') {
        lines.push(`${indent}- text: ${clip(item.text, MAX_TEXT)}`);
        continue;
      }
      const { element, role } = item;
      const target = isTarget(item);
      const onlyText = item.children.length > 0 && item.children.every((child) => child.kind === 'text');
      let head = `${indent}- ${role ?? element.localName}`;
      // Structural roles (lists, rows...) take their name from their content: shown only when labelled.
      const showName = item.name !== '' && (target || element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby'));
      if (showName) head += ` ${quote(clip(item.name, MAX_NAME))}`;

      const entry: SnapshotElement = { ref: '', role: role ?? element.localName, name: item.name, tag: element.localName };
      const flags: string[] = [];
      if (item.frame === 'same') flags.push('frame');
      if (item.frame === 'cross') {
        flags.push('cross-origin');
        const src = (element as HTMLIFrameElement).src || element.getAttribute('src') || '';
        if (src) flags.push(`src=${quote(clip(src, MAX_TEXT))}`);
      }
      if (item.shadow) flags.push('shadow');
      if (role === 'heading') {
        const level = Number(element.getAttribute('aria-level') ?? /^h([1-6])$/.exec(element.localName)?.[1] ?? 2);
        flags.push(`level=${level}`);
        entry.level = level;
      }
      const checked = role ? checkedState(element) : null;
      if (checked !== null || element.getAttribute('aria-checked') === 'mixed') {
        const state = element.getAttribute('aria-checked') === 'mixed' || (element as HTMLInputElement).indeterminate ? 'mixed' : checked === true;
        if (state === 'mixed') flags.push('checked=mixed');
        else if (state) flags.push('checked');
        entry.checked = state;
      }
      if (target && role && isDisabled(element)) {
        flags.push('disabled');
        entry.disabled = true;
      }
      for (const attribute of ['expanded', 'selected', 'pressed']) {
        const value = element.getAttribute(`aria-${attribute}`);
        if (value === 'true') flags.push(attribute);
        else if (value === 'false' && attribute === 'expanded') flags.push('expanded=false');
      }
      if ((element as HTMLInputElement).required === true || element.getAttribute('aria-required') === 'true') flags.push('required');
      if (role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'spinbutton' || role === 'slider') {
        const field = element as HTMLInputElement;
        if (field.type === 'password') flags.push('password');
        else {
          const value =
            element.localName === 'select'
              ? Array.from((element as HTMLSelectElement).selectedOptions, (option) => normalize(option.label || option.value)).join(' | ')
              : 'value' in element && typeof field.value === 'string'
                ? field.value
                : role === 'textbox'
                  ? normalize(element.textContent ?? '')
                  : '';
          if (value) {
            flags.push(`value=${quote(clip(value, MAX_TEXT))}`);
            entry.value = value;
          }
        }
      }
      if (element.localName === 'select') {
        const options = Array.from((element as HTMLSelectElement).options).map((option) => normalize(option.label || option.value)).filter(Boolean);
        if (options.length > 0) flags.push(`options=${quote(clip(options.slice(0, 10).join(' | ') + (options.length > 10 ? ` | … (${options.length})` : ''), 300))}`);
      }
      if (role === 'link') {
        const href = element.getAttribute('href') ?? '';
        if (href) {
          flags.push(`url=${quote(clip(href, MAX_TEXT))}`);
          entry.url = (element as HTMLAnchorElement).href || href;
        }
      }
      if (element.localName === 'input' && ['date', 'time', 'datetime-local', 'month', 'week', 'number', 'file', 'color', 'email', 'tel', 'url'].includes((element as HTMLInputElement).type)) {
        flags.push(`type=${(element as HTMLInputElement).type}`);
      }
      for (const flag of flags) head += ` [${flag}]`;
      // Content that is only text: a name already says it; without a name it is shown inline.
      const inline = onlyText && !showName ? `: ${clip((item.children as TextItem[]).map((child) => child.text).join(' '), MAX_TEXT)}` : '';

      if (target) {
        refs += 1;
        entry.ref = `e${refs}`;
        entry.locator = locatorFor(item);
        if (item.framePath.length > 0) entry.inFrame = true;
        if (item.inShadow) entry.inShadow = true;
        elements.push(entry);
        head += ` [ref=${entry.ref}]${inline} locator=${entry.locator}`;
      } else head += inline;
      lines.push(head);
      if (onlyText) continue;
      render(item.children, depth + 1);
      if (stopped) return;
    }
  }

  render(items, 0);
  const truncated = cut || stopped;
  if (truncated) {
    lines.push(`- … truncated at ${lines.length} lines: snapshot one part of the page (a locator) to see the rest`);
  }
  return { snapshot: lines.join('\n'), elements, lines: lines.length, truncated };
}
