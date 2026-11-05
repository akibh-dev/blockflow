import { DEFAULT_TAB, requireSessionTab } from '../session';
import { PAGE_ACCENT, locatorField, pageWaitMs, tabField } from './pageCommon';
import type { AgentRequest, ExtractField } from '../page';
import type { BlockContext, BlockDefinition, Payload, Row, TextField } from '../types';

/** Where Extract List / Extract Table read from: a tab of the run, or HTML in the data. */
export interface SourceConfig {
  source: 'tab' | 'html';
  tab: string;
  html: string;
  baseUrl: string;
}

/** Shared by Extract List and Extract Table: read from a tab of the run, or from fetched HTML. */
export const sourceFields: (TextField | { key: 'source'; label: string; kind: 'select'; options: { value: string; label: string }[] })[] = [
  {
    key: 'source',
    label: 'From',
    kind: 'select',
    options: [
      { value: 'tab', label: 'a tab of this run (after Open Tab)' },
      { value: 'html', label: 'HTML in the data (e.g. {{body}} from HTTP Request), no tab' },
    ],
  },
  { key: 'html', label: 'HTML', kind: 'text', templated: true, placeholder: '{{body}}', help: 'Only for "HTML in the data".' },
  { key: 'baseUrl', label: 'Page address', kind: 'text', templated: true, placeholder: '{{url}}', help: 'Makes relative links absolute (HTML mode).' },
];

/**
 * Runs one agent request against the configured source: `Host.html.act` on `config.html` (no tab,
 * no layout) or `Host.page.act` on the session tab. Unlike `inPage` it never passes `realInput`
 * (scraping ops do not need it).
 */
export async function inSource(ctx: BlockContext<SourceConfig>, input: Payload, request: AgentRequest): Promise<Record<string, unknown>> {
  if (ctx.config.source === 'html') {
    if (!ctx.config.html.trim()) throw new Error('HTML is empty. Connect an HTTP Request block and use {{body}}.');
    return ctx.host.html.act(ctx.config.html, ctx.config.baseUrl, request);
  }
  const tabId = requireSessionTab(input, ctx.config.tab || DEFAULT_TAB);
  return ctx.host.page.act(tabId, request, pageWaitMs(ctx as BlockContext<object>));
}

/** The agent sends columns + rows of values (key order survives that); this makes the objects. */
export function tableToObjects(result: Record<string, unknown>): Record<string, string>[] {
  const columns = (result.columns as string[] | undefined) ?? [];
  const values = (result.values as string[][] | undefined) ?? [];
  return values.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index] ?? ''])));
}

/** Extract List settings. `fields` rows are `{name, locator, attribute}`; `limit` 0 means all. */
export interface ExtractListConfig extends SourceConfig {
  locator: string;
  fields: Row[];
  limit: number;
  into: string;
}

/**
 * Extract List — the scraping block. One object per repeated element (product card, search
 * result, table row), with the fields you name. Feed the list to For Each, Save to Dataset or
 * Download.
 */
export const extractListBlock: BlockDefinition<ExtractListConfig> = {
  type: 'extract-list',
  label: 'Extract List',
  description: 'Scrape repeated items (cards, results, rows) into a list of objects.',
  icon: '🧺',
  accent: PAGE_ACCENT,
  defaultConfig: { source: 'tab', tab: DEFAULT_TAB, html: '{{body}}', baseUrl: '', locator: '', fields: [], limit: 0, into: 'items' },
  timeoutSeconds: 30,
  fields: [
    { ...locatorField('locator', 'Each item'), placeholder: '.product-card  ·  role=listitem  ·  table tr' },
    {
      key: 'fields',
      label: 'Fields',
      kind: 'rows',
      columns: [
        { key: 'name', label: 'Name', placeholder: 'title' },
        { key: 'locator', label: 'Inside the item', placeholder: 'h2  (empty = item)', locator: true },
        { key: 'attribute', label: 'Attribute', placeholder: 'href  (empty = text)' },
      ],
      help: 'No fields = each item\'s text as {text}. Links (href, src) come back as full URLs.',
    },
    { key: 'limit', label: 'At most (0 = all)', kind: 'number', min: 0, step: 1 },
    { key: 'into', label: 'Save the list as', kind: 'text', placeholder: 'items' },
    ...sourceFields,
    tabField,
  ],
  summary: (config) => `${config.locator || 'pick the items'} → {{${config.into || 'items'}}}`,
  outputs: [
    { key: 'items', description: 'The list (or the name you chose).' },
    { key: 'count', description: 'How many items.' },
  ],

  async run(ctx, input) {
    const fields: ExtractField[] = (ctx.config.fields ?? [])
      .filter((row) => (row.name ?? '').trim())
      .map((row) => ({ name: (row.name ?? '').trim(), locator: row.locator ?? '', attribute: row.attribute ?? '' }));
    const result = await inSource(ctx, input, { op: 'extract', locator: ctx.config.locator, fields, ...(ctx.config.limit > 0 ? { limit: ctx.config.limit } : {}) });
    const items = tableToObjects(result);
    ctx.log('info', `Extracted ${items.length} item${items.length === 1 ? '' : 's'}`);
    return { ...input, [ctx.config.into.trim() || 'items']: items, count: items.length };
  },
};
