import type { Payload } from './types';

/**
 * Tiny template language for block settings, in the spirit of n8n expressions.
 *
 *   {{url}}              value of `url` in the incoming payload
 *   {{$json.url}}        same thing, n8n-style
 *   {{item.name}}        nested values
 *   {{rows[0].title}}    array indexes
 *
 * Missing values render as an empty string. Objects render as JSON.
 * Only own properties are read, so `{{constructor}}` and friends resolve to nothing.
 */

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function hasTemplate(text: string): boolean {
  TOKEN.lastIndex = 0;
  return TOKEN.test(text);
}

export function getPath(data: unknown, rawPath: string): unknown {
  let path = rawPath.trim();
  if (path === '$json') return data;
  if (path.startsWith('$json.')) path = path.slice('$json.'.length);

  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((part) => part.length > 0);
  if (parts.length === 0) return undefined;

  let current: unknown = data;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

export function render(template: string, data: Payload): string {
  return template.replace(TOKEN, (_match, path: string) => stringify(getPath(data, path)));
}
