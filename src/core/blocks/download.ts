import { toCsv } from '../csv';
import { DATA_ACCENT, evalEnv, valueAt } from './dataCommon';
import type { BlockDefinition } from '../types';

/** Download settings. `value` is an expression; `dataset` / `filename` are templated. */
export interface DownloadConfig {
  from: 'value' | 'dataset';
  value: string;
  dataset: string;
  format: 'csv' | 'json' | 'text';
  filename: string;
}

/** Download — saves data to the Downloads folder as CSV, JSON or plain text. */
export const downloadBlock: BlockDefinition<DownloadConfig> = {
  type: 'download',
  label: 'Download',
  description: 'Save a list or a dataset to a CSV or JSON file in Downloads.',
  icon: '⬇️',
  accent: DATA_ACCENT,
  defaultConfig: { from: 'value', value: 'items', dataset: '', format: 'csv', filename: 'blockflow-{{ today() }}.csv' },
  fields: [
    {
      key: 'from',
      label: 'Save',
      kind: 'select',
      options: [
        { value: 'value', label: 'a value from the data' },
        { value: 'dataset', label: 'a dataset' },
      ],
    },
    { key: 'value', label: 'Value', kind: 'text', placeholder: 'items', help: 'An expression, for "a value from the data".' },
    { key: 'dataset', label: 'Dataset', kind: 'text', templated: true, placeholder: 'prices' },
    {
      key: 'format',
      label: 'Format',
      kind: 'select',
      options: [
        { value: 'csv', label: 'CSV (spreadsheets)' },
        { value: 'json', label: 'JSON' },
        { value: 'text', label: 'plain text' },
      ],
    },
    { key: 'filename', label: 'File name', kind: 'text', required: true, templated: true },
  ],
  summary: (config) => `${config.from === 'dataset' ? config.dataset : config.value} → ${config.filename}`,
  validate: (config) =>
    config.from === 'dataset'
      ? String(config.dataset ?? '').trim()
        ? []
        : [{ key: 'dataset', code: 'config.required', message: 'Dataset is required when saving a dataset' }]
      : String(config.value ?? '').trim()
        ? []
        : [{ key: 'value', code: 'config.required', message: 'Value is required when saving a value from the data' }],
  outputs: [{ key: 'file', description: 'The file name used.' }],

  async run(ctx, input) {
    const data = ctx.config.from === 'dataset' ? await ctx.host.datasets.read(ctx.config.dataset.trim()) : valueAt(ctx.config.value, input, 'Value', evalEnv(ctx));
    const { format } = ctx.config;
    const content =
      format === 'json'
        ? JSON.stringify(data, null, 2)
        : format === 'csv'
          ? toCsv(Array.isArray(data) ? data : [data])
          : typeof data === 'string'
            ? data
            : JSON.stringify(data, null, 2);
    const mime = format === 'json' ? 'application/json' : format === 'csv' ? 'text/csv' : 'text/plain';
    await ctx.host.downloads.save(ctx.config.filename, content, mime);
    ctx.log('info', `Saved ${ctx.config.filename}`);
    return { ...input, file: ctx.config.filename };
  },
};
