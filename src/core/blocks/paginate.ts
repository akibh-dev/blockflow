import { routeTo } from '../ports';
import { DEFAULT_TAB, requireSessionTab } from '../session';
import { inPage, locatorField, PAGE_ACCENT, pageWaitMs, tabField } from './pageCommon';
import type { BlockContext, BlockDefinition } from '../types';

export interface PaginateConfig {
  tab: string;
  next: string;
  maxPages: number;
}

/**
 * Paginate — for list pages with a "Next" button: runs "each" on the current page (put Extract
 * List there), clicks Next, waits for the new page, and repeats until Next is gone or disabled.
 */
export const paginateBlock: BlockDefinition<PaginateConfig> = {
  type: 'paginate',
  label: 'Paginate',
  description: 'Run "each" on every page of a paged list, clicking Next in between.',
  icon: '📄',
  accent: PAGE_ACCENT,
  ports: ['each', 'done'],
  defaultConfig: { tab: DEFAULT_TAB, next: 'role=link[name="Next"]', maxPages: 10 },
  timeoutSeconds: 1800,
  fields: [
    { ...locatorField('next', 'Next button'), placeholder: 'role=link[name="Next"]  ·  .pagination .next' },
    { key: 'maxPages', label: 'At most (pages)', kind: 'number', min: 1, step: 1 },
    tabField,
  ],
  summary: (config) => `up to ${config.maxPages} pages via ${config.next}`,
  outputs: [
    { key: 'page', description: 'On "each": the page number, from 1.' },
    { key: 'pages', description: 'On "done": how many pages were visited.' },
  ],

  async run(ctx, input) {
    const tabId = requireSessionTab(input, ctx.config.tab);
    let page = 1;
    for (;;) {
      await ctx.emit({ ...input, page }, 'each');
      if (page >= ctx.config.maxPages) break;
      const { result } = await inPage(ctx, input, { op: 'read', locator: ctx.config.next, kind: 'enabled' });
      if (result.text !== 'true') break;
      await inPage(ctx, input, { op: 'click', locator: `${ctx.config.next} >> nth=0`, action: 'click' });
      // A full page load or a single-page app fetching the next page: both end with a quiet network.
      await ctx.host.sleep(150);
      await ctx.host.tabs.waitForLoad(tabId, 'networkidle', Math.min(pageWaitMs(ctx as BlockContext<object>), 30_000));
      page += 1;
    }
    ctx.log('info', `Visited ${page} page${page === 1 ? '' : 's'}`);
    return routeTo('done', { ...input, pages: page });
  },
};
