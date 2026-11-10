import { CodedError } from '../errors';
import { hasTemplate } from '../template';
import type { BlockDefinition } from '../types';

export interface ClearSiteDataConfig { origins: string }

/** Require explicit origins, not pages, wildcard patterns or an empty/global filter. */
export function parseSiteOrigins(text: string): [string, ...string[]] {
  const values = String(text ?? '').trim().split(/[\s,]+/).filter(Boolean);
  if (values.length === 0) throw new Error('List at least one HTTP(S) origin to clear.');
  if (values.length > 50) throw new Error('At most 50 origins can be cleared by one block.');
  const origins = values.map((value) => {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`Invalid site origin: ${value}`); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || /[*]/.test(url.hostname)) throw new Error(`Use an exact HTTP(S) origin, without a path, credentials, query, fragment or wildcard: ${value}`);
    return url.origin;
  });
  return [...new Set(origins)] as [string, ...string[]];
}

export const clearSiteDataBlock: BlockDefinition<ClearSiteDataConfig> = {
  type: 'clear-site-data',
  label: 'Clear Site Data',
  description: 'Chromium only: delete cookies, local storage, IndexedDB, Cache Storage and service workers for listed sites. Cookie deletion affects the whole registrable domain, including its subdomains.',
  icon: '🧹',
  accent: '#dc2626',
  permissions: ['browsingData'],
  defaultConfig: { origins: '' },
  fields: [{ key: 'origins', label: 'Site origins to clear', kind: 'text', multiline: true, templated: true, required: true, placeholder: 'https://shop.example.com\nhttps://api.example.com', help: 'Explicit HTTP(S) origins only, separated by newlines or commas. Deletion is permanent. Cookies are cleared for each whole registrable domain, including subdomains; other storage is filtered by origin. Never clears history, downloads, passwords or extension data.' }],
  validate: (config) => {
    if (hasTemplate(config.origins)) return [];
    try { parseSiteOrigins(config.origins); return []; }
    catch (error) { return [{ key: 'origins', code: 'config.value', message: error instanceof Error ? error.message : String(error) }]; }
  },
  summary: (config) => `clear ${config.origins.split(/[\s,]+/).filter(Boolean).length} site origin(s)`,
  outputs: [{ key: 'clearedOrigins', description: 'The exact origins whose site data was cleared (cookies use registrable-domain scope).' }],
  async run(ctx, input) {
    let origins: string[];
    try { origins = parseSiteOrigins(ctx.config.origins); }
    catch (error) { throw new CodedError('config.invalid', error instanceof Error ? error.message : String(error)); }
    await ctx.host.environment.clearSiteData({ origins });
    ctx.log('info', `Cleared site data for ${origins.join(', ')} (cookies include their registrable domains)`);
    return { ...input, clearedOrigins: origins };
  },
};
