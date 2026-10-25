import { DEFAULT_TAB, withSessionTab } from '../session';
import { normalizeHttpUrl } from '../url';
import type { WaitUntil } from '../page';
import type { BlockDefinition } from '../types';

export interface OpenUrlConfig {
  url: string;
  /** new: a new tab · workflow: this block's own tab, reused every run · current: the tab you are on · window: a new window */
  where: 'new' | 'workflow' | 'current' | 'window';
  tab: string;
  active: boolean;
  waitUntil: WaitUntil;
  /** Saved by versions before "where" existed: false meant "the current tab". */
  newTab?: boolean;
}

export const WAIT_UNTIL_OPTIONS = [
  { value: 'load', label: 'the page has loaded' },
  { value: 'networkidle', label: 'the network is quiet (for pages that load data after load)' },
  { value: 'none', label: 'do not wait' },
];

/**
 * Open Tab (type "open-url", its name before page blocks existed). Opens a page and names the
 * tab ("main"), so later blocks (Click, Fill, Read Element...) in the same run act on it.
 */
export const openUrlBlock: BlockDefinition<OpenUrlConfig> = {
  type: 'open-url',
  label: 'Open Tab',
  description: 'Open a web page, and remember the tab for the next blocks.',
  icon: '🔗',
  accent: '#3b82f6',
  defaultConfig: { url: '', where: 'new', tab: DEFAULT_TAB, active: true, waitUntil: 'load' },
  timeoutSeconds: 45,
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
    {
      key: 'where',
      label: 'Open in',
      kind: 'select',
      options: [
        { value: 'new', label: 'a new tab' },
        { value: 'workflow', label: "this workflow's own tab (reused every run)" },
        { value: 'window', label: 'a new window' },
        { value: 'current', label: 'the tab you are looking at' },
      ],
    },
    {
      key: 'tab',
      label: 'Tab name',
      kind: 'text',
      placeholder: DEFAULT_TAB,
      help: 'Later blocks find the tab by this name. Use another name (e.g. "admin") for a second tab.',
    },
    { key: 'active', label: 'Switch to it', kind: 'boolean', help: 'Off = open quietly in the background.' },
    { key: 'waitUntil', label: 'Continue when', kind: 'select', options: WAIT_UNTIL_OPTIONS },
  ],
  summary: (config) => config.url || 'No URL yet',
  outputs: [
    { key: 'url', description: 'The URL that was opened.' },
    { key: 'tabId', description: 'Id of the tab it was opened in.' },
  ],

  async run(ctx, input) {
    const url = normalizeHttpUrl(ctx.config.url);
    if (!url) throw new Error(`"${ctx.config.url}" is not a valid http(s) URL`);
    const where = ctx.config.newTab === false && ctx.config.where === 'new' ? 'current' : ctx.config.where;
    const ownTab = where === 'workflow' ? await ctx.state.get<number>('tabId') : undefined;
    const { tabId } = await ctx.host.tabs.open({
      url,
      newTab: where !== 'current',
      newWindow: where === 'window',
      active: ctx.config.active,
      waitUntil: ctx.config.waitUntil,
      timeoutMs: Math.max(1_000, ctx.timeoutMs - 500),
      ...(ownTab !== undefined ? { reuseTabId: ownTab } : {}),
    });
    if (where === 'workflow') await ctx.state.set('tabId', tabId);
    ctx.log('info', `Opened ${url}`);
    return withSessionTab({ ...input, url, tabId }, ctx.config.tab, tabId);
  },
};
