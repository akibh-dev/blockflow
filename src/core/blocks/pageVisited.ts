import { withSessionTab } from '../session';
import type { BlockContext, BlockDefinition, Payload } from '../types';

/** Page Visited settings, read by the background worker's webNavigation listeners (not by the block). */
export interface PageVisitedConfig {
  url: string;
  when: 'load' | 'any';
}

/** The tab you are looking at becomes the run's "main" tab (Run button, context menu). */
export async function currentTabPayload(ctx: BlockContext<object>): Promise<Payload | null> {
  const tab = await ctx.host.tabs.current();
  if (!tab) {
    ctx.log('warn', 'No web page tab to use. Open one and try again.');
    return null;
  }
  return withSessionTab({ url: tab.url, title: tab.title, tabId: tab.tabId }, 'main', tab.tabId);
}

/**
 * Page Visited — starts the flow when any tab opens a matching page (also single-page-app route
 * changes, if chosen). The tab becomes the run's "main" tab, so page blocks can act on it.
 * Needs the workflow to be On. Tabs BlockFlow opened itself never trigger it.
 */
export const pageVisitedBlock: BlockDefinition<PageVisitedConfig> = {
  type: 'page-visited',
  label: 'Page Visited',
  description: 'Start when you open a matching page (in any tab). That tab becomes "main".',
  icon: '🌍',
  accent: '#f59e0b',
  defaultConfig: { url: '', when: 'load' },
  fields: [
    {
      key: 'url',
      label: 'Page URL pattern',
      kind: 'text',
      required: true,
      placeholder: 'https://github.com/*/pulls  ·  /checkout',
      help: 'Plain text = the URL contains it; * any part between slashes; ** anything; /…/ regex.',
    },
    {
      key: 'when',
      label: 'When',
      kind: 'select',
      options: [
        { value: 'load', label: 'the page has loaded' },
        { value: 'any', label: 'loaded, or the address changed in a single-page app' },
      ],
    },
  ],
  summary: (config) => config.url || 'set a URL pattern',
  outputs: [
    { key: 'url', description: 'The page address.' },
    { key: 'title', description: 'The page title.' },
    { key: 'tabId', description: 'The tab.' },
  ],

  start(ctx) {
    ctx.log('info', `Waiting for pages matching ${ctx.config.url}`);
  },

  // Run button: use the tab you are on.
  trigger: (ctx) => currentTabPayload(ctx as BlockContext<object>),

  // A page event (from the background worker) passes the page on.
  async run(_ctx, input) {
    return input;
  },
};
