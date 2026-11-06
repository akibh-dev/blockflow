import { clickOptions } from './blocks/click';
import { modifiersOf, parsePosition } from './blocks/pageCommon';
import { parseLocatorSteps } from './locatorSyntax';
import type { ClickConfig } from './blocks/click';
import { runtimeSource } from './playwrightRuntime';
import { edgePort, nodePorts } from './ports';
import type { BlockRegistry } from './registry';
import type { NodeDef, Workflow } from './types';

/**
 * Export a workflow as a Playwright test (`.spec.ts`), so a flow built in the browser can run in CI.
 * Page blocks map almost 1:1 because BlockFlow's locators follow Playwright's. Data blocks (Transform,
 * Filter, Data Table, For Each…) and templates run through BlockFlow's own expression/template code,
 * inlined into the spec (playwrightRuntime.ts). Triggers become comments; blocks with no Playwright
 * equivalent (notifications, datasets) become `// BlockFlow-only:` comments.
 */

export interface ExportOptions {
  registry: BlockRegistry;
  /** Other saved workflows, so Run Workflow blocks become functions. */
  lookup?(id: string): Workflow | undefined;
}

/** A value as a JS string literal. */
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

/** True when the text has a `{{…}}` token (the same token shape as template.ts). */
const hasToken = (text: string) => /\{\{\s*[^{}]+?\s*\}\}/.test(text);

/**
 * A templated setting as code: a plain string literal, or `render("…{{x}}…", scope)`, which runs
 * BlockFlow's own template renderer (inlined in the spec), so `{{$json.x}}`, `{{my-key}}`,
 * expressions and `{{secret.name}}` all render as in the extension.
 */
function template(text: unknown, scope = 'data'): string {
  const source = String(text ?? '');
  return hasToken(source) ? `render(${js(source)}, ${scope})` : js(source);
}

/** The generated expression for the block's tab (`tabs["main"]`). */
function tab(config: Record<string, unknown>): string {
  return `tabs[${js(config.tab || 'main')}]`;
}

/** Locator code with `.first()`, unless it already picks one (BlockFlow reads use the first match). */
const firstOf = (code: string) => (/\.(first|last|nth)\([^()]*\)$/.test(code) ? code : `${code}.first()`);

/** A JS comment line's text, so a label or message cannot end the comment early. */
const commentText = (text: unknown) => String(text ?? '').replace(/\*\//g, '* /').replace(/\s*\n\s*/g, ' ');

/** Blocks that write their own continuation (branches, loops, Stop); step settings do not wrap them. */
const CONTROL = new Set(['if', 'for-each', 'repeat', 'paginate', 'stop']);

/** Builds the test body: walks the graph from each root and writes one statement (or block) per node. */
class Writer {
  private lines: string[] = [];
  private depth = 1;
  private flags = 0;
  /** The step timeout of the node being written, in ms (undefined = Playwright's default). */
  private timeoutMs: number | undefined;

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

  /** `{ a, b, timeout: N }` for an options argument, or '' when there is nothing to pass. */
  private opt(parts: string[] = []): string {
    const all = [...parts, ...(this.timeoutMs !== undefined ? [`timeout: ${this.timeoutMs}`] : [])];
    return all.length ? `{ ${all.join(', ')} }` : '';
  }

  /** Like `opt`, as a trailing argument: `, { … }` or ''. */
  private optArg(parts: string[] = []): string {
    const options = this.opt(parts);
    return options ? `, ${options}` : '';
  }

  private targets(node: NodeDef, port: string): NodeDef[] {
    const def = this.options.registry.get(node.type);
    const ports = nodePorts(def, node);
    return this.workflow.edges
      .filter((edge) => edge.source === node.id && edgePort(edge, ports) === port)
      .map((edge) => this.workflow.nodes.find((candidate) => candidate.id === edge.target))
      .filter((candidate): candidate is NodeDef => Boolean(candidate));
  }

  /** True when something is connected to the node's input (a Timer is then a delay, not a trigger). */
  private fed(node: NodeDef): boolean {
    return this.workflow.edges.some((edge) => edge.target === node.id);
  }

  /**
   * Writes `node`, then everything after it. `seen` stops loops. The engine's step settings map to
   * code around the step's own statements: retries → `retry(n, …)`, onError "continue" → try/catch
   * that logs, onError "port" → try/catch that runs the error branch, timeoutSeconds → `{ timeout }`.
   */
  walk(node: NodeDef, seen: Set<string>): void {
    const label = this.options.registry.get(node.type)?.label ?? node.type;
    if (seen.has(node.id)) {
      this.line(`// (loop back to "${commentText(label)}" not exported)`);
      return;
    }
    const nextSeen = new Set(seen).add(node.id);
    const ports = nodePorts(this.options.registry.get(node.type), node);
    const continueWith = (port = ports[0] ?? 'out') => {
      for (const next of this.targets(node, port)) this.walk(next, nextSeen);
    };
    const c = node.config;
    const step = node.step ?? {};
    if (step.disabled) {
      this.line(`// (disabled) ${commentText(label)}`);
      continueWith();
      return;
    }
    const seconds = Number(step.timeoutSeconds);
    this.timeoutMs = seconds > 0 ? Math.round(seconds * 1000) : undefined;
    const loc = (key = 'locator') => toPlaywrightLocator(String(c[key] ?? ''), tab(c));

    if (CONTROL.has(node.type)) {
      this.control(node, c, continueWith);
      return;
    }
    const retries = Math.min(5, Math.max(0, Math.floor(Number(step.retries) || 0)));
    const own = () => {
      if (retries > 0) this.block(`await retry(${retries}, async () => {`, () => this.statement(node, label, c, loc), '});');
      else this.statement(node, label, c, loc);
    };
    if (step.onError === 'continue') {
      this.block('try {', own);
      this.block('catch (error) {', () => this.line(`console.warn(${js(`${label}: `)} + errorText(error) + ' (continuing)');`));
      continueWith();
    } else if (step.onError === 'port' && this.targets(node, 'error').length > 0) {
      this.flags += 1;
      const ok = `ok${this.flags}`;
      this.line(`let ${ok} = true;`);
      this.block('try {', own);
      this.block('catch (error) {', () => {
        this.line(`${ok} = false;`);
        this.line(`data = { ...data, error: errorText(error), errorBlock: ${js(label)} };`);
        for (const next of this.targets(node, 'error')) this.walk(next, nextSeen);
      });
      if (this.targets(node, ports[0] ?? 'out').length > 0) this.block(`if (${ok}) {`, () => continueWith());
    } else {
      own();
      continueWith();
    }
  }

  /** Branches, loops and Stop: they write their own continuation. */
  private control(node: NodeDef, c: Record<string, unknown>, continueWith: (port?: string) => void): void {
    switch (node.type) {
      case 'if':
        this.block(`if (compare(${template(c.left)}, ${js(c.operator)}, ${template(c.right)})) {`, () => continueWith('true'));
        if (this.targets(node, 'false').length > 0) this.block('else {', () => continueWith('false'));
        return;
      case 'for-each':
        this.block('{', () => {
          this.line('const input = data;');
          this.line(`const items = listAt(${js(c.list || 'items')}, input);`);
          this.block('for (const [index, item] of items.entries()) {', () => {
            this.line(`data = { ...input, ${js(String(c.as || '').trim() || 'item')}: item, index, total: items.length };`);
            continueWith('each');
          });
          this.line('data = { ...input, count: items.length };');
        });
        continueWith('done');
        return;
      case 'repeat':
        this.block('{', () => {
          this.line('const input = data;');
          this.block(`for (let iteration = 1; iteration <= ${Number(c.times) || 1}; iteration += 1) {`, () => {
            this.line('data = { ...input, iteration };');
            continueWith('each');
          });
          this.line('data = input;');
        });
        continueWith('done');
        return;
      case 'paginate':
        this.block('{', () => {
          this.line('const input = data;');
          this.line('let pageNumber = 1;');
          this.block(`for (; pageNumber <= ${Number(c.maxPages) || 10}; pageNumber += 1) {`, () => {
            this.line('data = { ...input, page: pageNumber };');
            continueWith('each');
            this.line(`const next = ${toPlaywrightLocator(String(c.locator), tab(c))}.first();`);
            this.line('if (!(await next.isVisible()) || !(await next.isEnabled())) break;');
            this.line('await next.click();');
            this.line(`await ${tab(c)}.waitForLoadState('networkidle');`);
          });
          this.line('data = { ...input, pages: Math.min(pageNumber, ' + (Number(c.maxPages) || 10) + ') };');
        });
        continueWith('done');
        return;
      case 'stop':
        this.line(c.outcome === 'fail' ? `throw new Error(${template(c.message || 'Stopped as failed')});` : 'return;');
        return;
    }
  }

  /** The step's own statements (no continuation). */
  private statement(node: NodeDef, label: string, c: Record<string, unknown>, loc: (key?: string) => string): void {
    switch (node.type) {
      case 'open-url': {
        const where = c.newTab === false && (c.where ?? 'new') === 'new' ? 'current' : String(c.where ?? 'new');
        const name = tab(c);
        // The test's own `page` stands for "the tab you are on" and the workflow's own tab.
        this.line(`${name} = ${where === 'current' || where === 'workflow' ? 'page' : 'await newTab(context)'};`);
        const waitUntil = c.waitUntil === 'networkidle' ? "waitUntil: 'networkidle'" : c.waitUntil === 'none' ? "waitUntil: 'commit'" : '';
        this.line(`await ${name}.goto(${template(c.url)}${this.optArg(waitUntil ? [waitUntil] : [])});`);
        this.line(`data = { ...data, url: ${name}.url() };`);
        break;
      }
      case 'navigate':
        if (c.action === 'goto') this.line(`await ${tab(c)}.goto(${template(c.url)}${this.optArg()});`);
        else this.line(`await ${tab(c)}.${c.action === 'back' ? 'goBack' : c.action === 'forward' ? 'goForward' : 'reload'}(${this.opt()});`);
        break;
      case 'close-tab':
        this.line(`await ${tab(c)}.close();`);
        break;
      case 'click': {
        const action = c.action === 'double' ? 'dblclick' : c.action === 'hover' ? 'hover' : 'click';
        const mouse = clickOptions({ ...c, action: c.action === 'right' ? 'click' : (c.action as ClickConfig['action']), button: c.action === 'right' ? 'right' : (c.button as ClickConfig['button']) });
        const count = action === 'dblclick' ? 0 : (mouse.clickCount ?? 0);
        this.line(
          `await ${loc()}.${action}(${this.opt(
            [
              action !== 'hover' && mouse.button ? `button: '${mouse.button}'` : '',
              mouse.modifiers ? `modifiers: ${JSON.stringify(mouse.modifiers)}` : '',
              mouse.position ? `position: { x: ${mouse.position.x}, y: ${mouse.position.y} }` : '',
              count > 1 ? `clickCount: ${count}` : '',
              c.force ? 'force: true' : '',
            ].filter(Boolean),
          )});`,
        );
        break;
      }
      case 'element-action':
        switch (c.action) {
          case 'blur':
            this.line(`await ${loc()}.blur(${this.opt()});`);
            break;
          case 'clear':
            this.line(`await ${loc()}.clear(${this.opt()});`);
            break;
          case 'scroll-into-view':
            this.line(`await ${loc()}.scrollIntoViewIfNeeded(${this.opt()});`);
            break;
          case 'dispatch-event': {
            const detail = String(c.detail ?? '').trim() ? `JSON.parse(${template(c.detail)})` : 'undefined';
            this.line(`data = { ...data, defaultPrevented: await dispatchEvent(${loc()}, ${js(String(c.eventType ?? '').trim())}, ${detail}) };`);
            break;
          }
          default:
            this.line(`await ${loc()}.focus(${this.opt()});`);
        }
        break;
      case 'drag': {
        const from = parsePosition(c.fromPosition);
        const to = parsePosition(c.toPosition);
        this.line(
          `await ${loc('from')}.dragTo(${loc('to')}${this.optArg(
            [from ? `sourcePosition: { x: ${from.x}, y: ${from.y} }` : '', to ? `targetPosition: { x: ${to.x}, y: ${to.y} }` : ''].filter(Boolean),
          )});`,
        );
        if (modifiersOf(c.modifiers)) this.line('// BlockFlow: the drag held modifier keys; dragTo cannot, use page.keyboard.down/up around it.');
        this.line("data = { ...data, dragMode: 'pointer' };");
        break;
      }
      case 'fill':
        this.line(`await ${loc()}.${c.mode === 'type' ? 'pressSequentially' : 'fill'}(${template(c.value)}${this.optArg()});`);
        break;
      case 'fill-form':
        for (const row of (c.fields as Record<string, string>[] | undefined) ?? []) {
          if (!row.locator || !row.value) continue;
          this.line(`await setField(${toPlaywrightLocator(row.locator, tab(c))}, ${template(row.value)});`);
        }
        if (c.submit) this.line(`await ${loc('submit')}.click(${this.opt()});`);
        break;
      case 'select-option':
        this.line(`await selectByText(${loc()}, ${template(c.value)});`);
        break;
      case 'check':
        this.line(`await ${loc()}.setChecked(${c.state !== 'uncheck'}${this.optArg()});`);
        break;
      case 'press-key':
        this.line(c.locator ? `await ${loc()}.press(${js(c.key)}${this.optArg()});` : `await ${tab(c)}.keyboard.press(${js(c.key)});`);
        break;
      case 'scroll':
        this.line(c.to === 'element' ? `await ${loc()}.scrollIntoViewIfNeeded(${this.opt()});` : `await ${tab(c)}.mouse.wheel(0, ${c.to === 'top' ? -100000 : 100000});`);
        break;
      case 'wait-for':
        this.waitFor(c, loc);
        break;
      case 'read-element':
        if (c.url) {
          this.line(`{ const reader = await newTab(context); await reader.goto(${template(c.url)}); data = { ...data, value: await read(${toPlaywrightLocator(String(c.locator), 'reader')}, ${js(c.read)}, ${js(c.name)}) }; await reader.close(); }`);
        } else this.line(`data = { ...data, value: await read(${toPlaywrightLocator(String(c.locator), tab(c))}, ${js(c.read)}, ${js(c.name)}) };`);
        break;
      case 'assert':
        this.assert(c, loc);
        break;
      case 'extract-list':
        if (c.source === 'html') {
          this.line(`// BlockFlow-only: Extract List from HTML in the data (use a page instead).`);
          break;
        }
        this.line(`data = { ...data, ${js(c.into || 'items')}: await extractList(${loc()}, ${JSON.stringify(((c.fields as Record<string, string>[]) ?? []).filter((f) => f.name))}) };`);
        break;
      case 'extract-table':
        this.line(`data = { ...data, ${js(c.into || 'rows')}: await extractTable(${loc()}) };`);
        break;
      case 'page-info':
        this.line(`data = { ...data, page: { url: ${tab(c)}.url(), title: await ${tab(c)}.title() } };`);
        break;
      case 'page-snapshot':
        // Playwright's ARIA snapshot is the same idea (an outline of roles and names), without locators.
        this.line(`data = { ...data, snapshot: await ${String(c.locator ?? '').trim() ? loc() : `${tab(c)}.locator('body')`}.ariaSnapshot() };`);
        break;
      case 'set-variable':
        this.line(`data = { ...data, ${js(String(c.name ?? '').trim())}: ${template(c.value)} };`);
        break;
      case 'data-table': {
        const into = js(String(c.into ?? '').trim() || 'rows');
        this.line(`{ const rows = parseRows(${js(c.text)}); data = { ...data, ${into}: rows, count: rows.length }; }`);
        break;
      }
      case 'transform':
        for (const row of (c.values as Record<string, string>[] | undefined) ?? []) {
          const name = String(row.name ?? '').trim();
          if (name) this.line(`data = { ...data, ${js(name)}: evaluate(${js(row.expression ?? '')}, data, ${js(name)}) };`);
        }
        break;
      case 'filter': {
        const key = String(c.into ?? '').trim() || String(c.list ?? '').trim();
        this.block('{', () => {
          this.line(`const items = listAt(${js(c.list || 'items')}, data);`);
          this.line(`const kept = items.filter((item) => compare(${template(c.left, '{ ...data, item }')}, ${js(c.operator)}, ${template(c.right, '{ ...data, item }')}));`);
          this.line(`data = { ...data, ${js(key)}: kept, count: kept.length };`);
        });
        break;
      }
      case 'log':
        this.line(`console.log(${template(c.message)});`);
        break;
      case 'manual-step':
        this.line(`await ${tab(c)}.pause(); // ${commentText(c.message)}`);
        break;
      case 'http-request':
        this.line(`{ const response = await request.fetch(${template(c.url)}, { method: ${js(c.method || 'GET')}${c.body ? `, data: ${template(c.body)}` : ''}${this.timeoutMs !== undefined ? `, timeout: ${this.timeoutMs}` : ''} });`);
        if (c.responseType === 'base64') {
          this.line("  data = { ...data, status: response.status(), ok: response.ok(), body: '', body64: (await response.body()).toString('base64'), mime: (response.headers()['content-type'] ?? '').split(';')[0]!.trim() }; }");
        } else this.line('  data = { ...data, status: response.status(), ok: response.ok(), body: await response.text() }; try { data.data = JSON.parse(data.body); } catch {} }');
        break;
      case 'run-workflow': {
        const called = this.options.lookup?.(String(c.workflow));
        if (!called) {
          this.line(`// BlockFlow-only: Run Workflow (the called workflow was not found when exporting)`);
          break;
        }
        this.calls.add(called.id);
        this.line(`data = await ${functionName(called)}(tabs, data, page, context, request);`);
        break;
      }
      case 'start':
        for (const row of (c.inputs as Record<string, string>[] | undefined) ?? []) {
          if (row.name) this.line(`data[${js(row.name)}] ??= ${template(row.value)};`);
        }
        break;
      case 'dialogs':
        // One listener per page answers with the latest choice, like the extension's "from now on".
        this.line(`data = { ...data, ...answerDialogs(${tab(c)}, ${js(c.action || 'accept')}, ${template(c.text)}) };`);
        break;
      case 'upload-file': {
        const file =
          c.source === 'url'
            ? `await fileFromUrl(request, ${template(c.url)}, ${template(c.filename)})`
            : c.source === 'data'
              ? `fileFromData(${template(c.data)}, ${template(String(c.filename ?? '').trim() || 'upload.bin')}, ${template(String(c.mime ?? '').trim() || 'application/octet-stream')})`
              : `{ name: ${template(String(c.filename ?? '').trim() || 'upload.txt')}, mimeType: ${template(String(c.mime ?? '').trim() || 'text/plain')}, buffer: Buffer.from(${template(c.content)}) }`;
        const put = c.target === 'dropzone' ? `await dropFiles(${loc()}, file)` : `await ${loc()}.setInputFiles(file${this.optArg()})`;
        this.line(`{ const file = ${file}; ${put}; data = { ...data, uploaded: file.name }; }`);
        break;
      }
      case 'wait-for-popup': {
        const name = `tabs[${js(String(c.name ?? '').trim() || 'popup')}]`;
        this.line(`${name} = await waitForPopup(context, ${js(c.waitUntil || 'load')}${this.timeoutMs !== undefined ? `, ${this.timeoutMs}` : ''});`);
        this.line(`data = { ...data, popupUrl: ${name}.url() };`);
        break;
      }
      case 'run-script': {
        const into = js(String(c.into ?? '').trim() || 'result');
        this.line(`data = { ...data, ${into}: (await ${tab(c)}.evaluate(async (data: any) => {`);
        this.depth += 1;
        for (const codeLine of String(c.code ?? '').split('\n')) this.line(codeLine);
        this.depth -= 1;
        this.line('}, data)) ?? null };');
        break;
      }
      case 'timer':
        if (this.fed(node)) {
          // After another block a Timer is a delay.
          this.line(`await page.waitForTimeout(${Math.max(0, Number(c.seconds) || 0) * 1000});`);
          this.line('data = { ...data, firedAt: new Date().toISOString() };');
        } else this.line(`// ${label}: a BlockFlow trigger; the test starts here instead.`);
        break;
      case 'schedule':
      case 'page-visited':
      case 'context-menu':
      case 'watch-element':
        this.line(`// ${label}: a BlockFlow trigger; the test starts here instead.`);
        break;
      default:
        this.line(`// BlockFlow-only: ${commentText(label)} has no Playwright equivalent, skipped.`);
    }
  }

  private waitFor(c: Record<string, unknown>, loc: (key?: string) => string): void {
    const states: Record<string, string> = { visible: 'toBeVisible', hidden: 'toBeHidden', attached: 'toBeAttached', enabled: 'toBeEnabled' };
    const mode = String(c.mode ?? 'visible');
    if (states[mode]) {
      this.line(`await expect(${loc()}).${states[mode]}(${this.opt()});`);
      return;
    }
    switch (mode) {
      case 'detached':
        this.line(`await expect(${loc()}).toHaveCount(0${this.optArg()});`);
        break;
      case 'text':
      case 'no-text': {
        const scope = c.locator ? loc() : `${tab(c)}.locator('body')`;
        this.line(`await expect(${scope}).${mode === 'text' ? '' : 'not.'}toContainText(textOrRegex(${template(c.text)})${this.optArg()});`);
        break;
      }
      case 'url':
        this.line(`await ${tab(c)}.waitForURL(urlPattern(${template(c.url)})${this.optArg()});`);
        break;
      case 'response':
        this.line(`data = { ...data, response: await waitForResponse(${tab(c)}, ${template(c.url)}, ${js(c.status)}${this.timeoutMs !== undefined ? `, ${this.timeoutMs}` : ''}) };`);
        break;
      default:
        this.line(`await ${tab(c)}.waitForLoadState(${js(mode === 'networkidle' ? 'networkidle' : 'load')}${this.optArg()});`);
    }
    if (mode !== 'response') this.line(`data = { ...data, url: ${tab(c)}.url() };`);
  }

  /**
   * Assert retries like BlockFlow's: web-first matchers where Playwright has one (toHaveText,
   * toHaveURL, toHaveValue…), `expect.poll` around BlockFlow's own comparison for the rest.
   * Checks on a data value are answered at once (as in the extension).
   */
  private assert(c: Record<string, unknown>, loc: (key?: string) => string): void {
    const soft = Boolean(c.soft);
    const expectFn = soft ? 'expect.soft' : 'expect';
    const message = c.message ? template(c.message) : '';
    const subject = String(c.subject || 'text');
    const operator = String(c.operator || 'contains');
    const expected = template(c.expected);
    const states: Record<string, string> = {
      visible: 'toBeVisible',
      hidden: 'toBeHidden',
      checked: 'toBeChecked',
      unchecked: 'not.toBeChecked',
      enabled: 'toBeEnabled',
      disabled: 'toBeDisabled',
    };
    const element = () => firstOf(loc());
    const direct = (target: string, matcher: string, args: string) =>
      this.line(`await ${expectFn}(${target}${message ? `, ${message}` : ''}).${matcher}(${args}${args ? this.optArg() : this.opt()});`);
    if (states[subject]) {
      direct(element(), states[subject] as string, '');
      return;
    }
    if (subject === 'value') {
      const actual = template(c.value);
      if (operator === 'equals') this.line(`${expectFn}(${actual}${message ? `, ${message}` : ''}).toBe(${expected});`);
      else this.line(`${expectFn}(compare(${actual}, ${js(operator)}, ${expected})${message ? `, ${message}` : ''}).toBe(true);`);
      return;
    }
    // Matchers by subject: [equals, not-equals, matches] (+ contains for text).
    const page = tab(c);
    const matchers: Record<string, { target: () => string; matcher: string; contains?: string; arg?: (value: string) => string }> = {
      text: { target: element, matcher: 'toHaveText', contains: 'toContainText' },
      input: { target: element, matcher: 'toHaveValue' },
      attribute: { target: element, matcher: 'toHaveAttribute', arg: (value) => `${js(c.name)}, ${value}` },
      count: { target: () => loc(), matcher: 'toHaveCount', arg: (value) => `Number(${value})` },
      url: { target: () => page, matcher: 'toHaveURL' },
      title: { target: () => page, matcher: 'toHaveTitle' },
    };
    const found = matchers[subject];
    if (found) {
      const arg = found.arg ?? ((value: string) => value);
      if (operator === 'equals') return direct(found.target(), found.matcher, arg(expected));
      if (operator === 'not-equals') return direct(found.target(), `not.${found.matcher}`, arg(expected));
      if (operator === 'matches' && subject !== 'count') return direct(found.target(), found.matcher, arg(`regexOf(${expected})`));
      if (found.contains && operator === 'contains') return direct(found.target(), found.contains, expected);
      if (found.contains && operator === 'not-contains') return direct(found.target(), `not.${found.contains}`, expected);
    }
    // Everything else: poll BlockFlow's own comparison until it holds (or the timeout).
    const actual =
      subject === 'url'
        ? `${page}.url()`
        : subject === 'title'
          ? `await ${page}.title()`
          : `await peek(${loc()}, ${js(subject === 'input' ? 'value' : subject)}, ${js(c.name)})`;
    const pollOptions = this.opt(message ? [`message: ${message}`] : []);
    const poll = soft ? 'expect.configure({ soft: true }).poll' : 'expect.poll';
    this.line(`await ${poll}(async () => compare(${actual}, ${js(operator)}, ${expected})${pollOptions ? `, ${pollOptions}` : ''}).toBe(true);`);
  }
}

/** A camelCase function name for a called workflow, made unique with part of its id. */
function functionName(workflow: Workflow): string {
  const words = workflow.name.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const base = words.map((word, index) => (index === 0 ? word.toLowerCase() : word[0]?.toUpperCase() + word.slice(1).toLowerCase())).join('') || 'workflow';
  return `${/^\d/.test(base) ? '_' : ''}${base}_${workflow.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 6)}`;
}

/** The statements of one workflow; Run Workflow targets are added to `calls`. */
function bodyOf(workflow: Workflow, options: ExportOptions, calls: Set<string>): string {
  const writer = new Writer(workflow, options, calls);
  const fed = new Set(workflow.edges.map((edge) => edge.target));
  const roots = workflow.nodes.filter((node) => !fed.has(node.id));
  for (const root of roots) writer.walk(root, new Set());
  return writer.out();
}

/** Helper functions appended to every exported test (mirror BlockFlow's own semantics). */
const HELPERS = `
// --- helpers (exported by BlockFlow) ---------------------------------------

/** Renders a BlockFlow template ("Hi {{name}}", "{{ price * 1.1 }}", "{{secret.token}}") like the extension. */
function render(text: string, data: any): string {
  return templateModule.render(text, { ...data, secret: SECRETS });
}

/** Reads a path like "items[0].title" (or "$json.title") from the data. */
function get(data: any, path: string): any {
  return templateModule.getPath(data, path);
}

/** The value of a BlockFlow expression (Transform, For Each, Filter lists). */
function evaluate(expression: string, data: any, label = 'Expression'): any {
  try {
    return expressionModule.evaluate(expression, data);
  } catch (error) {
    throw new Error(\`\${label}: \${errorText(error)}\`);
  }
}

/** Like evaluate, but the value must be a list. */
function listAt(expression: string, data: any): any[] {
  const value = evaluate(expression, data, 'List');
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) throw new Error(\`List: "\${expression}" is not in the data\`);
  throw new Error(\`List: "\${expression}" is not a list (it is \${typeof value})\`);
}

/** BlockFlow's conditions (If, Filter, Assert): equals, contains, greater, matches, empty… */
function compare(left: string | null, operator: string, right: string): boolean {
  if (left === null || left === undefined) return false;
  return conditionModule.testClause({ left: String(left), operator, right: String(right ?? '') });
}

/** Data Table text: a JSON list, or CSV with a header row (comma, semicolon or tab; quotes work). */
function parseRows(text: string): any[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  return csvModule.csvToObjects(trimmed);
}

/** BlockFlow URL patterns: /regex/, globs with * and **, or "contains". */
function urlPattern(pattern: string): (url: URL) => boolean {
  return (url: URL) => urlPatternModule.urlMatches(url.href, pattern);
}

/** "/re/i" or "re" as a RegExp (the "matches" condition). */
function regexOf(pattern: string): RegExp {
  const literal = /^\\/(.*)\\/([dgimsuyv]*)$/s.exec(pattern);
  return literal ? new RegExp(literal[1] as string, literal[2]) : new RegExp(pattern);
}

/** Wait For text: "/re/i" is a pattern, anything else plain text. */
function textOrRegex(text: string): string | RegExp {
  return /^\\/.+\\/[dgimsuyv]*$/s.test(text) ? regexOf(text) : text;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A step's retries: tries again after 1 s, 2 s, 4 s… (at most 10 s), like the extension. */
async function retry<T>(retries: number, action: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (attempt > retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), 10_000)));
    }
  }
}

/** What happened in the browser so far: new pages (popups), responses (Wait For response), dialogs. */
const seen = { pages: [] as { page: Page; at: number }[], responses: [] as { response: Response; at: number }[], ours: new WeakSet<Page>() };
const dialogAnswers = new WeakMap<Page, { action: string; text: string; shown: { type: string; message: string }[] }>();

/** Starts recording; called first thing in the test. */
function watch(context: BrowserContext, page: Page) {
  seen.ours.add(page);
  trackDialogs(page);
  context.on('page', (opened) => {
    seen.pages.push({ page: opened, at: Date.now() });
    trackDialogs(opened);
  });
  context.on('response', (response) => {
    seen.responses.push({ response, at: Date.now() });
    if (seen.responses.length > 500) seen.responses.shift();
  });
}

/** A tab the test opens itself (so Wait for Popup does not mistake it for a popup). */
async function newTab(context: BrowserContext): Promise<Page> {
  const opened = await context.newPage();
  seen.ours.add(opened);
  return opened;
}

/** Wait for Popup: a page the site opened in the last 15 s, or the next one. */
async function waitForPopup(context: BrowserContext, waitUntil: string, timeout?: number): Promise<Page> {
  const since = Date.now() - 15_000;
  const isPopup = (candidate: Page) => !seen.ours.has(candidate);
  const popup = seen.pages.find(({ page, at }) => at >= since && isPopup(page))?.page ?? (await context.waitForEvent('page', { predicate: isPopup, ...(timeout ? { timeout } : {}) }));
  seen.ours.add(popup);
  if (waitUntil !== 'none') await popup.waitForLoadState(waitUntil === 'networkidle' ? 'networkidle' : 'load', timeout ? { timeout } : {});
  return popup;
}

/** "200", "2xx", "200,201", or "" for any. */
function statusFits(status: number, wanted: string): boolean {
  const options = wanted.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (options.length === 0) return true;
  return options.some((option) => (/^\\dxx$/.test(option) ? Math.floor(status / 100) === Number(option[0]) : Number(option) === status));
}

/** Wait For "a network request finishes": a matching response of this tab in the last 10 s, or the next one. */
async function waitForResponse(tab: Page, pattern: string, status = '', timeout?: number) {
  const fits = (response: Response) => {
    if (!statusFits(response.status(), status) || !urlPatternModule.urlMatches(response.url(), pattern)) return false;
    try {
      return response.frame().page() === tab;
    } catch {
      return false;
    }
  };
  const since = Date.now() - 10_000;
  const response = seen.responses.find(({ response, at }) => at >= since && fits(response))?.response ?? (await tab.waitForResponse(fits, timeout ? { timeout } : {}));
  await response.finished();
  return { url: response.url(), status: response.status(), method: response.request().method() };
}

/** Records a page's dialogs and answers them with its latest Dialogs choice (dismiss until one). */
function trackDialogs(tab: Page) {
  if (dialogAnswers.has(tab)) return;
  const state = { action: 'dismiss', text: '', shown: [] as { type: string; message: string }[] };
  dialogAnswers.set(tab, state);
  tab.on('dialog', async (dialog) => {
    state.shown.push({ type: dialog.type(), message: dialog.message() });
    if (state.action === 'accept') await dialog.accept(state.text);
    else await dialog.dismiss();
  });
}

/** Dialogs block: "accept" / "dismiss" from now on, or "read" what was shown. */
function answerDialogs(tab: Page, action: string, text = '') {
  trackDialogs(tab);
  const state = dialogAnswers.get(tab)!;
  if (action !== 'read') Object.assign(state, { action, text });
  return { dialogs: [...state.shown], lastDialog: state.shown.at(-1)?.message ?? '' };
}

/** Upload File from a URL: downloads it with the test's request context. */
async function fileFromUrl(request: APIRequestContext, url: string, name: string) {
  const response = await request.get(url);
  if (!response.ok()) throw new Error(\`Download failed (\${response.status()}): \${url}\`);
  const fallback = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download');
  const mimeType = (response.headers()['content-type'] ?? 'application/octet-stream').split(';')[0]!.trim();
  return { name: name.trim() || fallback, mimeType, buffer: await response.body() };
}

/** Upload File from base64 data (or a data: URL), as BlockFlow's source "data". */
function fileFromData(text: string, name: string, mimeType: string) {
  const dataUrl = /^data:([^;,]*)((?:;[^;,]*)*),/i.exec(text.trim());
  if (dataUrl && !/;base64/i.test(dataUrl[2] ?? '')) {
    return { name, mimeType: dataUrl[1] || 'text/plain', buffer: Buffer.from(decodeURIComponent(text.trim().slice(dataUrl[0].length))) };
  }
  const base64 = dataUrl ? text.trim().slice(dataUrl[0].length) : text;
  return { name, mimeType: dataUrl?.[1] || mimeType, buffer: Buffer.from(base64.replace(/\\s+/g, ''), 'base64') };
}

/** Upload File with target "dropzone": dragenter, dragover and drop with a DataTransfer carrying the file. */
async function dropFiles(zone: Locator, file: { name: string; mimeType: string; buffer: Buffer }) {
  await zone.evaluate(
    (element: any, [name, type, base64]: string[]) => {
      const binary = atob(base64!);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], name!, { type }));
      for (const type of ['dragenter', 'dragover', 'drop']) {
        element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer }));
      }
    },
    [file.name, file.mimeType, file.buffer.toString('base64')],
  );
}

/** Element Action "dispatch an event": Playwright's dispatchEvent for built-in types, a CustomEvent (with detail) otherwise. */
async function dispatchEvent(target: Locator, type: string, detail?: unknown): Promise<boolean> {
  if (/^(click|dblclick|auxclick|contextmenu|mouse|pointer|key|focus|blur|drag|drop|wheel|input|beforeinput|touch)/.test(type)) {
    await target.dispatchEvent(type, detail && typeof detail === 'object' ? detail : {});
    return false;
  }
  return target.evaluate(
    (element: any, [type, detail]: any[]) => !element.dispatchEvent(new CustomEvent(type, { bubbles: true, cancelable: true, composed: true, detail: detail ?? null })),
    [type, detail],
  );
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

/** One look for Assert's polling: null while the element does not exist (yet). */
async function peek(element: Locator, kind: string, name = ''): Promise<string | null> {
  if (kind !== 'count' && (await element.count()) === 0) return null;
  return read(element, kind, name);
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
`;

/**
 * The full `.spec.ts` text: one `test()`, called workflows as functions, then the helpers and the
 * BlockFlow runtime (the real expression / template / condition / CSV / URL-pattern code).
 * Secrets become environment variables (`{{secret.api_key}}` = `process.env.API_KEY`).
 */
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
        `/** BlockFlow workflow "${commentText(called.name)}". */\nasync function ${functionName(called)}(tabs: Record<string, Page>, data: any, page: Page, context: BrowserContext, request: APIRequestContext): Promise<any> {\n${inner}\n  return data;\n}`,
      );
    }
  }
  const everything = JSON.stringify([workflow, ...[...written].map((id) => options.lookup?.(id))]);
  const secretNames = [...new Set([...everything.matchAll(/\{\{\s*secret\.([\w-]+)\s*\}\}/g)].map((match) => match[1] as string))];
  const envName = (name: string) => name.replace(/[^\w]/g, '_').toUpperCase();
  const secrets = secretNames.map((name) => `${js(name)}: process.env[${js(envName(name))}] ?? ''`);
  return `// Exported from BlockFlow: "${workflow.name.replace(/\n/g, ' ')}".
// Run with: npx playwright test${secretNames.length ? `\n// Secrets come from environment variables: ${secretNames.map(envName).join(', ')}` : ''}
import { expect, test } from '@playwright/test';
import type { APIRequestContext, BrowserContext, Locator, Page, Response } from '@playwright/test';

/** {{secret.name}} values. */
const SECRETS: Record<string, string> = {${secrets.length ? ` ${secrets.join(', ')} ` : ''}};

test(${js(workflow.name)}, async ({ page, context, request }) => {
  watch(context, page);
  const tabs: Record<string, Page> = {};
  let data: any = {};
${main}
});
${functions.length ? `\n${functions.join('\n\n')}\n` : ''}${HELPERS}
// --- BlockFlow runtime: generated from src/core (expression, condition, csv, urlPattern, template) ---

${runtimeSource()}
`;
}
