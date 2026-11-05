import { DEFAULT_TAB } from '../session';
import { inSource, sourceFields, tableToObjects } from './extractList';
import type { SourceConfig } from './extractList';
import { PAGE_ACCENT, locatorField, tabField } from './pageCommon';
import type { BlockDefinition } from '../types';

/** Extract Table settings: the table locator and the payload key for the rows. */
export interface ExtractTableConfig extends SourceConfig {
  locator: string;
  into: string;
}

/** Extract Table: one `table` agent request, rebuilt into objects by `tableToObjects`; adds the rows and `count`. */
export const extractTableBlock: BlockDefinition<ExtractTableConfig> = {
  type: 'extract-table',
  label: 'Extract Table',
  description: 'Read an HTML table into a list of rows, keyed by its column headers.',
  icon: '📊',
  accent: PAGE_ACCENT,
  defaultConfig: { source: 'tab', tab: DEFAULT_TAB, html: '{{body}}', baseUrl: '', locator: 'table', into: 'rows' },
  timeoutSeconds: 30,
  fields: [locatorField('locator', 'Table'), { key: 'into', label: 'Save the rows as', kind: 'text', placeholder: 'rows' }, ...sourceFields, tabField],
  summary: (config) => `${config.locator} → {{${config.into || 'rows'}}}`,
  outputs: [
    { key: 'rows', description: 'One object per row (or the name you chose).' },
    { key: 'count', description: 'How many rows.' },
  ],

  async run(ctx, input) {
    const result = await inSource(ctx, input, { op: 'table', locator: ctx.config.locator });
    const rows = tableToObjects(result);
    ctx.log('info', `Read ${rows.length} row${rows.length === 1 ? '' : 's'}`);
    return { ...input, [ctx.config.into.trim() || 'rows']: rows, count: rows.length };
  },
};
