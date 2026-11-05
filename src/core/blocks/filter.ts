import { OPERATOR_OPTIONS, testClause } from '../condition';
import { render } from '../template';
import { DATA_ACCENT, listAt, listField } from './dataCommon';
import type { BlockDefinition } from '../types';

/**
 * Filter settings. `left` / `right` are deliberately not `templated` fields: the block renders them
 * itself once per item, with `item` in scope.
 */
export interface FilterConfig {
  list: string;
  left: string;
  operator: string;
  right: string;
  into: string;
}

/** Filter — keeps the items of a list that pass a condition. Templates see each item as {{item}}. */
export const filterBlock: BlockDefinition<FilterConfig> = {
  type: 'filter',
  label: 'Filter',
  description: 'Keep only the list items that match a condition.',
  icon: '🧹',
  accent: DATA_ACCENT,
  defaultConfig: { list: 'items', left: '{{item.price}}', operator: 'less', right: '50', into: '' },
  fields: [
    listField(),
    { key: 'left', label: 'Value (per item)', kind: 'text', placeholder: '{{item.price}}', help: 'Rendered for each item: {{item.…}} is the item, other {{…}} the data.' },
    { key: 'operator', label: 'Condition', kind: 'select', options: OPERATOR_OPTIONS },
    { key: 'right', label: 'Compare to', kind: 'text', placeholder: '50' },
    { key: 'into', label: 'Save as (empty = replace the list)', kind: 'text', placeholder: 'cheap' },
  ],
  summary: (config) => `${config.list}: ${config.left} ${config.operator} ${config.right}`,
  outputs: [{ key: '(list)', description: 'The kept items, under the list\'s name or "Save as".' }],

  async run(ctx, input) {
    const items = listAt(ctx.config.list, input);
    const kept = items.filter((item) => {
      const scope = { ...input, item };
      return testClause({ left: render(ctx.config.left, scope), operator: ctx.config.operator, right: render(ctx.config.right, scope) });
    });
    ctx.log('info', `Kept ${kept.length} of ${items.length}`);
    const key = ctx.config.into.trim() || ctx.config.list.trim();
    if (!/^[\w$-]+$/.test(key)) throw new Error('Save as: give a simple name when the list is not a plain name');
    return { ...input, [key]: kept, count: kept.length };
  },
};
