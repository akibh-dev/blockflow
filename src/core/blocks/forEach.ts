import { routeTo } from '../ports';
import { DATA_ACCENT, listAt, listField } from './dataCommon';
import type { BlockDefinition } from '../types';

export interface ForEachConfig {
  list: string;
  as: string;
}

/**
 * For Each — runs everything connected to "each" once per item, one after another, then sends
 * the data on from "done". Each item arrives as {{item}} (or the name you choose) with {{index}}.
 */
export const forEachBlock: BlockDefinition<ForEachConfig> = {
  type: 'for-each',
  label: 'For Each',
  description: 'Repeat the blocks on "each" for every item of a list, then continue from "done".',
  icon: '🔁',
  accent: DATA_ACCENT,
  ports: ['each', 'done'],
  defaultConfig: { list: 'items', as: 'item' },
  timeoutSeconds: 3600,
  fields: [listField(), { key: 'as', label: 'Call each item', kind: 'text', placeholder: 'item' }],
  summary: (config) => `each ${config.as || 'item'} in ${config.list}`,
  outputs: [
    { key: 'item', description: 'On "each": the current item (or the name you chose).' },
    { key: 'index', description: 'On "each": its position, from 0.' },
    { key: 'total', description: 'On "each": how many items there are.' },
    { key: 'count', description: 'On "done": how many items were processed.' },
  ],

  async run(ctx, input) {
    const items = listAt(ctx.config.list, input);
    const name = ctx.config.as.trim() || 'item';
    for (const [index, item] of items.entries()) {
      await ctx.emit({ ...input, [name]: item, index, total: items.length }, 'each');
    }
    ctx.log('info', `Went through ${items.length} item${items.length === 1 ? '' : 's'}`);
    return routeTo('done', { ...input, count: items.length });
  },
};
