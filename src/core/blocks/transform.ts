import { DATA_ACCENT, evalEnv, valueAt } from './dataCommon';
import type { BlockDefinition, Row } from '../types';

/** Transform settings: `values` rows are `{name, expression}`, evaluated top to bottom. */
export interface TransformConfig {
  values: Row[];
}

/**
 * Transform — set several values from expressions, keeping their types (numbers stay numbers,
 * lists stay lists): total = sum(pluck(items, 'price')), cheapest = first(sort(items, 'price')).
 * Each row can use the ones above it.
 */
export const transformBlock: BlockDefinition<TransformConfig> = {
  type: 'transform',
  label: 'Transform',
  description: 'Compute new values with expressions: math, text, lists (sum, sort, pluck…).',
  icon: '🧮',
  accent: DATA_ACCENT,
  defaultConfig: { values: [{ name: 'total', expression: "sum(pluck(items, 'price'))" }] },
  fields: [
    {
      key: 'values',
      label: 'Values',
      kind: 'rows',
      required: true,
      columns: [
        { key: 'name', label: 'Name', placeholder: 'total' },
        { key: 'expression', label: 'Expression', placeholder: "price * 1.1  ·  upper(name)  ·  len(items)" },
      ],
      help: 'Expressions without {{ }}. See docs/guide for the functions.',
    },
  ],
  summary: (config) => (config.values ?? []).map((row) => row.name).filter(Boolean).join(', ') || 'no values yet',
  outputs: [{ key: '(your names)', description: 'One key per row.' }],

  async run(ctx, input) {
    let data = { ...input };
    for (const row of ctx.config.values ?? []) {
      const name = (row.name ?? '').trim();
      if (!name) continue;
      data = { ...data, [name]: valueAt(row.expression ?? '', data, name, evalEnv(ctx)) };
    }
    return data;
  },
};
