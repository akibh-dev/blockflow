import { normalizeHttpUrl } from '../url';
import type { BlockDefinition } from '../types';

export interface OpenUrlConfig {
  url: string;
  newTab: boolean;
  active: boolean;
}

/**
 * Open URL — opens a page in a tab, then passes the incoming data on (plus `url` and `tabId`).
 * The URL can use values from the previous block, e.g. `{{url}}`.
 */
export const openUrlBlock: BlockDefinition<OpenUrlConfig> = {
  type: 'open-url',
  label: 'Open URL',
  description: 'Open a web page in a tab.',
  icon: '🔗',
  accent: '#3b82f6',
  defaultConfig: { url: '', newTab: true, active: true },
  fields: [
    {
      key: 'url',
      label: 'URL',
      kind: 'url',
      required: true,
      templated: true,
      placeholder: 'https://example.com  or  {{url}}',
      help: 'Use {{name}} to insert a value from the previous block.',
    },
    { key: 'newTab', label: 'Open in a new tab', kind: 'boolean' },
    {
      key: 'active',
      label: 'Switch to the tab',
      kind: 'boolean',
      help: 'Off = open quietly in the background.',
    },
  ],
  summary: (config) => config.url || 'No URL yet',
  outputs: [
    { key: 'url', description: 'The URL that was opened.' },
    { key: 'tabId', description: 'Id of the tab it was opened in.' },
  ],

  async run(ctx, input) {
    const url = normalizeHttpUrl(ctx.config.url);
    if (!url) throw new Error(`"${ctx.config.url}" is not a valid http(s) URL`);
    const { tabId } = await ctx.host.tabs.open({
      url,
      newTab: ctx.config.newTab,
      active: ctx.config.active,
    });
    ctx.log('info', `Opened ${url}`);
    return { ...input, url, tabId };
  },
};
