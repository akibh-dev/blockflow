import { DATA_ACCENT, valueAt } from './dataCommon';
import type { BlockDefinition } from '../types';

/** Save to Dataset settings. `value` is an expression (not a template). */
export interface SaveDatasetConfig {
  dataset: string;
  value: string;
  mode: 'append' | 'replace';
}

/** Save to Dataset — keeps rows between runs (Data page): scraped items, prices over time, test results. */
export const saveDatasetBlock: BlockDefinition<SaveDatasetConfig> = {
  type: 'save-dataset',
  label: 'Save to Dataset',
  description: 'Add rows to a named dataset kept in the browser. See and download it on the Data page.',
  icon: '💾',
  accent: DATA_ACCENT,
  defaultConfig: { dataset: 'scraped', value: 'items', mode: 'append' },
  fields: [
    { key: 'dataset', label: 'Dataset', kind: 'text', required: true, templated: true, placeholder: 'prices' },
    {
      key: 'value',
      label: 'What to save',
      kind: 'text',
      required: true,
      placeholder: 'items',
      help: 'An expression: a list adds one row per item, anything else one row. E.g. items, or item inside a For Each. Build objects with Transform first.',
    },
    {
      key: 'mode',
      label: 'Mode',
      kind: 'select',
      options: [
        { value: 'append', label: 'add to what is there' },
        { value: 'replace', label: 'replace what is there' },
      ],
    },
  ],
  summary: (config) => `${config.value} → ${config.dataset}`,
  outputs: [{ key: 'datasetSize', description: 'Rows in the dataset afterwards.' }],

  async run(ctx, input) {
    const value = valueAt(ctx.config.value, input, 'What to save');
    const rows = Array.isArray(value) ? value : [value === undefined ? null : value];
    const size = await ctx.host.datasets.write(ctx.config.dataset.trim(), rows, ctx.config.mode);
    ctx.log('info', `Saved ${rows.length} row${rows.length === 1 ? '' : 's'} to "${ctx.config.dataset}" (${size} in total)`);
    return { ...input, datasetSize: size };
  },
};
