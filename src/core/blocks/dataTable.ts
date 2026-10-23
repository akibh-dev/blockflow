import { csvToObjects } from '../csv';
import { DATA_ACCENT } from './dataCommon';
import type { BlockDefinition } from '../types';

export interface DataTableConfig {
  text: string;
  into: string;
}

/** Data Table — test data pasted as CSV (first row = names) or JSON. Pair with For Each for data-driven tests. */
export const dataTableBlock: BlockDefinition<DataTableConfig> = {
  type: 'data-table',
  label: 'Data Table',
  description: 'Rows of data you paste in (CSV or JSON), e.g. logins to test one by one.',
  icon: '🗂️',
  accent: DATA_ACCENT,
  defaultConfig: { text: 'email,password\nfirst@example.com,one\nsecond@example.com,two', into: 'rows' },
  fields: [
    { key: 'text', label: 'Data', kind: 'text', multiline: true, required: true, help: 'CSV with a header row (comma, semicolon or tab), or a JSON list.' },
    { key: 'into', label: 'Save the rows as', kind: 'text', placeholder: 'rows' },
  ],
  summary: (config) => `${Math.max(0, config.text.trim().split('\n').length - 1)} rows → {{${config.into || 'rows'}}}`,
  outputs: [
    { key: 'rows', description: 'The rows (or the name you chose).' },
    { key: 'count', description: 'How many rows.' },
  ],

  async run(ctx, input) {
    const text = ctx.config.text.trim();
    let rows: unknown[];
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(text);
        rows = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        throw new Error('The data starts like JSON but is not valid JSON');
      }
    } else rows = csvToObjects(text);
    return { ...input, [ctx.config.into.trim() || 'rows']: rows, count: rows.length };
  },
};
