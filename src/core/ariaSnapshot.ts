/**
 * ARIA snapshot templates (Assert `aria-snapshot`, M5.4): the expected shape of a page's accessibility
 * tree, written like Playwright's `toMatchAriaSnapshot`, matched against the page outline that the
 * `snapshot` page op makes (src/dom/snapshot.ts).
 *
 *   - heading "Welcome" [level=1]
 *   - navigation "Main":
 *     - link /Prices|Shop/
 *   - list:
 *     - listitem: Apples
 *   - text: "Total: 3"
 *
 * Both texts are parsed into the same tree (`AriaNode`): the template by `parseAriaTemplate` (errors
 * carry a line and column), the outline by `parseAriaOutline` (BlockFlow's `[ref=…]` and `locator=…`
 * hints are dropped). `matchAriaSnapshot` then matches like Playwright: listed nodes must be on the page
 * in the same order, unlisted nodes are allowed, children are matched as a subsequence of the direct
 * children, a name is "exact" (after whitespace is collapsed) or a /regex/, and only the states a
 * template line lists are checked. On a mismatch it explains which template line found nothing and
 * shows the nearest part of the page. Pure: no DOM, no browser APIs.
 */

/** A text value as written: matched by its normalised form, its raw form, or as /regex/ when raw is one. */
export interface TextValue {
  raw: string;
  normalized: string;
}

/** An exact accessible name (normalised), or a regular expression (`{ pattern }`, no flags). */
export type NameMatch = string | { pattern: string };

/** How a node's children are compared: `contain` (default, subsequence), `equal` (same list), `deep-equal`. */
export type ChildrenMode = 'contain' | 'equal' | 'deep-equal';

/** An element line (`- role "name" [states]`), or the root (`role: 'fragment'`). */
export interface AriaRole {
  kind: 'role';
  role: string;
  name?: NameMatch;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  level?: number;
  pressed?: boolean | 'mixed';
  selected?: boolean;
  /** A link's URL (`- /url: …` in a template, `[url="…"]` in the outline). */
  url?: TextValue;
  /**
   * BlockFlow-only states that the outline shows and Playwright templates do not have: `required`,
   * `password`, `shadow`, `frame`, `cross-origin` ("true"), `type`, `src`, `options` (their value).
   */
  extra?: Record<string, string>;
  mode?: ChildrenMode;
  children: AriaNode[];
  /** 1-based line in the text it was parsed from (0 for the root). */
  line: number;
}

/** A `- text: …` line, or the text after `role: ` (a field's value, an element's only text). */
export interface AriaText {
  kind: 'text';
  text: TextValue;
  line: number;
}

export type AriaNode = AriaRole | AriaText;

/** A template that cannot be parsed. `line` and `column` are 1-based, in the text as written. */
export class AriaTemplateError extends Error {
  constructor(
    readonly reason: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`line ${line}, column ${column}: ${reason}`);
    this.name = 'AriaTemplateError';
  }
}

/** The outline of a page as a tree, and whether the outline was cut at its line limit. */
export interface AriaOutline {
  root: AriaRole;
  truncated: boolean;
}

/** The result of `matchAriaSnapshot`. `message` explains a mismatch; `actual` is the page in template form. */
export interface AriaMatchResult {
  pass: boolean;
  message: string;
  actual: string;
}

// Mirrors src/dom/snapshot.ts: names and texts longer than this are cut there and end with "…".
const CLIPPED_AT = 99;
const TRISTATE = new Set(['checked', 'pressed']);
const BOOLEANS = new Set(['disabled', 'expanded', 'selected']);
const EXTRA_FLAGS = new Set(['required', 'password', 'shadow', 'frame', 'cross-origin']);
const EXTRA_VALUES = new Set(['type', 'src', 'options']);
/** Failure messages show at most this many lines of the page. */
const SHOWN_LINES = 20;
const SHOWN_WIDTH = 120;

/** Like Playwright: zero-width characters dropped, whitespace runs collapsed, trimmed. */
export function normalizeAriaText(text: string): string {
  return text.replace(/[​­]/g, '').replace(/\s+/g, ' ').trim();
}

function textValue(raw: string): TextValue {
  return { raw, normalized: normalizeAriaText(raw) };
}

// --- parsing ---------------------------------------------------------------

type Mode = 'template' | 'outline';

/** Reads one `role "name" [state…]` key, Playwright's grammar plus BlockFlow's outline annotations. */
class KeyReader {
  pos = 0;
  hadRef = false;
  /** `[value="…"]` (outline): the field's value, which Playwright shows as the element's text. */
  value: string | undefined;

  constructor(
    private readonly input: string,
    private readonly line: number,
    /** 1-based column of `input[0]` in the original line. */
    private readonly column: number,
    private readonly mode: Mode,
  ) {}

  fail(message: string, at = this.pos): never {
    throw new AriaTemplateError(message, this.line, this.column + at);
  }

  peek(): string {
    return this.input[this.pos] ?? '';
  }

  eof(): boolean {
    return this.pos >= this.input.length;
  }

  skipSpace(): void {
    while (!this.eof() && /\s/.test(this.peek())) this.pos += 1;
  }

  /** A JSON-style string after its opening `"`. */
  readString(): string {
    const start = this.pos - 1;
    let out = '';
    while (!this.eof()) {
      const ch = this.input[this.pos++] as string;
      if (ch === '"') return out;
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const next = this.input[this.pos++] ?? '';
      const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
      if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(this.input.slice(this.pos, this.pos + 4))) {
        out += String.fromCharCode(parseInt(this.input.slice(this.pos, this.pos + 4), 16));
        this.pos += 4;
      } else out += simple[next] ?? next;
    }
    return this.fail('the quoted text is not closed (missing ")', start);
  }

  /** A regular expression after its opening `/`. */
  readRegex(): { pattern: string } {
    const start = this.pos - 1;
    let pattern = '';
    let escaped = false;
    let inClass = false;
    while (!this.eof()) {
      const ch = this.input[this.pos++] as string;
      if (escaped) {
        pattern += ch;
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
        pattern += ch;
      } else if (ch === '/' && !inClass) {
        if (/[a-z]/i.test(this.peek())) this.fail('regular expression flags are not supported (Playwright templates have none); write the pattern to match either case, e.g. /[Ss]ign in/');
        try {
          new RegExp(pattern);
        } catch (error) {
          this.fail(`invalid regular expression /${pattern}/: ${error instanceof Error ? error.message : String(error)}`, start);
        }
        return { pattern };
      } else {
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        pattern += ch;
      }
    }
    return this.fail('the regular expression is not closed (missing /)', start);
  }

  /**
   * Parses the key into `node`. Returns the index just after a top-level `:` (where the value starts),
   * or null when the line has no value.
   */
  read(node: AriaRole): number | null {
    this.skipSpace();
    const roleStart = this.pos;
    const role = /^[A-Za-z][A-Za-z0-9-]*/.exec(this.input.slice(this.pos))?.[0];
    if (!role) this.fail(this.eof() ? 'expected a role after "- " (heading, button, link, text: …)' : `expected a role (heading, button, link…), found "${this.peek()}"`);
    this.pos += role.length;
    node.role = role;
    if (role === 'text' && this.mode === 'template') this.fail('write text as `- text: the text` (with a colon)', roleStart);
    this.skipSpace();
    if (this.peek() === '"') {
      this.pos += 1;
      const name = this.readString();
      node.name = this.mode === 'template' ? normalizeAriaText(name) : name;
    } else if (this.peek() === '/' && this.mode === 'template') {
      this.pos += 1;
      node.name = this.readRegex();
    }
    for (;;) {
      this.skipSpace();
      if (this.peek() !== '[') break;
      this.readAttribute(node);
    }
    this.skipSpace();
    if (this.eof()) return null;
    if (this.peek() === ':') return this.pos + 1;
    if (this.hadRef && this.input.startsWith('locator=', this.pos)) return null;
    if (this.mode === 'template' && this.peek() === '#') return null;
    return this.fail(`unexpected "${this.input.slice(this.pos, this.pos + 20)}" (a line is \`- role "name" [state]\`, then ":" for a value or nested lines)`);
  }

  private readAttribute(node: AriaRole): void {
    const open = this.pos;
    this.pos += 1;
    this.skipSpace();
    const keyAt = this.pos;
    const key = /^[A-Za-z][A-Za-z0-9-]*/.exec(this.input.slice(this.pos))?.[0];
    if (!key) this.fail('expected a state name after "[" (checked, disabled, expanded, level, pressed, selected)');
    this.pos += key.length;
    this.skipSpace();
    let value = 'true';
    let valueAt = this.pos;
    if (this.peek() === '=') {
      this.pos += 1;
      this.skipSpace();
      valueAt = this.pos;
      if (this.peek() === '"') {
        this.pos += 1;
        value = this.readString();
      } else {
        let raw = '';
        while (!this.eof() && this.peek() !== ']' && !/\s/.test(this.peek())) raw += this.input[this.pos++];
        if (!raw) this.fail(`expected a value after "${key}="`);
        value = raw;
      }
      this.skipSpace();
    }
    if (this.peek() !== ']') this.fail(this.eof() ? `"[" at column ${this.column + open} is not closed (missing ])` : `expected "]" after [${key}…`);
    this.pos += 1;
    this.apply(node, key, value, keyAt, valueAt);
  }

  private apply(node: AriaRole, key: string, value: string, keyAt: number, valueAt: number): void {
    const bad = (what: string) => this.fail(`[${key}=${value}]: the value must be ${what}`, valueAt);
    if (TRISTATE.has(key)) {
      if (value !== 'true' && value !== 'false' && value !== 'mixed') bad('true, false or mixed');
      (node as unknown as Record<string, unknown>)[key] = value === 'mixed' ? 'mixed' : value === 'true';
    } else if (BOOLEANS.has(key)) {
      if (value !== 'true' && value !== 'false') bad('true or false');
      (node as unknown as Record<string, unknown>)[key] = value === 'true';
    } else if (key === 'level') {
      if (!/^\d+$/.test(value)) bad('a number (heading level 1 to 6)');
      node.level = Number(value);
    } else if (key === 'ref') {
      this.hadRef = true;
    } else if (key === 'url') {
      node.url = textValue(value);
    } else if (key === 'value') {
      this.value = value;
    } else if (EXTRA_FLAGS.has(key)) {
      if (value !== 'true' && value !== 'false') bad('true or false');
      node.extra = { ...node.extra, [key]: value };
    } else if (EXTRA_VALUES.has(key)) {
      node.extra = { ...node.extra, [key]: value };
    } else if (key === 'active' || key === 'invalid') {
      this.fail(`[${key}] is a Playwright state that BlockFlow's page outline does not record; remove it`, keyAt);
    } else {
      this.fail(`unknown state [${key}] (use checked, disabled, expanded, level, pressed or selected)`, keyAt);
    }
  }
}

/** A YAML-style scalar value: "double quoted", 'single quoted' or plain (a ` #` starts a comment). */
function readValue(text: string, line: number, column: number): string {
  const trimmed = text.replace(/^\s+/, '');
  const at = column + (text.length - trimmed.length);
  if (trimmed.startsWith('"')) {
    const reader = new KeyReader(trimmed, line, at, 'template');
    reader.pos = 1;
    const value = reader.readString();
    const rest = trimmed.slice(reader.pos).trim();
    if (rest && !rest.startsWith('#')) throw new AriaTemplateError(`unexpected "${rest.slice(0, 20)}" after the quoted value`, line, at + reader.pos);
    return value;
  }
  if (trimmed.startsWith("'")) {
    let out = '';
    let index = 1;
    for (;;) {
      if (index >= trimmed.length) throw new AriaTemplateError("the quoted value is not closed (missing ')", line, at);
      const ch = trimmed[index] as string;
      if (ch === "'" && trimmed[index + 1] === "'") {
        out += "'";
        index += 2;
      } else if (ch === "'") break;
      else {
        out += ch;
        index += 1;
      }
    }
    const rest = trimmed.slice(index + 1).trim();
    if (rest && !rest.startsWith('#')) throw new AriaTemplateError(`unexpected "${rest.slice(0, 20)}" after the quoted value`, line, at + index + 1);
    return out;
  }
  const comment = trimmed.search(/\s#/);
  return (comment >= 0 ? trimmed.slice(0, comment) : trimmed).trim();
}

/** A YAML-quoted whole key (`- 'button "a: b"': value`): the key's text and what follows it. */
function unquoteKey(content: string, line: number, column: number): { key: string; rest: string; keyColumn: number } {
  const quote = content[0];
  if (quote === '"') {
    const reader = new KeyReader(content, line, column, 'template');
    reader.pos = 1;
    const key = reader.readString();
    return { key, rest: content.slice(reader.pos), keyColumn: column + 1 };
  }
  let key = '';
  let index = 1;
  for (;;) {
    if (index >= content.length) throw new AriaTemplateError("the quoted line is not closed (missing ')", line, column);
    const ch = content[index] as string;
    if (ch === "'" && content[index + 1] === "'") {
      key += "'";
      index += 2;
    } else if (ch === "'") break;
    else {
      key += ch;
      index += 1;
    }
  }
  return { key, rest: content.slice(index + 1), keyColumn: column + 1 };
}

interface Frame {
  indent: number;
  node: AriaRole | null;
  /** Line that started this frame, for "cannot have nested lines" errors. */
  line: number;
  /** Why nested lines are not allowed here (it has a value, it is text...), or null. */
  closed: string | null;
  childIndent?: number;
}

function parseText(text: string, mode: Mode, locators: Map<string, string>): AriaOutline {
  const lines = text.split(/\r?\n/);
  const root: AriaRole = { kind: 'role', role: 'fragment', children: [], line: 0 };
  let truncated = false;

  // Templates are often pasted indented (as in a Playwright test): drop the common indentation.
  let common = Infinity;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || (mode === 'template' && trimmed.startsWith('#'))) continue;
    common = Math.min(common, /^ */.exec(line)?.[0].length ?? 0);
  }
  if (!Number.isFinite(common)) common = 0;

  const stack: Frame[] = [{ indent: -1, node: root, line: 0, closed: null }];
  lines.forEach((original, index) => {
    const lineNo = index + 1;
    const trimmed = original.trim();
    if (!trimmed || (mode === 'template' && trimmed.startsWith('#'))) return;
    const tab = /^[ ]*\t/.exec(original);
    if (tab && mode === 'template') throw new AriaTemplateError('indent with spaces, not tabs', lineNo, tab[0].length);
    const line = original.slice(Math.min(common, /^ */.exec(original)?.[0].length ?? 0));
    const indent = /^ */.exec(line)?.[0].length ?? 0;
    const offset = original.length - line.length;
    if (!line.startsWith('-', indent)) {
      if (mode === 'outline') return;
      throw new AriaTemplateError('expected a list item starting with "- " (e.g. - heading "Welcome")', lineNo, offset + indent + 1);
    }
    if (line.length > indent + 1 && line[indent + 1] !== ' ') {
      if (mode === 'outline') return;
      throw new AriaTemplateError('put a space after "-"', lineNo, offset + indent + 2);
    }
    const contentStart = indent + 2;
    const content = line.slice(contentStart).replace(/\s+$/, '');
    const column = offset + contentStart + 1;
    if (!content) {
      if (mode === 'outline') return;
      throw new AriaTemplateError('empty list item', lineNo, offset + indent + 1);
    }
    if (mode === 'outline' && content.startsWith('…')) {
      truncated = true;
      return;
    }

    while ((stack[stack.length - 1] as Frame).indent >= indent) stack.pop();
    const parent = stack[stack.length - 1] as Frame;
    if (mode === 'template') {
      if (parent.childIndent !== undefined && parent.childIndent !== indent) {
        throw new AriaTemplateError(`this line is indented ${indent} spaces, its sibling lines ${parent.childIndent}: line up nested lines`, lineNo, offset + 1);
      }
      if (parent.closed) throw new AriaTemplateError(`line ${parent.line} ${parent.closed}, so it cannot have nested lines`, lineNo, offset + indent + 1);
    }
    parent.childIndent ??= indent;
    const container = parent.node ?? root;

    try {
      parseItem(content, lineNo, column, mode, locators, container, (frame) => stack.push({ ...frame, indent, line: lineNo }));
    } catch (error) {
      if (mode === 'outline') return;
      throw error;
    }
  });
  return { root, truncated };
}

function parseItem(
  content: string,
  line: number,
  column: number,
  mode: Mode,
  locators: Map<string, string>,
  container: AriaRole,
  open: (frame: Pick<Frame, 'node' | 'closed'>) => void,
): void {
  // `- text: …`
  const textItem = /^text\s*:(?=\s|$)/.exec(content);
  if (textItem) {
    const raw = mode === 'outline' ? content.slice(textItem[0].length).trim() : readValue(content.slice(textItem[0].length), line, column + textItem[0].length);
    if (!raw && mode === 'template') throw new AriaTemplateError('`- text:` needs the text after the colon', line, column + textItem[0].length);
    if (mode === 'template') checkTextRegex(raw, line, column + textItem[0].length + 1);
    container.children.push({ kind: 'text', text: textValue(raw), line });
    open({ node: null, closed: 'is text' });
    return;
  }
  // `- /url: …`, `- /children: equal`
  const prop = /^\/([A-Za-z-]+)\s*:(?=\s|$)/.exec(content);
  if (prop && mode === 'template') {
    const key = prop[1] as string;
    const value = readValue(content.slice(prop[0].length), line, column + prop[0].length);
    if (key === 'children') {
      if (value !== 'contain' && value !== 'equal' && value !== 'deep-equal') throw new AriaTemplateError('`/children:` must be contain, equal or deep-equal', line, column + prop[0].length + 1);
      container.mode = value;
    } else if (key === 'url') {
      if (container.role === 'fragment') throw new AriaTemplateError('`/url:` belongs under a link line', line, column);
      container.url = textValue(value);
    } else throw new AriaTemplateError(`unknown property /${key} (BlockFlow supports /url and /children)`, line, column);
    open({ node: null, closed: 'is a property' });
    return;
  }

  let keyText = content;
  let keyColumn = column;
  let after: string | null = null;
  if (mode === 'template' && (content.startsWith('"') || content.startsWith("'"))) {
    const quoted = unquoteKey(content, line, column);
    keyText = quoted.key;
    keyColumn = quoted.keyColumn;
    const rest = quoted.rest.trim();
    if (rest.startsWith(':')) after = rest.slice(1);
    else if (rest && !rest.startsWith('#')) throw new AriaTemplateError(`unexpected "${rest.slice(0, 20)}" after the quoted line`, line, column + content.length - quoted.rest.length);
  }

  const node: AriaRole = { kind: 'role', role: '', children: [], line };
  const reader = new KeyReader(keyText, line, keyColumn, mode);
  const valueAt = reader.read(node);
  let valueColumn = keyColumn;
  if (after === null && valueAt !== null) {
    after = keyText.slice(valueAt);
    valueColumn = keyColumn + valueAt;
  }
  let raw: string | null = null;
  if (after !== null) {
    if (reader.hadRef) {
      // Outline line of a target: `…[ref=e3]: inline text locator=role=button[name="Go"]`.
      const ref = /\[ref=([^\]\s]+)\]/.exec(keyText)?.[1];
      const locator = ref ? locators.get(ref) : undefined;
      const suffix = locator ? ` locator=${locator}` : null;
      if (suffix && after.endsWith(suffix)) after = after.slice(0, -suffix.length);
      else {
        const at = after.lastIndexOf(' locator=');
        if (at >= 0) after = after.slice(0, at);
      }
    }
    raw = mode === 'outline' ? after.trim() : readValue(after, line, valueColumn);
    if (mode === 'template' && raw) checkTextRegex(raw, line, valueColumn + 1);
  }
  if (reader.value !== undefined) node.children.push({ kind: 'text', text: textValue(reader.value), line });
  if (raw) node.children.push({ kind: 'text', text: textValue(raw), line });
  container.children.push(node);
  open({ node, closed: raw && mode === 'template' ? 'has a value after ":"' : null });
}

/** `/x/i` is plain text to Playwright (it has no flags): say so instead of silently never matching. */
function checkTextRegex(raw: string, line: number, column: number): void {
  if (/^\/.+\/[a-z]+$/i.test(raw) && !raw.endsWith('/')) throw new AriaTemplateError('regular expression flags are not supported (Playwright templates have none)', line, column);
  if (raw.length > 1 && raw.startsWith('/') && raw.endsWith('/')) {
    try {
      new RegExp(raw.slice(1, -1));
    } catch (error) {
      throw new AriaTemplateError(`invalid regular expression ${raw}: ${error instanceof Error ? error.message : String(error)}`, line, column);
    }
  }
}

/**
 * Parses an expected template. Throws `AriaTemplateError` (with line and column) when it is not one.
 * The returned root is a `fragment` whose children are the template's top-level lines.
 */
export function parseAriaTemplate(text: string): AriaRole {
  const { root } = parseText(text, 'template', new Map());
  if (root.children.length === 0) throw new AriaTemplateError('the template is empty: write at least one line like - heading "Welcome"', 1, 1);
  return root;
}

/** The problem with a template as one sentence ("line 2, column 5: …"), or null when it parses. */
export function ariaTemplateProblem(text: string): string | null {
  try {
    parseAriaTemplate(text);
    return null;
  } catch (error) {
    if (error instanceof AriaTemplateError) return error.message;
    throw error;
  }
}

/**
 * The page outline of a `snapshot` result as a tree. `elements` (from the same result) lets the
 * `locator=…` hints be cut exactly; without it the last ` locator=` on a line is cut.
 */
export function parseAriaOutline(snapshot: string, elements: { ref: string; locator?: string }[] = []): AriaOutline {
  const locators = new Map(elements.filter((element) => element.locator).map((element) => [element.ref, element.locator as string]));
  return parseText(snapshot, 'outline', locators);
}

// --- matching (Playwright's algorithm: matchesNode / containsList / matchesNodeDeep) ---------

const regexCache = new Map<string, RegExp | null>();
function regexOf(pattern: string): RegExp | null {
  if (!regexCache.has(pattern)) {
    let regex: RegExp | null = null;
    try {
      regex = new RegExp(pattern);
    } catch {
      regex = null;
    }
    regexCache.set(pattern, regex);
  }
  return regexCache.get(pattern) ?? null;
}

/** The part before the "…" of a name or text the outline cut, or null when it was not cut. */
function clippedPrefix(text: string): string | null {
  return text.endsWith('…') && text.length >= CLIPPED_AT ? text.slice(0, -1) : null;
}

function textMatches(actual: string | undefined, template: TextValue | undefined): boolean {
  if (!template?.normalized) return true;
  if (actual === undefined || actual === '') return false;
  const text = normalizeAriaText(actual);
  if (text === template.normalized || actual === template.raw) return true;
  const { raw } = template;
  if (raw.length > 1 && raw.startsWith('/') && raw.endsWith('/')) return regexOf(raw.slice(1, -1))?.test(text) ?? false;
  const prefix = clippedPrefix(text);
  return prefix !== null && template.normalized.startsWith(prefix);
}

function nameMatches(actual: NameMatch | undefined, template: NameMatch | undefined): boolean {
  if (!template) return true;
  const name = typeof actual === 'string' ? actual : '';
  if (!name) return false;
  if (typeof template !== 'string') return regexOf(template.pattern)?.test(name) ?? false;
  if (name === template) return true;
  const prefix = clippedPrefix(name);
  return prefix !== null && template.startsWith(prefix);
}

/** BlockFlow's outline omits false states, so `[x=false]` passes when the state is not shown. */
function stateMatches(actual: boolean | 'mixed' | undefined, template: boolean | 'mixed' | undefined): boolean {
  if (template === undefined) return true;
  if (template === false) return actual !== true && actual !== 'mixed';
  return actual === template;
}

/** Which listed states differ (empty when all match), as `[level=1]` texts. */
function stateDifferences(actual: AriaRole, template: AriaRole): string[] {
  const out: string[] = [];
  for (const key of ['checked', 'disabled', 'pressed', 'selected'] as const) {
    if (!stateMatches(actual[key], template[key])) out.push(stateText(key, template[key]));
  }
  // The outline shows `[expanded=false]` explicitly (aria-expanded="false").
  if (template.expanded !== undefined && actual.expanded !== template.expanded) out.push(stateText('expanded', template.expanded));
  if (template.level !== undefined && actual.level !== template.level) out.push(`[level=${template.level}]`);
  for (const [key, value] of Object.entries(template.extra ?? {})) {
    const have = actual.extra?.[key];
    const ok = value === 'false' ? have === undefined || have === 'false' : have !== undefined && normalizeAriaText(have) === normalizeAriaText(value);
    if (!ok) out.push(value === 'true' ? `[${key}]` : `[${key}=${value}]`);
  }
  if (template.url && !textMatches(actual.url?.raw, template.url)) out.push(`/url: ${template.url.raw}`);
  return out;
}

function stateText(key: string, value: boolean | 'mixed' | undefined): string {
  return value === true ? `[${key}]` : `[${key}=${String(value)}]`;
}

/** The line itself matches (role, name, states), children aside. */
function headerMatches(actual: AriaNode, template: AriaNode): boolean {
  if (template.kind === 'text') return actual.kind === 'text' && textMatches(actual.text.raw, template.text);
  if (actual.kind !== 'role') return false;
  if (template.role !== 'fragment' && template.role !== actual.role) return false;
  return nameMatches(actual.name, template.name) && stateDifferences(actual, template).length === 0;
}

function matchesNode(actual: AriaNode, template: AriaNode, deep: boolean): boolean {
  if (!headerMatches(actual, template)) return false;
  if (template.kind === 'text' || actual.kind !== 'role') return true;
  const mode = template.mode ?? (deep ? 'deep-equal' : 'contain');
  if (mode === 'contain') return containsList(actual.children, template.children);
  return listEqual(actual.children, template.children, mode === 'deep-equal');
}

function listEqual(children: AriaNode[], templates: AriaNode[], deep: boolean): boolean {
  return children.length === templates.length && templates.every((template, index) => matchesNode(children[index] as AriaNode, template, deep));
}

/** How many of `templates` match `children` in order, greedily (all of them = contained). */
function containedCount(children: AriaNode[], templates: AriaNode[]): number {
  let at = 0;
  let count = 0;
  for (const template of templates) {
    while (at < children.length && !matchesNode(children[at] as AriaNode, template, false)) at += 1;
    if (at >= children.length) break;
    at += 1;
    count += 1;
  }
  return count;
}

function containsList(children: AriaNode[], templates: AriaNode[]): boolean {
  return containedCount(children, templates) === templates.length;
}

/** Every node of the tree, parents before children. */
function allNodes(root: AriaRole): { node: AriaNode; parent: AriaRole | null }[] {
  const out: { node: AriaNode; parent: AriaRole | null }[] = [];
  const visit = (node: AriaNode, parent: AriaRole | null) => {
    out.push({ node, parent });
    if (node.kind === 'role') for (const child of node.children) visit(child, node);
  };
  visit(root, null);
  return out;
}

/** Playwright's rule: one top-level line (children mode "contain") is searched for on its own. */
function effectiveTemplate(template: AriaRole): AriaNode {
  return template.children.length === 1 && (!template.mode || template.mode === 'contain') ? (template.children[0] as AriaNode) : template;
}

// --- explaining a mismatch -------------------------------------------------

interface Miss {
  template: AriaNode;
  /** The page node the missing line was looked for in. */
  container: AriaRole;
  /** The page node most like the missing line. */
  closest?: AriaNode;
  reason: string;
}

/** The text written on the line itself (`- listitem: Apples`), which belongs to the line in messages. */
function inlineText(node: AriaNode): AriaText | undefined {
  if (node.kind !== 'role' || node.children.length !== 1) return undefined;
  const only = node.children[0] as AriaNode;
  return only.kind === 'text' && only.line === node.line ? only : undefined;
}

/** A template line with nested lines (not just a value after ":"), worth looking into on a mismatch. */
function hasNested(template: AriaNode): template is AriaRole {
  return template.kind === 'role' && template.children.length > 0 && !inlineText(template);
}

/** How much `actual` looks like `template`: -1 other kind, 0 other role, up to 3 (line matches). */
function likeness(actual: AriaNode, template: AriaNode): number {
  if (template.kind === 'text') return actual.kind === 'text' ? (textMatches(actual.text.raw, template.text) ? 3 : 1) : -1;
  if (actual.kind !== 'role') return -1;
  if (template.role !== 'fragment' && template.role !== actual.role) return 0;
  const inline = inlineText(template);
  const sameLine = stateDifferences(actual, template).length === 0 && (!inline || actual.children.some((child) => matchesNode(child, inline, false)));
  return 1 + (nameMatches(actual.name, template.name) ? 1 : 0) + (sameLine ? 1 : 0);
}

function closestOf(candidates: AriaNode[], template: AriaNode): AriaNode | undefined {
  let best: AriaNode | undefined;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = likeness(candidate, template) * 1000 + (candidate.kind === 'role' && template.kind === 'role' ? containedCount(candidate.children, template.children) : 0);
    if (likeness(candidate, template) >= 1 && score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** Why `closest` is not `template` (its line), in words. */
function difference(closest: AriaNode, template: AriaNode): string {
  if (template.kind === 'text' || closest.kind === 'text') {
    return closest.kind === 'text' ? `the text there is ${JSON.stringify(clip(closest.text.normalized))}` : '';
  }
  const parts: string[] = [];
  if (!nameMatches(closest.name, template.name)) {
    const expected = typeof template.name === 'string' ? JSON.stringify(template.name) : `/${template.name?.pattern}/`;
    parts.push(typeof closest.name === 'string' && closest.name ? `its name is ${JSON.stringify(closest.name)}, expected ${expected}` : `it has no name, expected ${expected}`);
  }
  const states = stateDifferences(closest, template);
  if (states.length) parts.push(`it does not have ${states.join(' ')}`);
  const inline = inlineText(template);
  if (inline && !closest.children.some((child) => matchesNode(child, inline, false))) {
    const have = inlineText(closest);
    parts.push(have ? `its text is ${JSON.stringify(clip(have.text.normalized))}` : 'it has no such text');
  }
  return parts.join('; ');
}

function explainList(container: AriaRole, templates: AriaNode[], mode: ChildrenMode): Miss | null {
  const children = container.children;
  if (mode !== 'contain') {
    for (let index = 0; index < templates.length; index += 1) {
      const template = templates[index] as AriaNode;
      const child = children[index];
      if (!child) return { template, container, reason: `"/children: ${mode}" wants exactly ${templates.length} children here; the page has ${children.length}` };
      if (matchesNode(child, template, mode === 'deep-equal')) continue;
      if (headerMatches(child, template) && child.kind === 'role' && hasNested(template)) {
        const deeper = explainList(child, template.children, template.mode ?? (mode === 'deep-equal' ? 'deep-equal' : 'contain'));
        if (deeper) return deeper;
      }
      return { template, container, closest: child, reason: `with "/children: ${mode}" child ${index + 1} must match it; ${difference(child, template) || 'it does not'}` };
    }
    if (children.length !== templates.length) {
      return { template: templates[templates.length - 1] ?? container, container, reason: `"/children: ${mode}" wants exactly ${templates.length} children here; the page has ${children.length}` };
    }
    return null;
  }

  let at = 0;
  for (const template of templates) {
    let found = -1;
    for (let index = at; index < children.length; index += 1) {
      if (matchesNode(children[index] as AriaNode, template, false)) {
        found = index;
        break;
      }
    }
    if (found >= 0) {
      at = found + 1;
      continue;
    }
    const rest = children.slice(at);
    const closest = closestOf(rest, template);
    if (closest && headerMatches(closest, template) && closest.kind === 'role' && hasNested(template)) {
      const deeper = explainList(closest, template.children, template.mode ?? 'contain');
      if (deeper) return deeper;
    }
    if (children.slice(0, at).some((child) => matchesNode(child, template, false))) {
      return { template, container, reason: 'it is on the page, but before the line above it: the order differs' };
    }
    // Nested lines match direct children only: say so when it is further down (and nothing here is as close).
    const deeper = allNodes(container).filter((entry) => entry.node !== container && !children.includes(entry.node));
    const below = closestOf(
      deeper.map((entry) => entry.node),
      template,
    );
    if (below && (!closest || (matchesNode(below, template, false) && !headerMatches(closest, template)))) {
      {
        const parent = deeper.find((entry) => entry.node === below)?.parent ?? container;
        const where = renderAriaTree({ ...fragment(), children: [withoutChildren(parent)] }).text.replace(/:$/, '');
        const why = matchesNode(below, template, false) ? '' : `; ${difference(below, template)}`;
        return { template, container, closest: below, reason: `not a direct child here, it is under ${where} (nested lines match direct children only, add that line)${why}` };
      }
    }
    return { template, container, ...(closest ? { closest } : {}), reason: closest ? difference(closest, template) : 'nothing like it is here' };
  }
  return null;
}

function explain(root: AriaRole, template: AriaRole): Miss {
  const wanted = effectiveTemplate(template);
  const nodes = allNodes(root);
  if (wanted !== template) {
    // One line: the node most like it anywhere on the page.
    const closest = closestOf(
      nodes.map((entry) => entry.node),
      wanted,
    );
    const parent = closest ? nodes.find((entry) => entry.node === closest)?.parent ?? root : root;
    if (closest && headerMatches(closest, wanted) && closest.kind === 'role' && hasNested(wanted)) {
      const deeper = explainList(closest, wanted.children, wanted.mode ?? 'contain');
      if (deeper) return deeper;
    }
    return { template: wanted, container: parent, ...(closest ? { closest } : {}), reason: closest ? difference(closest, wanted) : 'nothing like it is on the page' };
  }
  // Several top-level lines: the page node whose children hold most of them, in order.
  let best = root;
  let bestCount = -1;
  for (const { node } of nodes) {
    if (node.kind !== 'role') continue;
    const count = containedCount(node.children, template.children);
    if (count > bestCount) {
      best = node;
      bestCount = count;
    }
  }
  return explainList(best, template.children, template.mode ?? 'contain') ?? { template, container: best, reason: 'the lines do not match together' };
}

function clip(text: string, max = SHOWN_WIDTH): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Matches the page outline against a template, Playwright's way: some node of the page (the root for
 * top-level lines) must contain the template's lines as a subsequence of its children, recursively.
 */
export function matchAriaSnapshot(outline: AriaOutline, template: AriaRole): AriaMatchResult {
  const actual = renderAriaTree(outline.root).text;
  const wanted = effectiveTemplate(template);
  const pass = allNodes(outline.root).some(({ node }) => matchesNode(node, wanted, false));
  if (pass) return { pass, message: '', actual };

  const miss = explain(outline.root, template);
  const lines: string[] = [];
  const missing = renderAriaTree(miss.template.kind === 'role' && miss.template.role === 'fragment' ? miss.template : { ...fragment(), children: [withoutChildren(miss.template)] }).text;
  lines.push(`ARIA snapshot does not match: template line ${miss.template.line || 1} found nothing on the page:`, `  ${missing.split('\n')[0] ?? ''}`);
  if (miss.closest) lines.push(`Closest on the page: ${renderAriaTree({ ...fragment(), children: [withoutChildren(miss.closest)] }).text}${miss.reason ? ` (${miss.reason})` : ''}`);
  else if (miss.reason) lines.push(`(${miss.reason})`);
  const where = miss.container.role === 'fragment' ? miss.container : { ...fragment(), children: [miss.container] };
  const shown = renderAriaTree(where).text.split('\n').filter(Boolean);
  lines.push(miss.container.role === 'fragment' ? 'The page:' : 'Looked for it in:');
  for (const line of shown.slice(0, SHOWN_LINES)) lines.push(`  ${clip(line)}`);
  if (shown.length > SHOWN_LINES) lines.push(`  … ${shown.length - SHOWN_LINES} more lines`);
  if (outline.truncated) lines.push('(The page outline was cut at its line limit: check one part of the page with a locator.)');
  return { pass, message: lines.join('\n'), actual };
}

function fragment(): AriaRole {
  return { kind: 'role', role: 'fragment', children: [], line: 0 };
}

/** The node's own line (a value-only text child is kept, it is part of the line). */
function withoutChildren(node: AriaNode): AriaNode {
  if (node.kind === 'text') return node;
  const only = node.children.length === 1 && node.children[0]?.kind === 'text' ? node.children : [];
  return { ...node, children: only };
}

// --- rendering (template syntax) --------------------------------------------

/** Playwright's yamlStringNeedsQuotes: when a key or value must be quoted to stay one YAML scalar. */
function needsQuotes(text: string): boolean {
  if (text.length === 0) return true;
  if (/^\s|\s$/.test(text)) return true;
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) return true;
  if (/^-/.test(text)) return true;
  if (/[\n:](\s|$)/.test(text)) return true;
  if (/\s#/.test(text)) return true;
  if (/[\n\r]/.test(text)) return true;
  if (/^[&*\],?!>|@"'#%]/.test(text)) return true;
  if (/[{}`]/.test(text)) return true;
  if (/^\[/.test(text)) return true;
  if (!isNaN(Number(text)) || ['y', 'n', 'yes', 'no', 'true', 'false', 'on', 'off', 'null'].includes(text.toLowerCase())) return true;
  return false;
}

function yamlKey(text: string): string {
  return needsQuotes(text) ? `'${text.replace(/'/g, "''")}'` : text;
}

function yamlValue(text: string): string {
  if (!needsQuotes(text)) return text;
  return `"${text.replace(/[\\"\x00-\x1f\x7f-\x9f]/g, (ch) => {
    const named: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
    return named[ch] ?? `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`;
  })}"`;
}

export interface RenderOptions {
  /** Leave out BlockFlow-only states (`[required]`, `[type=…]`…), for Playwright's toMatchAriaSnapshot. */
  playwright?: boolean;
}

/**
 * A tree as template text (`- role "name" [states]: text`, nested by two spaces). With `playwright`,
 * the output is valid for Playwright's `toMatchAriaSnapshot`; `dropped` lists the BlockFlow-only states
 * that had to be left out.
 */
export function renderAriaTree(root: AriaRole, options: RenderOptions = {}): { text: string; dropped: string[] } {
  const lines: string[] = [];
  const dropped = new Set<string>();
  const visit = (node: AriaNode, depth: number) => {
    const indent = '  '.repeat(depth);
    if (node.kind === 'text') {
      lines.push(`${indent}- text: ${yamlValue(node.text.raw)}`);
      return;
    }
    let key = node.role;
    if (typeof node.name === 'string' && node.name) key += ` "${node.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    else if (node.name && typeof node.name !== 'string') key += ` /${node.name.pattern}/`;
    for (const state of ['checked', 'disabled', 'expanded', 'level', 'pressed', 'selected'] as const) {
      const value = node[state];
      if (value === undefined) continue;
      key += value === true ? ` [${state}]` : ` [${state}=${String(value)}]`;
    }
    for (const [name, value] of Object.entries(node.extra ?? {})) {
      const text = value === 'true' ? `[${name}]` : `[${name}=${/[\s\]"]/.test(value) ? JSON.stringify(value) : value}]`;
      if (options.playwright) dropped.add(text.replace(/=.*\]$/, ']'));
      else key += ` ${text}`;
    }
    const props: string[] = [];
    if (node.url) props.push(`${indent}  - /url: ${yamlValue(node.url.raw)}`);
    if (node.mode) props.push(`${indent}  - /children: ${node.mode}`);
    const only = node.children.length === 1 ? node.children[0] : undefined;
    if (props.length === 0 && only?.kind === 'text') {
      lines.push(`${indent}- ${yamlKey(key)}: ${yamlValue(only.text.raw)}`);
      return;
    }
    if (props.length === 0 && node.children.length === 0) {
      lines.push(`${indent}- ${yamlKey(key)}`);
      return;
    }
    lines.push(`${indent}- ${yamlKey(key)}:`);
    lines.push(...props);
    for (const child of node.children) visit(child, depth + 1);
  };
  if (root.role === 'fragment') {
    if (root.mode) lines.push(`- /children: ${root.mode}`);
    for (const child of root.children) visit(child, 0);
  } else visit(root, 0);
  return { text: lines.join('\n'), dropped: [...dropped] };
}
