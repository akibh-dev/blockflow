import conditionSource from './condition.ts?raw';
import csvSource from './csv.ts?raw';
import expressionSource from './expression.ts?raw';
import templateSource from './template.ts?raw';
import urlPatternSource from './urlPattern.ts?raw';

/**
 * The BlockFlow runtime inlined into exported Playwright specs: the real source of the pure core
 * modules (expressions, templates, conditions, CSV, URL patterns), read at build time with Vite's
 * `?raw` import, so the exported test computes exactly what the extension does and cannot drift.
 *
 * Each module becomes a closure (`const expressionModule = (() => { …source… return { exports }; })();`):
 * `export` keywords are dropped, value imports between the modules become destructuring, and type
 * imports go (the only one, `Payload`, is declared once at the top).
 */

/** In dependency order: a module may only import from the ones above it. */
const MODULES: [name: string, source: string][] = [
  ['expression', expressionSource],
  ['condition', conditionSource],
  ['csv', csvSource],
  ['urlPattern', urlPatternSource],
  ['template', templateSource],
];

/** One module's source as a closure that returns its exports. Throws on an import it cannot map. */
export function wrapModule(name: string, source: string, known: readonly string[]): string {
  const exported: string[] = [];
  const body = source
    .split('\n')
    .map((line) => {
      if (/^import type\b/.test(line)) return null;
      const value = /^import \{([^}]+)\} from '\.\/(\w+)';$/.exec(line);
      if (value) {
        if (!known.includes(value[2] as string)) throw new Error(`playwrightRuntime: ${name} imports ./${value[2]}, which is not inlined`);
        return `const {${value[1]}} = ${value[2]}Module;`;
      }
      if (/^import\b/.test(line)) throw new Error(`playwrightRuntime: cannot inline "${line}" in ${name}`);
      const declared = /^export (?:async )?(?:function|const|let|class) (\w+)/.exec(line);
      if (declared) exported.push(declared[1] as string);
      return line.replace(/^export /, '');
    })
    .filter((line): line is string => line !== null)
    .join('\n')
    .trim();
  return `const ${name}Module = (() => {\n${body}\n\nreturn { ${exported.join(', ')} };\n})();`;
}

let cached: string | undefined;

/** The whole runtime: `type Payload` plus every module closure. */
export function runtimeSource(): string {
  if (cached) return cached;
  const parts = ['type Payload = Record<string, unknown>;'];
  const known: string[] = [];
  for (const [name, source] of MODULES) {
    parts.push(wrapModule(name, source, known));
    known.push(name);
  }
  cached = parts.join('\n\n');
  return cached;
}
