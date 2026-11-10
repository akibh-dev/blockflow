import { CodedError } from '../errors';
import { requireSessionTab } from '../session';
import { urlMatches } from '../urlPattern';
import { PAGE_ACCENT, tabField } from './pageCommon';
import type { BlockDefinition, ConfigProblem } from '../types';
import type { RouteOptions, RouteRule } from '../network';

export interface RouteConfig { action: 'add' | 'clear'; backend: 'auto' | 'cdp' | 'dnr'; rules: string; tab: string }
export const MAX_ROUTE_RULES = 100;
export const MAX_ROUTE_BODY = 1_000_000;
const ACTIONS = new Set(['fulfill', 'abort', 'continue', 'modify', 'redirect']);
const KEYS = new Set(['url', 'method', 'action', 'status', 'headers', 'body', 'redirectUrl', 'delayMs']);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const invalid = (message: string): never => { throw new CodedError('config.invalid', message); };

/** Shared by import validation and the browser boundary, including callers outside the editor. */
export function parseRouteRules(raw: unknown): RouteRule[] {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return invalid('Rules must be a JSON array of route rules'); }
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ROUTE_RULES) return invalid(`Rules must contain 1 to ${MAX_ROUTE_RULES} entries`);
  return value.map((entry, index) => {
    const at = `Rule ${index + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return invalid(`${at} must be an object`);
    const rule = entry as Record<string, unknown>;
    for (const key of Object.keys(rule)) if (!KEYS.has(key)) return invalid(`${at}: unknown key "${key}"`);
    if (typeof rule.url !== 'string' || !rule.url.trim()) return invalid(`${at}: url is required`);
    try { urlMatches('https://blockflow.test/', rule.url); } catch { return invalid(`${at}: invalid URL pattern`); }
    if (typeof rule.action !== 'string' || !ACTIONS.has(rule.action)) return invalid(`${at}: action must be fulfill, abort, continue, modify or redirect`);
    if (rule.method !== undefined && (typeof rule.method !== 'string' || !TOKEN.test(rule.method))) return invalid(`${at}: method must be an HTTP method token`);
    if (rule.status !== undefined && (!Number.isInteger(rule.status) || Number(rule.status) < 100 || Number(rule.status) > 599 || rule.action !== 'fulfill')) return invalid(`${at}: status must be 100–599 and only applies to fulfill`);
    if (rule.delayMs !== undefined && (!Number.isInteger(rule.delayMs) || Number(rule.delayMs) < 0 || Number(rule.delayMs) > 30_000)) return invalid(`${at}: delayMs must be 0–30000`);
    if (rule.body !== undefined && (typeof rule.body !== 'string' || rule.body.length > MAX_ROUTE_BODY)) return invalid(`${at}: body must be text, at most ${MAX_ROUTE_BODY} characters`);
    if (rule.body !== undefined && rule.action !== 'fulfill' && rule.action !== 'modify') return invalid(`${at}: body only applies to fulfill or modify`);
    if (rule.headers !== undefined) {
      if (!rule.headers || typeof rule.headers !== 'object' || Array.isArray(rule.headers)) return invalid(`${at}: headers must be an object of text values`);
      if (rule.action !== 'fulfill' && rule.action !== 'modify') return invalid(`${at}: headers only apply to fulfill or modify`);
      for (const [name, header] of Object.entries(rule.headers)) {
        if (!TOKEN.test(name) || typeof header !== 'string' || /[\r\n\0]/.test(header)) return invalid(`${at}: invalid header name or value`);
      }
    }
    if (rule.action === 'redirect') {
      if (typeof rule.redirectUrl !== 'string') return invalid(`${at}: redirectUrl is required`);
      try { if (!/^https?:$/.test(new URL(rule.redirectUrl).protocol)) return invalid(`${at}: redirectUrl must be an absolute HTTP(S) URL`); }
      catch { return invalid(`${at}: redirectUrl must be an absolute HTTP(S) URL`); }
    } else if (rule.redirectUrl !== undefined) return invalid(`${at}: redirectUrl only applies to redirect`);
    if (rule.action === 'modify' && rule.body === undefined && rule.headers === undefined) return invalid(`${at}: modify needs headers or body`);
    return { ...rule, url: rule.url.trim(), ...(typeof rule.method === 'string' ? { method: rule.method.toUpperCase() } : {}) } as unknown as RouteRule;
  });
}

export function dnrCompatible(rules: readonly RouteRule[]): boolean {
  return rules.every((rule) => (rule.action === 'abort' || rule.action === 'redirect') && !rule.delayMs);
}

export const routeBlock: BlockDefinition<RouteConfig> = {
  type: 'route', label: 'Route', description: 'Mock, block or modify page requests for this run. Newest matching rule wins; clear removes the tab’s rules.',
  icon: '🚦', accent: PAGE_ACCENT, timeoutSeconds: 30,
  defaultConfig: { action: 'add', backend: 'auto', rules: '[]', tab: 'main' },
  permissions: (config) => {
    if (config.action === 'clear') return [];
    if (config.backend === 'dnr') return ['declarativeNetRequest'];
    if (config.backend === 'cdp') return ['debugger'];
    try { return dnrCompatible(parseRouteRules(config.rules)) ? ['declarativeNetRequest'] : ['debugger']; } catch { return []; }
  },
  fields: [
    { key: 'action', label: 'Do', kind: 'select', options: [{ value: 'add', label: 'add rules for the rest of the run' }, { value: 'clear', label: 'clear rules on this tab' }] },
    { key: 'backend', label: 'Use', kind: 'select', options: [{ value: 'auto', label: 'automatic (block/redirect: browser rules; mocking: Chromium CDP)' }, { value: 'cdp', label: 'Chromium debugger (all actions)' }, { value: 'dnr', label: 'browser rules (block/redirect only)' }] },
    { key: 'rules', label: 'Rules (JSON)', kind: 'text', multiline: true, templated: true, placeholder: '[{"url":"**/api/**","action":"fulfill","status":200,"body":"mocked"}]', help: 'An array: url pattern, optional method, action, optional status/headers/body/redirectUrl/delayMs. Last matching rule wins. CDP modify changes the outgoing request; browser rules support abort/redirect without delays.' },
    tabField,
  ],
  validate: (config) => {
    const issues: ConfigProblem[] = [];
    if (config.action !== 'add' && config.action !== 'clear') issues.push({ key: 'action', code: 'config.enum', message: 'Action must be add or clear' });
    if (!['auto', 'cdp', 'dnr'].includes(config.backend)) issues.push({ key: 'backend', code: 'config.enum', message: 'Backend must be auto, cdp or dnr' });
    if (config.action === 'add') {
      try {
        const rules = parseRouteRules(config.rules);
        if (config.backend === 'dnr' && !dnrCompatible(rules)) issues.push({ key: 'rules', code: 'config.value', message: 'Browser rules support only abort/redirect without delayMs; use CDP for mocking or modification' });
      } catch (error) { issues.push({ key: 'rules', code: 'config.value', message: error instanceof Error ? error.message : String(error) }); }
    }
    return issues;
  },
  outputs: [{ key: 'route', description: 'Installed rule count and backend ({rules, backend}). Cleared routes report zero rules.' }],
  summary: (config) => config.action === 'clear' ? 'clear page routes' : `route requests (${config.backend})`,
  async run(ctx, input) {
    const issues = routeBlock.validate?.(ctx.config) ?? [];
    if (issues.length) throw new CodedError('config.invalid', issues[0]!.message);
    const options: RouteOptions = { action: ctx.config.action, backend: ctx.config.backend, rules: ctx.config.action === 'clear' ? [] : parseRouteRules(ctx.config.rules) };
    const result = await ctx.host.network.route(requireSessionTab(input, ctx.config.tab), options);
    ctx.log('info', `Routes: ${result.rules} rule(s), ${result.backend}`);
    return { ...input, route: result };
  },
};
