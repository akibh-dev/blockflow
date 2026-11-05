import { DEFAULT_TAB, requireSessionTab } from '../session';
import type { AgentRequest } from '../page';
import type { BlockContext, Payload, TextField } from '../types';

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
