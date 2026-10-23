import { ExpressionError, evaluate, parseExpression, toText } from './expression';
import type { Payload } from './types';

/**
 * Tiny template language for block settings, in the spirit of n8n expressions.
 *
 *   {{url}}              value of `url` in the incoming payload
 *   {{$json.url}}        same thing, n8n-style
 *   {{item.name}}        nested values
 *   {{rows[0].title}}    array indexes
 *
 *   {{ price * 1.1 }}    expressions and functions, see expression.ts
 *   {{ upper(name) }}
 *
 * Missing values render as an empty string. Objects render as JSON.
 * Only own properties are read, so `{{constructor}}` and friends resolve to nothing.
 */

/** Plain paths (also with dashes in names, like {{my-key}}) skip the expression parser. */
const PATH = /^\$?[\w-]+(?:\.[\w$-]+|\[\d+\])*$/;

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

/** The value of one `{{…}}` token: a path, or an expression. Invalid expressions give ''. */
export function resolveToken(token: string, data: Payload): unknown {
  const text = token.trim();
  if (PATH.test(text)) return getPath(data, text);
  try {
    return evaluate(text, data);
  } catch (error) {
    if (error instanceof ExpressionError) return '';
    throw error;
  }
}

export function render(template: string, data: Payload): string {
  return template.replace(TOKEN, (_match, token: string) => toText(resolveToken(token, data)));
}

/** Problems with the `{{…}}` expressions in a setting, for the editor. */
export function templateErrors(template: string): string[] {
  const errors: string[] = [];
  for (const [, token] of template.matchAll(TOKEN)) {
    const text = (token ?? '').trim();
    if (PATH.test(text)) continue;
    try {
      parseExpression(text);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}
