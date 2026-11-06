import { CodedError } from '../errors';
import { requireSessionTab } from '../session';
import { hasTemplate } from '../template';
import { normalizeHttpUrl } from '../url';
import { WAIT_UNTIL_OPTIONS } from './openUrl';
import { PAGE_ACCENT, tabField } from './pageCommon';
import type { WaitUntil } from '../page';
import type { BlockDefinition } from '../types';

/** Navigate settings. `url` is only used (and validated) for `action: 'goto'`. */
export interface NavigateConfig {
  tab: string;
  action: 'goto' | 'back' | 'forward' | 'reload';
  url: string;
  waitUntil: WaitUntil;
}

/** Navigate: goto/back/forward/reload through `Host.tabs.navigate` (not the page agent); adds `url`. */
export const navigateBlock: BlockDefinition<NavigateConfig> = {
  type: 'navigate',
  label: 'Navigate',
  description: 'Go to a URL, back, forward, or reload, in a tab of this run.',
  icon: '🧭',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: 'main', action: 'goto', url: '', waitUntil: 'load' },
  timeoutSeconds: 45,
  fields: [
    tabField,
    {
      key: 'action',
      label: 'Action',
      kind: 'select',
      options: [
        { value: 'goto', label: 'go to URL' },
        { value: 'back', label: 'back' },
        { value: 'forward', label: 'forward' },
        { value: 'reload', label: 'reload' },
      ],
    },
    { key: 'url', label: 'URL', kind: 'text', templated: true, placeholder: 'https://… (only for "go to URL")' },
    { key: 'waitUntil', label: 'Continue when', kind: 'select', options: WAIT_UNTIL_OPTIONS },
  ],
  summary: (config) => (config.action === 'goto' ? `Go to ${config.url || '…'}` : config.action),
  validate: (config) => {
    if (config.action !== 'goto') return [];
    const url = String(config.url ?? '').trim();
    if (!url) return [{ key: 'url', code: 'config.required', message: 'URL is required for "go to URL"' }];
    if (!hasTemplate(url) && !normalizeHttpUrl(url)) return [{ key: 'url', code: 'config.url.invalid', message: `"${url}" is not a valid http(s) URL` }];
    return [];
  },
  outputs: [{ key: 'url', description: 'The URL after navigating.' }],

  async run(ctx, input) {
    const tabId = requireSessionTab(input, ctx.config.tab);
    let url: string | undefined;
    if (ctx.config.action === 'goto') {
      url = normalizeHttpUrl(ctx.config.url) ?? undefined;
      if (!url) throw new CodedError('config.invalid', `"${ctx.config.url}" is not a valid http(s) URL`);
    }
    const result = await ctx.host.tabs.navigate(tabId, {
      action: ctx.config.action,
      ...(url ? { url } : {}),
      waitUntil: ctx.config.waitUntil,
      timeoutMs: Math.max(1_000, ctx.timeoutMs - 500),
    });
    ctx.log('info', `${ctx.config.action === 'goto' ? 'Went to' : `${ctx.config.action}:`} ${result.url}`);
    return { ...input, url: result.url };
  },
};
