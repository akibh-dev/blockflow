import { parseLocatorSteps } from './locatorSyntax';
import { edgePort, nodePorts } from './ports';
import type { BlockRegistry } from './registry';
import type { NodeDef, Workflow } from './types';

/**
 * Export a workflow as a Playwright test (`.spec.ts`), so a flow built in the browser can run in CI.
 * Page blocks map almost 1:1 because BlockFlow's locators follow Playwright's. Blocks with no
 * Playwright equivalent (notifications, datasets, schedules) become comments.
 */

export interface ExportOptions {
  registry: BlockRegistry;
  /** Other saved workflows, so Run Workflow blocks become functions. */
  lookup?(id: string): Workflow | undefined;
}

const js = (text: unknown) => JSON.stringify(String(text ?? ''));

/** A BlockFlow locator as a Playwright locator expression on `base` (a page or locator expression). */
export function toPlaywrightLocator(locator: string, base: string): string {
  let code = base;
  for (const { engine, body } of parseLocatorSteps(locator)) {
    const quoted = /^(["'])([\s\S]*)\1$/.exec(body.trim());
    const regex = /^\/([\s\S]+)\/([dgimsuyv]*)$/.exec(body.trim());
    const textArg = regex ? `/${regex[1]}/${regex[2]}` : js(quoted ? quoted[2] : body.trim());
    const exact = quoted ? ', { exact: true }' : '';
    switch (engine) {
      case 'css':
        // Playwright's CSS already pierces open shadow roots.
        code += `.locator(${js(body.replace(/\s*>>>\s*/g, ' '))})`;
        break;
      case 'xpath':
        code += `.locator(${js(`xpath=${body}`)})`;
        break;
      case 'text':
        code += `.getByText(${textArg}${exact})`;
        break;
      case 'label':
        code += `.getByLabel(${textArg}${exact})`;
        break;
      case 'placeholder':
        code += `.getByPlaceholder(${textArg}${exact})`;
        break;
      case 'alt':
        code += `.getByAltText(${textArg}${exact})`;
        break;
      case 'title':
        code += `.getByTitle(${textArg}${exact})`;
        break;
      case 'testid':
        code += `.getByTestId(${js(quoted ? quoted[2] : body.trim())})`;
        break;
      case 'frame':
        code += `.frameLocator(${js(body)})`;
        break;
      case 'nth': {
        const index = Number(body);
        code += index === -1 ? '.last()' : index === 0 ? '.first()' : `.nth(${index})`;
        break;
      }
      case 'role': {
        const match = /^([a-z-]+)\s*([\s\S]*)$/i.exec(body.trim());
        const role = match?.[1] ?? body;
        const options: string[] = [];
        for (const attr of (match?.[2] ?? '').matchAll(/\[\s*([a-z-]+)\s*(?:=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/(?:[^/\\]|\\.)+\/[a-z]*|[^\]]*?))?\s*\]/gi)) {
          const key = (attr[1] as string).toLowerCase();
          const value = attr[2];
          if (key === 'name' && value) {
            const named = /^\/([\s\S]+)\/([dgimsuyv]*)$/.exec(value);
            options.push(`name: ${named ? `/${named[1]}/${named[2]}` : js(value.replace(/^(["'])([\s\S]*)\1$/, '$2'))}`);
          } else if (key === 'exact') options.push('exact: true');
          else if (key === 'checked') options.push(`checked: ${value === undefined || !/false/.test(value)}`);
          else if (key === 'level') options.push(`level: ${Number(String(value).replace(/["']/g, ''))}`);
        }
        code += `.getByRole(${js(role)}${options.length ? `, { ${options.join(', ')} }` : ''})`;
        break;
      }
    }
  }
  return code;
}

/** `{{a.b}}` in a setting → a template string reading `data`. Expressions become a TODO. */
function template(text: unknown): string {
  const source = String(text ?? '');
  if (!source.includes('{{')) return js(source);
  const parts = source.split(/(\{\{[\s\S]+?\}\})/g).filter(Boolean);
  return `\`${parts
    .map((part) => {
      const token = /^\{\{\s*([\s\S]+?)\s*\}\}$/.exec(part);
      if (!token) return part.replace(/[`\\$]/g, (char) => `\\${char}`);
      const path = token[1] as string;
      if (path.startsWith('secret.')) return `\${process.env[${js(path.slice(7).replace(/[^\w]/g, '_').toUpperCase())}] ?? ''}`;
      if (/^\$?[\w]+(?:\.[\w$]+|\[\d+\])*$/.test(path)) return `\${get(data, ${js(path)})}`;
      return `\${/* TODO expression: ${path.replace(/\*\//g, '* /')} */ ''}`;
    })
    .join('')}\``;
}

function tab(config: Record<string, unknown>): string {
  return `tabs[${js(config.tab || 'main')}]`;
}

class Writer {
  private lines: string[] = [];
  private depth = 1;
  readonly functions = new Map<string, string>();

  constructor(
    private readonly workflow: Workflow,
    private readonly options: ExportOptions,
    private readonly calls: Set<string>,
  ) {}

  line(text: string): void {
    this.lines.push(`${'  '.repeat(this.depth)}${text}`);
  }

  block(open: string, body: () => void, close = '}'): void {
    this.line(open);
    this.depth += 1;
    body();
    this.depth -= 1;
    this.line(close);
  }

  out(): string {
    return this.lines.join('\n');
  }

  private targets(node: NodeDef, port: string): NodeDef[] {
    const def = this.options.registry.get(node.type);
    const ports = nodePorts(def, node);
    return this.workflow.edges
      .filter((edge) => edge.source === node.id && edgePort(edge, ports) === port)
      .map((edge) => this.workflow.nodes.find((candidate) => candidate.id === edge.target))
      .filter((candidate): candidate is NodeDef => Boolean(candidate));
  }

  /** Writes `node`, then everything after it. `seen` stops loops. */
  walk(node: NodeDef, seen: Set<string>): void {
    if (seen.has(node.id)) {
      this.line(`// (loop back to "${this.options.registry.get(node.type)?.label ?? node.type}" not exported)`);
      return;
    }
    const nextSeen = new Set(seen).add(node.id);
    const continueWith = (port = 'out') => {
      for (const next of this.targets(node, port)) this.walk(next, nextSeen);
    };
    const c = node.config;
    const label = this.options.registry.get(node.type)?.label ?? node.type;
    const loc = (key = 'locator') => toPlaywrightLocator(String(c[key] ?? ''), tab(c));
    const handlesError = node.step?.onError === 'port' && this.targets(node, 'error').length > 0;
    const body = () => this.statement(node, label, c, loc, continueWith);
    if (handlesError) {
      this.block('try {', body);
      this.block('catch (error) {', () => {
        this.line('data.error = String(error);');
        for (const next of this.targets(node, 'error')) this.walk(next, nextSeen);
      });
    } else body();
  }

  private statement(
    node: NodeDef,
    label: string,
    c: Record<string, unknown>,
    loc: (key?: string) => string,
    continueWith: (port?: string) => void,
  ): void {
    const ports = nodePorts(this.options.registry.get(node.type), node);
    switch (node.type) {
      case 'open-url':
        this.line(`tabs[${js(c.tab || 'main')}] = await context.newPage();`);
        this.line(`await tabs[${js(c.tab || 'main')}].goto(${template(c.url)}${c.waitUntil === 'networkidle' ? ", { waitUntil: 'networkidle' }" : ''});`);
        this.line(`data.url = tabs[${js(c.tab || 'main')}].url();`);
        break;
      case 'navigate':
        if (c.action === 'goto') this.line(`await ${tab(c)}.goto(${template(c.url)});`);
        else this.line(`await ${tab(c)}.${c.action === 'back' ? 'goBack' : c.action === 'forward' ? 'goForward' : 'reload'}();`);
        break;
      case 'close-tab':
        this.line(`await ${tab(c)}.close();`);
        break;
      case 'click': {
        const action = c.action === 'double' ? 'dblclick' : c.action === 'hover' ? 'hover' : 'click';
        const opts = [c.action === 'right' ? "button: 'right'" : '', c.force ? 'force: true' : ''].filter(Boolean);
        this.line(`await ${loc()}.${action}(${opts.length ? `{ ${opts.join(', ')} }` : ''});`);
        break;
      }
      case 'fill':
        this.line(c.mode === 'type' ? `await ${loc()}.pressSequentially(${template(c.value)});` : `await ${loc()}.fill(${template(c.value)});`);
        break;
      case 'fill-form':
        for (const row of (c.fields as Record<string, string>[] | undefined) ?? []) {
          if (!row.locator || !row.value) continue;
          this.line(`await setField(${toPlaywrightLocator(row.locator, tab(c))}, ${template(row.value)});`);
        }
        if (c.submit) this.line(`await ${loc('submit')}.click();`);
        break;
      case 'select-option':
        this.line(`await selectByText(${loc()}, ${template(c.value)});`);
        break;
      case 'check':
        this.line(`await ${loc()}.setChecked(${c.state !== 'uncheck'});`);
        break;
      case 'press-key':
        this.line(c.locator ? `await ${loc()}.press(${js(c.key)});` : `await ${tab(c)}.keyboard.press(${js(c.key)});`);
        break;
      case 'scroll':
        this.line(c.to === 'element' ? `await ${loc()}.scrollIntoViewIfNeeded();` : `await ${tab(c)}.mouse.wheel(0, ${c.to === 'top' ? -100000 : 100000});`);
        break;
      case 'wait-for':
        this.waitFor(c, loc);
        break;
      case 'read-element':
        if (c.url) {
          this.line(`{ const reader = await context.newPage(); await reader.goto(${template(c.url)}); data.value = await read(${toPlaywrightLocator(String(c.selector), 'reader')}, ${js(c.read)}, ${js(c.name)}); await reader.close(); }`);
        } else this.line(`data.value = await read(${toPlaywrightLocator(String(c.selector), tab(c))}, ${js(c.read)}, ${js(c.name)});`);
        break;
      case 'assert':
        this.assert(c, loc);
        break;
      case 'extract-list':
        if (c.source === 'html') {
          this.line(`// TODO: Extract List from HTML in the data is not exported (use a page instead).`);
          break;
        }
        this.line(`data[${js(c.into || 'items')}] = await extractList(${loc()}, ${JSON.stringify(((c.fields as Record<string, string>[]) ?? []).filter((f) => f.name))});`);
        break;
      case 'extract-table':
        this.line(`data[${js(c.into || 'rows')}] = await extractTable(${loc()});`);
        break;
      case 'page-info':
        this.line(`data.page = { url: ${tab(c)}.url(), title: await ${tab(c)}.title() };`);
        break;
      case 'if':
        this.block(`if (compare(${template(c.left)}, ${js(c.operator)}, ${template(c.right)})) {`, () => continueWith('true'));
        if (this.targets(node, 'false').length > 0) this.block('else {', () => continueWith('false'));
        return;
      case 'for-each':
        this.block(`for (const [index, item] of (get(data, ${js(c.list)}) ?? []).entries()) {`, () => {
          this.line(`data = { ...data, ${JSON.stringify(String(c.as || 'item'))}: item, index };`);
          continueWith('each');
        });
        continueWith('done');
        return;
      case 'repeat':
        this.block(`for (let iteration = 1; iteration <= ${Number(c.times) || 1}; iteration += 1) {`, () => {
          this.line('data = { ...data, iteration };');
          continueWith('each');
        });
        continueWith('done');
        return;
      case 'paginate':
        this.block(`for (let page = 1; page <= ${Number(c.maxPages) || 10}; page += 1) {`, () => {
          this.line('data = { ...data, page };');
          continueWith('each');
          this.line(`const next = ${toPlaywrightLocator(String(c.next), tab(c))}.first();`);
          this.line('if (!(await next.isVisible()) || !(await next.isEnabled())) break;');
          this.line('await next.click();');
          this.line(`await ${tab(c)}.waitForLoadState('networkidle');`);
        });
        continueWith('done');
        return;
      case 'set-variable':
        this.line(`data[${js(c.name)}] = ${template(c.value)};`);
        break;
      case 'data-table':
        this.line(`data[${js(c.into || 'rows')}] = parseRows(${js(c.text)});`);
        break;
      case 'log':
        this.line(`console.log(${template(c.message)});`);
        break;
      case 'stop':
        this.line(c.outcome === 'fail' ? `throw new Error(${template(c.message || 'Stopped as failed')});` : 'return;');
        return;
      case 'manual-step':
        this.line(`await ${tab(c)}.pause(); // ${String(c.message ?? '').replace(/\n/g, ' ')}`);
        break;
      case 'http-request':
        this.line(`{ const response = await request.fetch(${template(c.url)}, { method: ${js(c.method || 'GET')}${c.body ? `, data: ${template(c.body)}` : ''} });`);
        this.line('  data.status = response.status(); data.ok = response.ok(); data.body = await response.text(); try { data.data = JSON.parse(data.body); } catch {} }');
        break;
      case 'run-workflow': {
        const called = this.options.lookup?.(String(c.workflow));
        if (!called) {
          this.line(`// TODO: Run Workflow (the called workflow was not found)`);
          break;
        }
        this.calls.add(called.id);
        this.line(`data = await ${functionName(called)}(tabs, data, context, request);`);
        break;
      }
      case 'start':
        for (const row of (c.inputs as Record<string, string>[] | undefined) ?? []) {
          if (row.name) this.line(`data[${js(row.name)}] ??= ${template(row.value)};`);
        }
        break;
      case 'timer':
      case 'schedule':
      case 'page-visited':
      case 'context-menu':
      case 'watch-element':
        this.line(`// ${label}: a BlockFlow trigger; the test starts here instead.`);
        break;
      default:
        this.line(`// ${label}: no Playwright equivalent, skipped.`);
    }
    continueWith(ports[0] ?? 'out');
  }

  private waitFor(c: Record<string, unknown>, loc: (key?: string) => string): void {
    switch (c.mode) {
      case 'visible':
        this.line(`await expect(${loc()}).toBeVisible();`);
        break;
      case 'hidden':
        this.line(`await expect(${loc()}).toBeHidden();`);
        break;
      case 'attached':
        this.line(`await expect(${loc()}).toBeAttached();`);
        break;
      case 'detached':
        this.line(`await expect(${loc()}).toHaveCount(0);`);
        break;
      case 'enabled':
        this.line(`await expect(${loc()}).toBeEnabled();`);
        break;
      case 'text':
      case 'no-text': {
        const scope = c.locator ? loc() : `${tab(c)}.locator('body')`;
        this.line(`await expect(${scope}).${c.mode === 'text' ? '' : 'not.'}toContainText(${template(c.text)});`);
        break;
      }
      case 'url':
        this.line(`await ${tab(c)}.waitForURL(urlPattern(${template(c.url)}));`);
        break;
      default:
        this.line(`await ${tab(c)}.waitForLoadState(${js(c.mode === 'networkidle' ? 'networkidle' : 'load')});`);
    }
  }

  private assert(c: Record<string, unknown>, loc: (key?: string) => string): void {
    const expectFn = c.soft ? 'expect.soft' : 'expect';
    const message = c.message ? `, ${template(c.message)}` : '';
    const subject = String(c.subject);
    const states: Record<string, string> = {
      visible: 'toBeVisible()',
      hidden: 'toBeHidden()',
      checked: 'toBeChecked()',
      unchecked: 'not.toBeChecked()',
      enabled: 'toBeEnabled()',
      disabled: 'toBeDisabled()',
    };
    if (states[subject]) {
      this.line(`await ${expectFn}(${loc()}${message}).${states[subject]};`);
      return;
    }
    if (subject === 'text' && (c.operator === 'equals' || c.operator === 'contains')) {
      this.line(`await ${expectFn}(${loc()}${message}).${c.operator === 'equals' ? 'toHaveText' : 'toContainText'}(${template(c.expected)});`);
      return;
    }
    if (subject === 'input' && c.operator === 'equals') {
      this.line(`await ${expectFn}(${loc()}${message}).toHaveValue(${template(c.expected)});`);
      return;
    }
    if (subject === 'count' && c.operator === 'equals') {
      this.line(`await ${expectFn}(${loc()}${message}).toHaveCount(Number(${template(c.expected)}));`);
      return;
    }
    const actual =
      subject === 'value'
        ? template(c.value)
        : subject === 'url'
          ? `${tab(c)}.url()`
          : subject === 'title'
            ? `await ${tab(c)}.title()`
            : `await read(${loc()}, ${js(subject === 'input' ? 'value' : subject)}, ${js(c.name)})`;
    this.line(`${expectFn}(compare(${actual}, ${js(c.operator)}, ${template(c.expected)})${message}).toBe(true);`);
  }
}

function functionName(workflow: Workflow): string {
  const words = workflow.name.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const base = words.map((word, index) => (index === 0 ? word.toLowerCase() : word[0]?.toUpperCase() + word.slice(1).toLowerCase())).join('') || 'workflow';
  return `${/^\d/.test(base) ? '_' : ''}${base}_${workflow.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 6)}`;
}

function bodyOf(workflow: Workflow, options: ExportOptions, calls: Set<string>): string {
  const writer = new Writer(workflow, options, calls);
  const fed = new Set(workflow.edges.map((edge) => edge.target));
  const roots = workflow.nodes.filter((node) => !fed.has(node.id));
  for (const root of roots) writer.walk(root, new Set());
  return writer.out();
}

const HELPERS = `
// --- helpers (exported by BlockFlow) ---------------------------------------

/** Reads a dotted path like "data.items[0].title". */
function get(data: any, path: string): any {
  return path.replace(/\\[(\\d+)\\]/g, '.$1').split('.').filter(Boolean).reduce((value, key) => (value == null ? undefined : value[key]), data);
}

/** Sets any form field from text, like BlockFlow's Fill Form. */
async function setField(field: Locator, value: string) {
  const kind = await field.evaluate((element: any) => \`\${element.tagName.toLowerCase()}:\${element.type ?? ''}\`);
  if (kind.startsWith('select')) await selectByText(field, value);
  else if (/checkbox|radio/.test(kind)) await field.setChecked(/^(true|yes|on|1|checked)$/i.test(value.trim()));
  else await field.fill(value);
}

async function selectByText(select: Locator, value: string) {
  const values = value.split('|').map((part) => part.trim()).filter(Boolean);
  try {
    await select.selectOption(values.map((label) => ({ label })));
  } catch {
    await select.selectOption(values);
  }
}

async function read(element: Locator, kind: string, name = ''): Promise<string> {
  if (kind === 'count') return String(await element.count());
  if (kind === 'exists') return String((await element.count()) > 0);
  const first = element.first();
  if (kind === 'value') return await first.inputValue();
  if (kind === 'attribute') return (await first.getAttribute(name)) ?? '';
  if (kind === 'has-class') return String(((await first.getAttribute('class')) ?? '').split(/\\s+/).includes(name));
  if (kind === 'visible') return String(await first.isVisible());
  if (kind === 'checked') return String(await first.isChecked());
  if (kind === 'enabled') return String(await first.isEnabled());
  return ((await first.textContent()) ?? '').replace(/\\s+/g, ' ').trim();
}

async function extractList(items: Locator, fields: { name: string; locator?: string; attribute?: string }[]) {
  const rows: Record<string, string>[] = [];
  for (const item of await items.all()) {
    if (fields.length === 0) {
      rows.push({ text: ((await item.textContent()) ?? '').replace(/\\s+/g, ' ').trim() });
      continue;
    }
    const row: Record<string, string> = {};
    for (const field of fields) {
      const target = field.locator ? item.locator(field.locator).first() : item;
      row[field.name] = field.attribute ? ((await target.getAttribute(field.attribute)) ?? '') : ((await target.textContent()) ?? '').replace(/\\s+/g, ' ').trim();
    }
    rows.push(row);
  }
  return rows;
}

async function extractTable(table: Locator) {
  return table.evaluate((element: any) => {
    const rows = Array.from(element.querySelectorAll('tr')) as any[];
    const header = rows.find((row) => row.querySelector('th')) ?? rows[0];
    const keys = Array.from(header?.cells ?? []).map((cell: any) => cell.textContent.trim());
    return rows.filter((row) => row !== header).map((row) => Object.fromEntries(keys.map((key, index) => [key, (row.cells[index]?.textContent ?? '').trim()])));
  });
}

function parseRows(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  const [head, ...lines] = trimmed.split(/\\r?\\n/).map((line) => line.split(','));
  return lines.map((cells) => Object.fromEntries((head ?? []).map((key, index) => [key.trim(), (cells[index] ?? '').trim()])));
}

/** BlockFlow URL patterns: /regex/, globs with *, or "contains". */
function urlPattern(pattern: string): RegExp | string | ((url: URL) => boolean) {
  const regex = /^\\/(.+)\\/([dgimsuyv]*)$/.exec(pattern);
  if (regex) return new RegExp(regex[1] as string, regex[2]);
  if (pattern.includes('*')) return pattern;
  return (url: URL) => url.href.includes(pattern);
}

function compare(left: string, operator: string, right: string): boolean {
  const number = (text: string) => Number(String(text).replace(/[,\\s]/g, '').replace(/^[^\\d+\\-.]+/, '').replace(/[^\\d.]+$/, ''));
  const a = String(left ?? '');
  const b = String(right ?? '');
  switch (operator) {
    case 'equals': return a === b;
    case 'not-equals': return a !== b;
    case 'contains': return a.includes(b);
    case 'not-contains': return !a.includes(b);
    case 'starts-with': return a.startsWith(b);
    case 'ends-with': return a.endsWith(b);
    case 'matches': { const m = /^\\/(.*)\\/([dgimsuyv]*)$/s.exec(b); return (m ? new RegExp(m[1] as string, m[2]) : new RegExp(b)).test(a); }
    case 'greater': return number(a) > number(b);
    case 'greater-equal': return number(a) >= number(b);
    case 'less': return number(a) < number(b);
    case 'less-equal': return number(a) <= number(b);
    case 'empty': return a.trim() === '';
    case 'not-empty': return a.trim() !== '';
    case 'true': return /^(true|yes|on|1)$/i.test(a.trim());
    case 'false': return !/^(true|yes|on|1)$/i.test(a.trim());
    default: throw new Error(\`Unknown condition \${operator}\`);
  }
}
`;

export function workflowToPlaywright(workflow: Workflow, options: ExportOptions): string {
  const calls = new Set<string>();
  const main = bodyOf(workflow, options, calls);
  // Called workflows become functions (each written once, also when called from called ones).
  const functions: string[] = [];
  const written = new Set<string>();
  while (calls.size > written.size) {
    for (const id of [...calls]) {
      if (written.has(id)) continue;
      written.add(id);
      const called = options.lookup?.(id);
      if (!called) continue;
      const inner = bodyOf(called, options, calls);
      functions.push(
        `/** BlockFlow workflow "${called.name.replace(/\*\//g, '* /')}". */\nasync function ${functionName(called)}(tabs: Record<string, Page>, data: any, context: BrowserContext, request: APIRequestContext): Promise<any> {\n${inner}\n  return data;\n}`,
      );
    }
  }
  const everything = JSON.stringify([workflow, ...[...written].map((id) => options.lookup?.(id))]);
  const secrets = [...new Set([...everything.matchAll(/\{\{\s*secret\.(\w+)\s*\}\}/g)].map((match) => (match[1] as string).toUpperCase()))];
  return `// Exported from BlockFlow: "${workflow.name.replace(/\n/g, ' ')}".
// Run with: npx playwright test${secrets.length ? `\n// Secrets come from environment variables: ${secrets.join(', ')}` : ''}
import { expect, test } from '@playwright/test';
import type { APIRequestContext, BrowserContext, Locator, Page } from '@playwright/test';

test(${js(workflow.name)}, async ({ context, request }) => {
  const tabs: Record<string, Page> = {};
  let data: any = {};
${main}
});
${functions.length ? `\n${functions.join('\n\n')}\n` : ''}${HELPERS}`;
}
