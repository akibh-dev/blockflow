import { DEFAULT_TAB } from '../session';
import { inPage, PAGE_ACCENT, tabField } from './pageCommon';
import type { BlockDefinition } from '../types';

/** Page Info settings: `page` uses the `page-info` op, the other areas the `storage` op. */
export interface PageInfoConfig {
  tab: string;
  area: 'page' | 'local' | 'session' | 'cookies';
  key: string;
}

/** Page Info — the page's URL, title, meta tags and JSON-LD; or its localStorage, sessionStorage, cookies. */
export const pageInfoBlock: BlockDefinition<PageInfoConfig> = {
  type: 'page-info',
  label: 'Page Info',
  description: 'Read the page itself: title, meta tags, JSON-LD, or its localStorage / cookies.',
  icon: 'ℹ️',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: DEFAULT_TAB, area: 'page', key: '' },
  timeoutSeconds: 30,
  fields: [
    {
      key: 'area',
      label: 'Read',
      kind: 'select',
      options: [
        { value: 'page', label: 'URL, title, description, meta tags, JSON-LD' },
        { value: 'local', label: 'localStorage' },
        { value: 'session', label: 'sessionStorage' },
        { value: 'cookies', label: 'cookies (not HttpOnly ones)' },
      ],
    },
    { key: 'key', label: 'Key (optional)', kind: 'text', templated: true, placeholder: 'theme', help: 'Storage and cookies: one key. Empty = all of them.' },
    tabField,
  ],
  summary: (config) => (config.area === 'page' ? 'page info' : `${config.area}${config.key ? `: ${config.key}` : ''}`),
  outputs: [
    { key: 'page', description: 'For "page": url, title, description, canonical, lang, meta, jsonLd, links.' },
    { key: 'value', description: 'For storage and cookies: the value (or an object of all of them).' },
  ],

  async run(ctx, input) {
    if (ctx.config.area === 'page') {
      const { result } = await inPage(ctx, input, { op: 'page-info' });
      return { ...input, page: result };
    }
    const key = ctx.config.key.trim();
    const { result } = await inPage(ctx, input, { op: 'storage', area: ctx.config.area, ...(key ? { key } : {}) });
    return { ...input, value: result.value };
  },
};
