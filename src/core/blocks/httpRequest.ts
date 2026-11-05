import { normalizeHttpUrl } from '../url';
import type { BlockDefinition } from '../types';

/** HTTP Request settings. `headers` is "Name: value" lines. */
export interface HttpRequestConfig {
  url: string;
  method: string;
  headers: string;
  body: string;
  failOnError: boolean;
}

/** Parses "Name: value" lines. Lines without a colon are ignored. */
function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const name = line.slice(0, index).trim();
    if (name) headers[name] = line.slice(index + 1).trim();
  }
  return headers;
}

/**
 * HTTP Request — calls a URL and passes on `status`, `ok`, `body` and, when the body is JSON, `data`.
 * Runs from the extension, so it needs the site's host permission (we ask for all sites).
 */
export const httpRequestBlock: BlockDefinition<HttpRequestConfig> = {
  type: 'http-request',
  label: 'HTTP Request',
  description: 'Call an API or webhook and use the response.',
  icon: '🌐',
  accent: '#14b8a6',
  defaultConfig: { url: '', method: 'GET', headers: '', body: '', failOnError: true },
  fields: [
    { key: 'url', label: 'URL', kind: 'url', required: true, templated: true, placeholder: 'https://api.example.com/x' },
    {
      key: 'method',
      label: 'Method',
      kind: 'select',
      options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((value) => ({ value, label: value })),
    },
    {
      key: 'headers',
      label: 'Headers',
      kind: 'text',
      templated: true,
      help: 'One per line, as  Name: value',
    },
    {
      key: 'body',
      label: 'Body',
      kind: 'text',
      templated: true,
      help: 'Sent for POST, PUT, PATCH and DELETE.',
    },
    { key: 'failOnError', label: 'Stop the flow on HTTP errors (4xx, 5xx)', kind: 'boolean' },
  ],
  summary: (config) => `${config.method} ${config.url || '…'}`,
  outputs: [
    { key: 'url', description: 'The URL that was called (handy as the base for Extract from HTML).' },
    { key: 'status', description: 'HTTP status code.' },
    { key: 'ok', description: 'True for 2xx responses.' },
    { key: 'body', description: 'Response text.' },
    { key: 'data', description: 'Parsed JSON, when the body is JSON.' },
  ],

  async run(ctx, input) {
    const url = normalizeHttpUrl(ctx.config.url);
    if (!url) throw new Error(`"${ctx.config.url}" is not a valid http(s) URL`);
    const { method } = ctx.config;
    const sendsBody = method !== 'GET' && ctx.config.body !== '';
    const result = await ctx.host.http.fetch({
      url,
      method,
      headers: parseHeaders(ctx.config.headers),
      ...(sendsBody ? { body: ctx.config.body } : {}),
    });
    ctx.log(result.ok ? 'info' : 'warn', `${method} ${url} → ${result.status}`);
    if (!result.ok && ctx.config.failOnError) return null;

    let data: unknown;
    try {
      data = JSON.parse(result.body);
    } catch {
      data = undefined;
    }
    return {
      ...input,
      url,
      status: result.status,
      ok: result.ok,
      body: result.body,
      ...(data !== undefined ? { data } : {}),
    };
  },
};
