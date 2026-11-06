/**
 * Locator syntax (string level only): splitting `A || B` into alternatives and `A >> B` into steps,
 * naming each step's engine, and reading `role=…[…]` options. Shared by the page agent
 * (src/dom/locator.ts, which resolves steps against the DOM), the checker (src/core/check.ts) and the
 * Playwright exporter. No DOM here.
 */

/** A locator string that cannot be parsed. */
export class LocatorSyntaxError extends Error {}

/** One `>>`-separated step: which engine and its argument. */
export interface LocatorStep {
  engine: string;
  body: string;
}

/**
 * Filter steps: they narrow the matches so far (like Playwright's `locator.filter()`) instead of
 * searching inside them. `visible` alone means `visible=true`.
 */
export const FILTERS = new Set(['has-text', 'has-not-text', 'has', 'has-not', 'visible']);

/** Recognised `engine=` prefixes (filters included). */
export const ENGINES = new Set(['css', 'text', 'role', 'label', 'placeholder', 'testid', 'alt', 'title', 'xpath', 'nth', 'frame', ...FILTERS]);

/** Options inside `role=<role>[…]`. */
export const ROLE_OPTIONS = ['name', 'exact', 'checked', 'pressed', 'expanded', 'selected', 'disabled', 'level', 'include-hidden'] as const;
export type RoleOptionKey = (typeof ROLE_OPTIONS)[number];

/** Role options that are yes/no states: `[checked]` = true, `[checked=false]`. */
export const ROLE_STATES = ['checked', 'pressed', 'expanded', 'selected', 'disabled'] as const;
export type RoleState = (typeof ROLE_STATES)[number];

/** `role=button[name="Save"][pressed]`, read: the role and each option's raw value (quotes kept). */
export interface RoleSelector {
  role: string;
  /** In written order. `value` is undefined for a bare `[exact]` / `[checked]`. */
  options: { key: RoleOptionKey; value?: string }[];
}

/**
 * Splits on `separator` outside quotes and brackets. For `>>` the shadow-piercing `>>>` is left alone;
 * for `||` a lone `|` (XPath union) is left alone.
 */
function splitTopLevel(source: string, separator: '>>' | '||'): string[] {
  const char0 = separator[0] as string;
  const parts: string[] = [];
  let quote: string | null = null;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '(') depth += 1;
    else if (char === ']' || char === ')') depth -= 1;
    else if (depth === 0 && char === char0 && source[i + 1] === char0 && source[i - 1] !== char0 && source[i + 2] !== char0) {
      parts.push(source.slice(start, i));
      start = i + 2;
      i += 1;
    }
  }
  parts.push(source.slice(start));
  return parts.map((part) => part.trim());
}

/**
 * The `||` alternatives of a locator (`A || B` matches what A or B matches, like Playwright's
 * `locator.or()`). `||` binds loosest: `A >> B || C` is `(A >> B) || C`. One element = no `||`.
 */
export function splitAlternatives(source: string): string[] {
  if (!source.trim()) throw new LocatorSyntaxError('The locator is empty');
  const parts = splitTopLevel(source.trim(), '||');
  if (parts.some((part) => !part)) throw new LocatorSyntaxError(`Invalid locator: ${source} ("||" needs a locator on both sides)`);
  return parts;
}

/**
 * Splits one alternative (no `||`) into steps. No prefix: `//…` is xpath, a quoted string is text,
 * a bare `visible` is the visible filter, anything else CSS.
 */
export function parseLocatorSteps(source: string): LocatorStep[] {
  if (!source.trim()) throw new LocatorSyntaxError('The locator is empty');
  return splitTopLevel(source.trim(), '>>').map((part) => {
    if (!part) throw new LocatorSyntaxError(`Invalid locator: ${source}`);
    const match = /^([a-z-]+)\s*=([\s\S]*)$/.exec(part);
    if (match && ENGINES.has(match[1] as string)) return { engine: match[1] as string, body: (match[2] as string).trim() };
    if (part === 'visible') return { engine: 'visible', body: 'true' };
    if (part.startsWith('//') || part.startsWith('(//')) return { engine: 'xpath', body: part };
    if (/^".*"$/s.test(part)) return { engine: 'text', body: part };
    return { engine: 'css', body: part };
  });
}

/** Every alternative's steps: `[[steps of A], [steps of B]]` for `A || B`. */
export function parseLocatorAlternatives(source: string): LocatorStep[][] {
  return splitAlternatives(source).map(parseLocatorSteps);
}

/** The inner locator of `has=` / `has-not=`: the body, unquoted when fully quoted (`has="a >> b"`). */
export function nestedLocator(body: string): string {
  const quoted = /^(["'])([\s\S]*)\1$/.exec(body.trim());
  const inner = quoted ? (quoted[2] as string).replace(/\\(.)/g, '$1') : body.trim();
  if (!inner.trim()) throw new LocatorSyntaxError('has= / has-not= need a locator, e.g. has=role=button[name="Buy"]');
  return inner;
}

/** `visible`, `visible=true`, `visible=false`. */
export function visibleFilter(body: string): boolean {
  const value = body.trim().replace(/^(["'])(.*)\1$/, '$2').toLowerCase();
  if (value === '' || value === 'true') return true;
  if (value === 'false') return false;
  throw new LocatorSyntaxError(`visible= takes true or false, not "${body}"`);
}

/**
 * Reads `button[name="Save"][exact][pressed=false]`. Throws for an unknown option or text left over.
 * Values keep their quotes (`"Save"`, `/re/i`); {@link roleState} reads the yes/no ones.
 */
export function parseRoleSelector(body: string): RoleSelector {
  const match = /^([a-z-]+)\s*([\s\S]*)$/i.exec(body.trim());
  if (!match) throw new LocatorSyntaxError(`Invalid role locator: role=${body}`);
  const selector: RoleSelector = { role: (match[1] as string).toLowerCase(), options: [] };
  const attributes = /\[\s*([a-z-]+)\s*(?:=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/(?:[^/\\]|\\.)+\/[dgimsuyv]*|[^\]]*?))?\s*\]/gi;
  let rest = match[2] as string;
  for (const attr of (match[2] as string).matchAll(attributes)) {
    const key = (attr[1] as string).toLowerCase();
    rest = rest.replace(attr[0], '');
    if (!(ROLE_OPTIONS as readonly string[]).includes(key)) {
      throw new LocatorSyntaxError(`Unknown role option [${key}]. Use ${ROLE_OPTIONS.join(', ')}.`);
    }
    selector.options.push({ key: key as RoleOptionKey, ...(attr[2] !== undefined ? { value: attr[2] } : {}) });
  }
  if (rest.trim()) throw new LocatorSyntaxError(`Invalid role locator: role=${body}`);
  for (const option of selector.options) {
    if ((ROLE_STATES as readonly string[]).includes(option.key)) roleState(option);
    if (option.key === 'level' && !/^\d+$/.test(unquoteValue(option.value ?? ''))) {
      throw new LocatorSyntaxError(`[level=…] takes a number: role=${body}`);
    }
  }
  return selector;
}

/** A role option's value without quotes. */
export function unquoteValue(value: string): string {
  const match = /^(["'])([\s\S]*)\1$/.exec(value.trim());
  return match ? (match[2] as string).replace(/\\(.)/g, '$1') : value.trim();
}

/** `[checked]` / `[checked=true]` → true, `[checked=false]` → false; anything else throws. */
export function roleState(option: { key: string; value?: string }): boolean {
  if (option.value === undefined) return true;
  const value = unquoteValue(option.value).toLowerCase();
  if (value === 'true' || value === '') return true;
  if (value === 'false') return false;
  throw new LocatorSyntaxError(`[${option.key}=…] takes true or false, not ${option.value}`);
}
