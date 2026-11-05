import { DEFAULT_TAB, sessionTab, withoutSessionTab } from '../session';
import { PAGE_ACCENT, tabField } from './pageCommon';
import type { BlockDefinition } from '../types';

/** Close Tab settings: the session name of the tab to close. */
export interface CloseTabConfig {
  tab: string;
}

/**
 * Close Tab: closes a tab of the run and removes it from `$session`. A missing tab is only a
 * warning (the input passes on), so a cleanup step never fails a run.
 */
export const closeTabBlock: BlockDefinition<CloseTabConfig> = {
  type: 'close-tab',
  label: 'Close Tab',
  description: 'Close a tab this run opened.',
  icon: '✖️',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: DEFAULT_TAB },
  fields: [tabField],
  summary: (config) => `close "${config.tab || DEFAULT_TAB}"`,
  outputs: [{ key: '(same data)', description: 'The input, passed on.' }],

  async run(ctx, input) {
    const tabId = sessionTab(input, ctx.config.tab);
    if (tabId === undefined) {
      ctx.log('warn', `No tab named "${ctx.config.tab || DEFAULT_TAB}" to close`);
      return input;
    }
    await ctx.host.tabs.close(tabId);
    return withoutSessionTab(input, ctx.config.tab);
  },
};
