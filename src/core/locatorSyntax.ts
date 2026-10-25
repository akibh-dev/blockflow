/**
 * Locator syntax (string level only): splitting `A >> B` into steps and naming each step's engine.
 * Shared by the page agent (src/dom/locator.ts, which resolves steps against the DOM) and the
 * Playwright exporter. No DOM here.
 */

export class LocatorSyntaxError extends Error {}

export interface LocatorStep {
  engine: string;
  body: string;
}

export const ENGINES = new Set(['css', 'text', 'role', 'label', 'placeholder', 'testid', 'alt', 'title', 'xpath', 'nth', 'frame']);

/** Splits on `>>` outside quotes and brackets, leaving the shadow-piercing `>>>` alone. */
function splitSteps(source: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '(') depth += 1;
    else if (char === ']' || char === ')') depth -= 1;
    else if (depth === 0 && char === '>' && source[i + 1] === '>' && source[i - 1] !== '>' && source[i + 2] !== '>') {
      parts.push(source.slice(start, i));
      start = i + 2;
      i += 1;
    }
  }
  parts.push(source.slice(start));
  return parts.map((part) => part.trim());
}

export function parseLocatorSteps(source: string): LocatorStep[] {
  if (!source.trim()) throw new LocatorSyntaxError('The locator is empty');
  return splitSteps(source.trim()).map((part) => {
    if (!part) throw new LocatorSyntaxError(`Invalid locator: ${source}`);
    const match = /^([a-z]+)\s*=([\s\S]*)$/.exec(part);
    if (match && ENGINES.has(match[1] as string)) return { engine: match[1] as string, body: (match[2] as string).trim() };
    if (part.startsWith('//') || part.startsWith('(//')) return { engine: 'xpath', body: part };
    if (/^".*"$/s.test(part)) return { engine: 'text', body: part };
    return { engine: 'css', body: part };
  });
}
