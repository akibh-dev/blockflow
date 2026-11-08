import { CodedError } from '../errors';
import { requireSessionTab } from '../session';
import { PAGE_ACCENT, inPage, tabField } from './pageCommon';
import type { BlockDefinition, BlockContext, ConfigProblem, CookieSetOptions, Payload } from '../types';

/** Cookies & Storage settings. The cookie-only ones (`url` … `sameSite`) matter for `area: cookies`. */
export interface CookiesStorageConfig {
  tab: string;
  action: 'get' | 'set' | 'delete' | 'clear';
  area: 'cookies' | 'local' | 'session';
  name: string;
  value: string;
  url: string;
  domain: string;
  path: string;
  /** Seconds from now; 0 = a session cookie. */
  maxAgeSeconds: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: '' | 'Strict' | 'Lax' | 'None';
}

/**
 * Cookies & Storage — read, set, delete or clear cookies (the browser's cookie jar, HttpOnly ones too;
 * optional "cookies" permission) or the page's localStorage / sessionStorage (page agent `storage` op).
 */
export const cookiesStorageBlock: BlockDefinition<CookiesStorageConfig> = {
  type: 'cookies-storage',
  label: 'Cookies & Storage',
  description: "Read, set, delete or clear a site's cookies, or the page's localStorage / sessionStorage.",
  icon: '🍪',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: 'main', action: 'get', area: 'cookies', name: '', value: '', url: '', domain: '', path: '', maxAgeSeconds: 0, httpOnly: false, secure: false, sameSite: '' },
  timeoutSeconds: 30,
  permissions: (config) => (config.area === 'cookies' ? ['cookies'] : []),
  fields: [
    {
      key: 'action',
      label: 'Do',
      kind: 'select',
      options: [
        { value: 'get', label: 'get (one, or all of them)' },
        { value: 'set', label: 'set' },
        { value: 'delete', label: 'delete one' },
        { value: 'clear', label: 'clear all' },
      ],
    },
    {
      key: 'area',
      label: 'In',
      kind: 'select',
      options: [
        { value: 'cookies', label: 'cookies (the site’s, HttpOnly too)' },
        { value: 'local', label: 'localStorage of the page' },
        { value: 'session', label: 'sessionStorage of the page' },
      ],
    },
    { key: 'name', label: 'Name / key', kind: 'text', templated: true, placeholder: 'session_id', help: 'Needed to set or delete. For get: empty = all of them.' },
    { key: 'value', label: 'Value', kind: 'text', templated: true, placeholder: '{{token}}', help: 'For set.' },
    {
      key: 'url',
      label: 'Site (cookies, optional)',
      kind: 'text',
      templated: true,
      placeholder: 'https://shop.test',
      help: 'Whose cookies. Empty = the page open in the tab.',
    },
    { key: 'domain', label: 'Domain (set, optional)', kind: 'text', templated: true, placeholder: '.shop.test', help: 'With a leading dot the cookie is also sent to subdomains.' },
    { key: 'path', label: 'Path (set, optional)', kind: 'text', placeholder: '/' },
    { key: 'maxAgeSeconds', label: 'Expires in seconds (set)', kind: 'number', min: 0, help: '0 = a session cookie, gone when the browser closes.' },
    { key: 'httpOnly', label: 'HttpOnly (set)', kind: 'boolean' },
    { key: 'secure', label: 'Secure (set)', kind: 'boolean' },
    {
      key: 'sameSite',
      label: 'SameSite (set)',
      kind: 'select',
      options: [
        { value: '', label: "browser's default" },
        { value: 'Lax', label: 'Lax' },
        { value: 'Strict', label: 'Strict' },
        { value: 'None', label: 'None (needs Secure)' },
      ],
    },
    tabField,
  ],
  summary: (config) => `${config.action} ${config.area === 'cookies' ? 'cookie' : `${config.area}Storage`}${config.name ? ` ${config.name}` : config.action === 'clear' ? 's' : ''}`,
  validate: (config) => {
    const problems: ConfigProblem[] = [];
    if ((config.action === 'set' || config.action === 'delete') && !String(config.name ?? '').trim()) {
      problems.push({ key: 'name', code: 'config.required', message: `Name / key is required to ${config.action}` });
    }
    return problems;
  },
  outputs: [
    { key: 'value', description: 'get with a name: the value (null when missing). get without: an object of name → value. set: the value.' },
    { key: 'cookies', description: 'Cookies, get/set: the full cookies [{name, value, domain, path, expires, httpOnly, secure, sameSite}].' },
    { key: 'deleted', description: 'delete / clear: how many were removed.' },
  ],

  async run(ctx, input) {
    const { action, area } = ctx.config;
    const name = ctx.config.name.trim();
    if ((action === 'set' || action === 'delete') && !name) throw new CodedError('config.invalid', `Name / key is required to ${action}`);
    if (area !== 'cookies') {
      const { result } = await inPage(ctx, input, { op: 'storage', area, action, ...(name ? { key: name } : {}), ...(action === 'set' ? { value: ctx.config.value } : {}) });
      const label = `${area}Storage`;
      if (action === 'get') return { ...input, value: result.value };
      if (action === 'set') {
        ctx.log('info', `${label}: set ${name}`);
        return { ...input, value: result.value };
      }
      const deleted = Number(action === 'clear' ? result.cleared : result.deleted) || 0;
      ctx.log('info', `${label}: removed ${deleted}`);
      return { ...input, deleted };
    }
    const url = await siteUrl(ctx, input);
    if (action === 'get') {
      const cookies = await ctx.host.cookies.get(url, name || undefined);
      const value = name ? (cookies[0]?.value ?? null) : Object.fromEntries(cookies.map((cookie) => [cookie.name, cookie.value]));
      return { ...input, value, cookies };
    }
    if (action === 'set') {
      const { domain, path, maxAgeSeconds, httpOnly, secure, sameSite } = ctx.config;
      const options: CookieSetOptions = {
        url,
        name,
        value: ctx.config.value,
        ...(domain.trim() ? { domain: domain.trim() } : {}),
        ...(path.trim() ? { path: path.trim() } : {}),
        ...(Number(maxAgeSeconds) > 0 ? { expires: Math.round(ctx.host.now().getTime() / 1000 + Number(maxAgeSeconds)) } : {}),
        ...(httpOnly ? { httpOnly } : {}),
        ...(secure ? { secure } : {}),
        ...(sameSite ? { sameSite } : {}),
      };
      const cookie = await ctx.host.cookies.set(options);
      ctx.log('info', `Cookie ${name} set for ${cookie.domain}${cookie.path}`);
      return { ...input, value: cookie.value, cookies: [cookie] };
    }
    const deleted = await ctx.host.cookies.remove(url, action === 'delete' ? name : undefined);
    ctx.log('info', `Removed ${deleted} cookie${deleted === 1 ? '' : 's'} of ${url}`);
    return { ...input, deleted };
  },
};

/** The cookie site: the setting, or the URL of the run's tab. */
async function siteUrl(ctx: BlockContext<CookiesStorageConfig>, input: Payload): Promise<string> {
  const configured = ctx.config.url.trim();
  if (configured) return configured;
  const tabId = requireSessionTab(input, ctx.config.tab || 'main');
  const info = await ctx.host.tabs.info(tabId);
  if (!info?.url) throw new CodedError('tab.closed', 'The tab was closed');
  return info.url;
}
