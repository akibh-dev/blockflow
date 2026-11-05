import { DEFAULT_TAB } from '../session';
import { inPage, locatorField, PAGE_ACCENT, tabField } from './pageCommon';
import type { BlockDefinition } from '../types';

/**
 * Scroll settings. `end` is block-only (the agent knows bottom/top/element): it repeats `bottom`
 * until the page height is unchanged twice, or `maxScrolls` is reached, sleeping `pauseMs` between.
 */
export interface ScrollConfig {
  tab: string;
  to: 'bottom' | 'top' | 'element' | 'end';
  locator: string;
  maxScrolls: number;
  pauseMs: number;
}

/** Scroll — also "keep scrolling until nothing more loads", for infinite lists before Extract List. */
export const scrollBlock: BlockDefinition<ScrollConfig> = {
  type: 'scroll',
  label: 'Scroll',
  description: 'Scroll to the bottom, top or an element; or keep scrolling until no more content loads.',
  icon: '🖱️',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: DEFAULT_TAB, to: 'end', locator: '', maxScrolls: 20, pauseMs: 1000 },
  timeoutSeconds: 120,
  fields: [
    {
      key: 'to',
      label: 'Scroll',
      kind: 'select',
      options: [
        { value: 'end', label: 'until nothing more loads (infinite lists)' },
        { value: 'bottom', label: 'to the bottom once' },
        { value: 'top', label: 'to the top' },
        { value: 'element', label: 'to an element' },
      ],
    },
    { ...locatorField('locator', 'Element', false), help: 'Only for "to an element".' },
    { key: 'maxScrolls', label: 'At most (scrolls)', kind: 'number', min: 1, step: 1 },
    { key: 'pauseMs', label: 'Wait between scrolls (ms)', kind: 'number', min: 100, step: 100 },
    tabField,
  ],
  summary: (config) => (config.to === 'element' ? `to ${config.locator}` : config.to === 'end' ? 'until the end' : `to the ${config.to}`),
  outputs: [{ key: 'scrolls', description: 'How many times it scrolled.' }],

  async run(ctx, input) {
    const { to } = ctx.config;
    if (to !== 'end') {
      await inPage(ctx, input, { op: 'scroll', to, ...(to === 'element' ? { locator: ctx.config.locator } : {}) });
      return { ...input, scrolls: 1 };
    }
    let last = -1;
    let unchanged = 0;
    let scrolls = 0;
    while (scrolls < ctx.config.maxScrolls && unchanged < 2) {
      const { result } = await inPage(ctx, input, { op: 'scroll', to: 'bottom' });
      scrolls += 1;
      const height = Number(result.height ?? 0);
      unchanged = height === last ? unchanged + 1 : 0;
      last = height;
      await ctx.host.sleep(ctx.config.pauseMs);
    }
    ctx.log('info', `Scrolled ${scrolls} time${scrolls === 1 ? '' : 's'}${unchanged >= 2 ? ', reached the end' : ''}`);
    return { ...input, scrolls };
  },
};
