import { DEFAULT_TAB, requireSessionTab } from '../session';
import { CodedError } from '../errors';
import type { AgentRequest, Modifier, Point } from '../page';
import type { BlockContext, ConfigProblem, Payload, TextField } from '../types';

/** Pieces every page block shares: which tab, which element, how long to wait. */

export const PAGE_ACCENT = '#7c3aed';
/** Page actions fail after this long by default (Playwright's default too). */
export const PAGE_TIMEOUT_SECONDS = 30;

/**
 * The "Tab" setting every page block ends with: the name of a tab in `$session.tabs`
 * (see session.ts). Empty means DEFAULT_TAB ("main"). Not templated.
 */
export const tabField: TextField = {
  key: 'tab',
  label: 'Tab',
  kind: 'text',
  placeholder: DEFAULT_TAB,
  help: 'The name an Open Tab block gave the tab earlier in this run. Usually "main".',
};

/**
 * A templated `kind: 'locator'` field (the editor adds a "Pick on page" button). Spread and override
 * `help` / `placeholder` for block-specific wording; pass `required = false` for optional elements.
 */
export function locatorField(key = 'locator', label = 'Element', required = true): TextField {
  return {
    key,
    label,
    kind: 'locator',
    required,
    templated: true,
    placeholder: 'role=button[name="Save"]  ·  label=Email  ·  #save',
    help: 'CSS, or text=…, role=…[name="…"], label=…, placeholder=…, testid=…, A >> B, >> nth=0. Or press 🎯 Pick.',
  };
}

/** A little under the step timeout, so the page's own reason ("waiting for #x to be visible") wins the race. */
export function pageWaitMs(ctx: BlockContext<object>): number {
  return Math.max(1_000, ctx.timeoutMs - 500);
}

/** Config shape `inPage` needs: every page block config has a `tab`. */
export interface WithTab {
  tab: string;
}

/** Runs one agent request in the run's tab. */
export async function inPage(
  ctx: BlockContext<WithTab>,
  input: Payload,
  request: AgentRequest,
): Promise<{ tabId: number; result: Record<string, unknown> }> {
  const tabId = requireSessionTab(input, ctx.config.tab ?? DEFAULT_TAB);
  const result = await ctx.host.page.act(tabId, request, pageWaitMs(ctx as BlockContext<object>), ctx.realInput ? { realInput: true } : undefined);
  return { tabId, result };
}

// --- mouse options (Click, Drag) ---------------------------------------------

const MODIFIER_NAMES: Record<string, Modifier> = { alt: 'Alt', option: 'Alt', control: 'Control', ctrl: 'Control', meta: 'Meta', cmd: 'Meta', command: 'Meta', shift: 'Shift' };

/**
 * "Shift", "Control+Shift", "alt, meta" → Playwright modifier names (Alt, Control, Meta, Shift; Ctrl, Cmd,
 * Command and Option are accepted too). `unknown` lists what was not a modifier.
 */
export function parseModifiers(text: unknown): { modifiers: Modifier[]; unknown: string[] } {
  const modifiers: Modifier[] = [];
  const unknown: string[] = [];
  for (const part of String(text ?? '').split(/[\s,+]+/).filter(Boolean)) {
    const name = MODIFIER_NAMES[part.toLowerCase()];
    if (!name) unknown.push(part);
    else if (!modifiers.includes(name)) modifiers.push(name);
  }
  return { modifiers, unknown };
}

/** "10, 5" (or "10 5") → `{ x: 10, y: 5 }`; empty → undefined (the element's center); anything else → null. */
export function parsePosition(text: unknown): Point | undefined | null {
  const value = String(text ?? '').trim();
  if (!value) return undefined;
  const match = /^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/.exec(value);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
}

/** Problems with a modifiers setting, for `validate`. */
export function modifierProblems(key: string, text: unknown): ConfigProblem[] {
  const { unknown } = parseModifiers(text);
  return unknown.length === 0
    ? []
    : [{ key, code: 'config.value', message: `${unknown.map((part) => `"${part}"`).join(', ')} is not a modifier key; use Alt, Control, Meta or Shift (e.g. "Control+Shift")` }];
}

/** Problems with a position setting, for `validate`. */
export function positionProblems(key: string, text: unknown): ConfigProblem[] {
  return parsePosition(text) === null ? [{ key, code: 'config.value', message: `"${String(text)}" is not a position; write x,y in pixels from the element's top-left corner, e.g. "10,5"` }] : [];
}

/** A modifiers setting at run time (checked on import; unknown names are ignored here). */
export function modifiersOf(text: unknown): Modifier[] | undefined {
  const { modifiers } = parseModifiers(text);
  return modifiers.length > 0 ? modifiers : undefined;
}

/** A position setting at run time; a bad one is a config error. */
export function positionOf(text: unknown, label: string): Point | undefined {
  const position = parsePosition(text);
  if (position === null) throw new CodedError('config.invalid', `${label} "${String(text)}" is not a position: write x,y in pixels from the element's top-left corner`);
  return position;
}
