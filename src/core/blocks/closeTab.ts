import { DEFAULT_TAB, sessionTab, withoutSessionTab } from '../session';
import { PAGE_ACCENT, tabField } from './pageCommon';
import type { BlockDefinition } from '../types';

export interface CloseTabConfig {
  tab: string;
}

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
