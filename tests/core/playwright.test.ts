import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../src/core/blocks';
import { parseCsv } from '../../src/core/csv';
import csvSource from '../../src/core/csv.ts?raw';
import { toPlaywrightLocator, workflowToPlaywright } from '../../src/core/playwright';
import { runtimeSource, wrapModule } from '../../src/core/playwrightRuntime';
import type { StepSettings } from '../../src/core/types';
import { flow } from '../helpers/fakeHost';

const registry = createDefaultRegistry();

describe('locators to Playwright', () => {
  it.each([
    ['#save', `page.locator("#save")`],
    ['my-app >>> button', `page.locator("my-app button")`],
    ['text=Sign in', `page.getByText("Sign in")`],
    ['text="Sign in"', `page.getByText("Sign in", { exact: true })`],
    ['text=/sign ?in/i', `page.getByText(/sign ?in/i)`],
    ['role=button[name="Save"]', `page.getByRole("button", { name: "Save" })`],
    ['role=button[name="Save"][exact]', `page.getByRole("button", { name: "Save", exact: true })`],
    ['role=heading[level=2]', `page.getByRole("heading", { level: 2 })`],
    ['role=checkbox[checked]', `page.getByRole("checkbox", { checked: true })`],
    ['label=Email', `page.getByLabel("Email")`],
    ['placeholder=you@x.co', `page.getByPlaceholder("you@x.co")`],
    ['testid=submit', `page.getByTestId("submit")`],
    ['xpath=//li[2]', `page.locator("xpath=//li[2]")`],
    ['#list >> text=Pro >> nth=1', `page.locator("#list").getByText("Pro").nth(1)`],
    ['li >> nth=-1', `page.locator("li").last()`],
    ['frame=#pay >> label=Card number', `page.frameLocator("#pay").getByLabel("Card number")`],
  ])('%s', (locator, code) => {
    expect(toPlaywrightLocator(locator, 'page')).toBe(code);
  });
});

describe('workflow to Playwright test', () => {
  it('writes a readable test with branches, errors, secrets and called workflows', () => {
    const login = flow([{ id: 'f', type: 'fill', config: { locator: 'label=Password', value: '{{secret.loginPassword}}' } }], []);
    login.name = 'Log in';
    const test = flow(
      [
        { id: 'o', type: 'open-url', config: { url: 'https://shop.test/{{path}}' } },
        { id: 'c', type: 'run-workflow', config: { workflow: login.id } },
        { id: 'w', type: 'wait-for', config: { mode: 'url', url: '/account' }, step: { onError: 'port' } },
        { id: 'a', type: 'assert', config: { subject: 'text', locator: 'h1', operator: 'contains', expected: 'Welcome' } },
        { id: 'n', type: 'notify', config: { title: 'x' } },
        { id: 'i', type: 'if', config: { left: '{{value}}', operator: 'greater', right: '3' } },
        { id: 's', type: 'stop', config: { outcome: 'fail', message: 'login broken' } },
      ],
      [['o', 'c'], ['c', 'w'], ['w', 'a'], ['w', 's', 'error'], ['a', 'i'], ['i', 'n', 'true']],
    );
    test.name = 'Checkout';
    const spec = workflowToPlaywright(test, { registry, lookup: (id) => (id === login.id ? login : undefined) });
    expect(spec).toContain(`test("Checkout", async ({ page, context, request }) => {`);
    expect(spec).toContain('await tabs["main"].goto(render("https://shop.test/{{path}}", data));');
    expect(spec).toMatch(/data = await logIn_\w+\(tabs, data, page, context, request\);/);
    expect(spec).toContain('await tabs["main"].getByLabel("Password").fill(render("{{secret.loginPassword}}", data));');
    expect(spec).toContain(`const SECRETS: Record<string, string> = { "loginPassword": process.env["LOGINPASSWORD"] ?? '' };`);
    expect(spec).toContain('// Secrets come from environment variables: LOGINPASSWORD');
    expect(spec).toContain('try {');
    expect(spec).toContain('throw new Error("login broken");');
    expect(spec).toContain('await expect(tabs["main"].locator("h1").first()).toContainText("Welcome");');
    expect(spec).toContain('if (compare(render("{{value}}", data), "greater", "3")) {');
    expect(spec).toContain('// BlockFlow-only: Notify has no Playwright equivalent, skipped.');
  });
});

type Node = { id: string; type: string; config?: Record<string, unknown>; step?: StepSettings };
type Edges = ([string, string] | [string, string, string])[];

/** The exported spec for blocks in a line (or with explicit edges). */
function exported(nodes: Node[], edges?: Edges): string {
  const lines = edges ?? nodes.slice(1).map((node, index): [string, string] => [(nodes[index] as Node).id, node.id]);
  return workflowToPlaywright(flow(nodes, lines), { registry });
}

/** Only the test body (after `let data`, up to the end of the test), with indentation removed. */
function body(nodes: Node[], edges?: Edges): string {
  const spec = exported(nodes, edges);
  const marker = '  let data: any = {};\n';
  const start = spec.indexOf(marker) + marker.length;
  return spec
    .slice(start, spec.indexOf('\n});\n', start))
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
}

/** TypeScript → JS, failing on syntax errors (types are not checked). */
function transpile(source: string): string {
  const result = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  expect(result.diagnostics?.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')) ?? []).toEqual([]);
  return result.outputText;
}

type Fn = (...args: any[]) => any;

/** The spec's helpers and the inlined runtime, run in this process (no Playwright needed). */
function loadRuntime(): Record<string, Fn> {
  const spec = exported([{ id: 'l', type: 'log', config: { message: 'x' } }]);
  const helpers = spec.slice(spec.indexOf('// --- helpers'));
  const code = transpile(`const SECRETS = { token: 's3cret' };\n${helpers}`);
  return new Function(`${code}\nreturn { render, get, evaluate, listAt, compare, parseRows, urlPattern, regexOf, textOrRegex, statusFits, retry };`)();
}

describe('the inlined BlockFlow runtime', () => {
  it('is the real source of the core modules, wrapped (cannot drift)', () => {
    const runtime = runtimeSource();
    const parser = (csvSource.slice(csvSource.indexOf('export function parseCsv')).split('\n/**')[0] as string).trim();
    expect(runtime).toContain(parser.replace(/^export /, ''));
    expect(runtime).toContain('const expressionModule = (() => {');
    expect(runtime).toContain('const { ExpressionError, evaluate, parseExpression, toText } = expressionModule;');
    expect(runtime).not.toMatch(/^import /m);
    expect(runtime).not.toMatch(/^export /m);
  });

  it('refuses a module import it cannot inline', () => {
    expect(() => wrapModule('x', "import { a } from './engine';\nexport const b = a;", [])).toThrow(/not inlined/);
    expect(wrapModule('x', "import type { Payload } from './types';\nexport function f() {}\nexport const g = 1;", [])).toBe(
      'const xModule = (() => {\nfunction f() {}\nconst g = 1;\n\nreturn { f, g };\n})();',
    );
  });

  it('renders templates like the extension: $json, dashed keys, expressions, secrets, missing values', () => {
    const { render } = loadRuntime() as { render: Fn };
    const data = { name: 'Ann', 'my-key': 'dash', items: [{ price: 2 }, { price: 3 }], nested: { a: 1 } };
    expect(render('{{$json.name}} / {{my-key}} / {{ sum(pluck(items, "price")) * 2 }} / {{nested}} / [{{missing}}] / {{secret.token}}', data)).toBe(
      'Ann / dash / 10 / {"a":1} / [] / s3cret',
    );
  });

  it('parses CSV with quotes, semicolons and tabs (csv.ts), and JSON', () => {
    const { parseRows } = loadRuntime() as { parseRows: Fn };
    expect(parseRows('name;note\n"Ann";"a ""quoted""; value"\nBob;plain')).toEqual([
      { name: 'Ann', note: 'a "quoted"; value' },
      { name: 'Bob', note: 'plain' },
    ]);
    expect(parseRows('a\tb\n1\t2')).toEqual([{ a: '1', b: '2' }]);
    expect(parseRows('a,b\n"x\ny",2')).toEqual([{ a: 'x\ny', b: '2' }]);
    expect(parseRows('{"a":1}')).toEqual([{ a: 1 }]);
    expect(parseCsv('a,b\n"x\ny",2')).toEqual([['a', 'b'], ['x\ny', '2']]);
  });

  it('compares, evaluates and matches URLs and statuses like BlockFlow', () => {
    const { compare, evaluate, listAt, urlPattern, statusFits, textOrRegex } = loadRuntime() as Record<string, Fn>;
    expect(compare!('1,250', 'greater', '$999')).toBe(true);
    expect(compare!('Order #12', 'matches', '/#\\d+/')).toBe(true);
    expect(compare!(null, 'empty', '')).toBe(false);
    expect(() => compare!('a', 'nope', '')).toThrow(/Unknown condition/);
    expect(evaluate!("upper(name) + '!'", { name: 'ann' })).toBe('ANN!');
    expect(() => evaluate!('1 +', {}, 'total')).toThrow(/^total: /);
    expect(() => listAt!('rows', {})).toThrow('List: "rows" is not in the data');
    const glob = urlPattern!('https://shop.test/*/item');
    expect(glob(new URL('https://shop.test/a/item'))).toBe(true);
    expect(glob(new URL('https://shop.test/a/b/item'))).toBe(false);
    expect(urlPattern!('/order\\/\\d+/')(new URL('https://x.test/order/12'))).toBe(true);
    expect(urlPattern!('/welcome')(new URL('https://x.test/welcome?x=1'))).toBe(true);
    expect(statusFits!(201, '2xx')).toBe(true);
    expect(statusFits!(404, '200,201')).toBe(false);
    expect(statusFits!(500, '')).toBe(true);
    expect(textOrRegex!('/done/i')).toEqual(/done/i);
    expect(textOrRegex!('a/b')).toBe('a/b');
  });

  it('retries a step after a failure', async () => {
    const { retry } = loadRuntime() as { retry: Fn };
    let calls = 0;
    await expect(retry(1, async () => (++calls === 2 ? 42 : Promise.reject(new Error('flaky'))))).resolves.toBe(42);
    expect(calls).toBe(2);
  });

  it('exports specs that are valid TypeScript', () => {
    transpile(
      exported([
        { id: 'd', type: 'data-table', config: { text: 'a\n1', into: 'rows' } },
        { id: 's', type: 'run-script', config: { code: 'return data.rows.length;', into: 'n' } },
      ]),
    );
  });
});

describe('block mappings', () => {
  it('templates: plain text stays a literal, tokens go through render()', () => {
    expect(body([{ id: 'l', type: 'log', config: { message: 'plain `text` ${x}' } }])).toBe('console.log("plain `text` ${x}");');
    expect(body([{ id: 'l', type: 'log', config: { message: '{{$json.order-id}}' } }])).toBe('console.log(render("{{$json.order-id}}", data));');
  });

  it('Wait For response → waitForResponse with the pattern, status and timeout', () => {
    expect(body([{ id: 'w', type: 'wait-for', config: { mode: 'response', url: '/api/save', status: '2xx' }, step: { timeoutSeconds: 8 } }])).toBe(
      'data = { ...data, response: await waitForResponse(tabs["main"], "/api/save", "2xx", 8000) };',
    );
    expect(body([{ id: 'w', type: 'wait-for', config: { mode: 'text', text: '/done/i' } }])).toContain(`await expect(tabs["main"].locator('body')).toContainText(textOrRegex("/done/i"));`);
    expect(body([{ id: 'w', type: 'wait-for', config: { mode: 'networkidle' } }])).toContain(`await tabs["main"].waitForLoadState("networkidle");`);
  });

  it.each([
    [{ subject: 'url', operator: 'equals', expected: 'https://x.test/' }, 'await expect(tabs["main"]).toHaveURL("https://x.test/");'],
    [{ subject: 'url', operator: 'matches', expected: '/order/' }, 'await expect(tabs["main"]).toHaveURL(regexOf("/order/"));'],
    [{ subject: 'url', operator: 'contains', expected: '/a' }, 'await expect.poll(async () => compare(tabs["main"].url(), "contains", "/a")).toBe(true);'],
    [{ subject: 'title', operator: 'not-equals', expected: 'Oops' }, 'await expect(tabs["main"]).not.toHaveTitle("Oops");'],
    [{ subject: 'title', operator: 'starts-with', expected: 'Shop' }, 'await expect.poll(async () => compare(await tabs["main"].title(), "starts-with", "Shop")).toBe(true);'],
    [{ subject: 'input', locator: '#q', operator: 'equals', expected: '{{q}}' }, 'await expect(tabs["main"].locator("#q").first()).toHaveValue(render("{{q}}", data));'],
    [{ subject: 'input', locator: '#q', operator: 'empty' }, 'await expect.poll(async () => compare(await peek(tabs["main"].locator("#q"), "value", ""), "empty", "")).toBe(true);'],
    [{ subject: 'text', locator: 'h1', operator: 'not-contains', expected: 'Error' }, 'await expect(tabs["main"].locator("h1").first()).not.toContainText("Error");'],
    [{ subject: 'text', locator: 'li >> nth=1', operator: 'equals', expected: 'B' }, 'await expect(tabs["main"].locator("li").nth(1)).toHaveText("B");'],
    [{ subject: 'text', locator: '.price', operator: 'greater', expected: '10' }, 'await expect.poll(async () => compare(await peek(tabs["main"].locator(".price"), "text", ""), "greater", "10")).toBe(true);'],
    [{ subject: 'attribute', locator: 'a', name: 'href', operator: 'equals', expected: '/x' }, 'await expect(tabs["main"].locator("a").first()).toHaveAttribute("href", "/x");'],
    [{ subject: 'count', locator: 'li', operator: 'equals', expected: '3' }, 'await expect(tabs["main"].locator("li")).toHaveCount(Number("3"));'],
    [{ subject: 'count', locator: 'li', operator: 'less', expected: '3' }, 'await expect.poll(async () => compare(await peek(tabs["main"].locator("li"), "count", ""), "less", "3")).toBe(true);'],
    [{ subject: 'checked', locator: '#c' }, 'await expect(tabs["main"].locator("#c").first()).toBeChecked();'],
    [{ subject: 'value', value: '{{n}}', operator: 'equals', expected: '2' }, 'expect(render("{{n}}", data)).toBe("2");'],
    [{ subject: 'value', value: '{{n}}', operator: 'greater', expected: '2' }, 'expect(compare(render("{{n}}", data), "greater", "2")).toBe(true);'],
    [{ subject: 'text', locator: 'h1', operator: 'equals', expected: 'Hi', soft: true, message: 'greeting' }, 'await expect.soft(tabs["main"].locator("h1").first(), "greeting").toHaveText("Hi");'],
    [
      { subject: 'title', operator: 'ends-with', expected: '!', soft: true, message: 'm' },
      'await expect.configure({ soft: true }).poll(async () => compare(await tabs["main"].title(), "ends-with", "!"), { message: "m" }).toBe(true);',
    ],
  ])('Assert %j retries like BlockFlow', (config, code) => {
    expect(body([{ id: 'a', type: 'assert', config }])).toBe(code);
  });

  it('step timeoutSeconds becomes { timeout } on actions and expects', () => {
    expect(body([{ id: 'a', type: 'assert', config: { subject: 'visible', locator: '#x' }, step: { timeoutSeconds: 3 } }])).toBe(
      'await expect(tabs["main"].locator("#x").first()).toBeVisible({ timeout: 3000 });',
    );
    expect(body([{ id: 'a', type: 'assert', config: { subject: 'title', operator: 'less', expected: '3' }, step: { timeoutSeconds: 2 } }])).toContain(', { timeout: 2000 }).toBe(true);');
    expect(body([{ id: 'c', type: 'click', config: { locator: '#x', action: 'right' }, step: { timeoutSeconds: 1.5 } }])).toBe(`await tabs["main"].locator("#x").click({ button: 'right', timeout: 1500 });`);
    expect(body([{ id: 'f', type: 'fill', config: { locator: '#x', value: 'a' }, step: { timeoutSeconds: 4 } }])).toBe('await tabs["main"].locator("#x").fill("a", { timeout: 4000 });');
  });

  it('retries and onError "continue" wrap only the step', () => {
    expect(
      body([
        { id: 'c', type: 'click', config: { locator: '#x' }, step: { retries: 2, onError: 'continue' } },
        { id: 'l', type: 'log', config: { message: 'next' } },
      ]),
    ).toBe(
      [
        'try {',
        'await retry(2, async () => {',
        'await tabs["main"].locator("#x").click();',
        '});',
        '}',
        'catch (error) {',
        `console.warn("Click: " + errorText(error) + ' (continuing)');`,
        '}',
        'console.log("next");',
      ].join('\n'),
    );
  });

  it('onError "port" runs the error branch, and the rest only on success', () => {
    expect(
      body(
        [
          { id: 'c', type: 'click', config: { locator: '#x' }, step: { onError: 'port' } },
          { id: 'ok', type: 'log', config: { message: 'ok' } },
          { id: 'bad', type: 'log', config: { message: '{{error}}' } },
        ],
        [['c', 'ok'], ['c', 'bad', 'error']],
      ),
    ).toBe(
      [
        'let ok1 = true;',
        'try {',
        'await tabs["main"].locator("#x").click();',
        '}',
        'catch (error) {',
        'ok1 = false;',
        'data = { ...data, error: errorText(error), errorBlock: "Click" };',
        'console.log(render("{{error}}", data));',
        '}',
        'if (ok1) {',
        'console.log("ok");',
        '}',
      ].join('\n'),
    );
  });

  it('Page Snapshot → ariaSnapshot of the body or of the part', () => {
    expect(body([{ id: 'p', type: 'page-snapshot', config: {} }])).toBe(`data = { ...data, snapshot: await tabs["main"].locator('body').ariaSnapshot() };`);
    expect(body([{ id: 'p', type: 'page-snapshot', config: { locator: 'role=navigation' } }])).toBe('data = { ...data, snapshot: await tabs["main"].getByRole("navigation").ariaSnapshot() };');
  });

  it('disabled blocks are skipped', () => {
    expect(body([{ id: 'c', type: 'click', config: { locator: '#x' }, step: { disabled: true } }])).toBe('// (disabled) Click');
  });

  it('Open Tab: current / workflow reuse page, new / window open a page', () => {
    expect(body([{ id: 'o', type: 'open-url', config: { url: 'https://a.test', where: 'current' } }])).toContain('tabs["main"] = page;');
    expect(body([{ id: 'o', type: 'open-url', config: { url: 'https://a.test', where: 'workflow', tab: 'x' } }])).toContain('tabs["x"] = page;');
    expect(body([{ id: 'o', type: 'open-url', config: { url: 'https://a.test', newTab: false, where: 'new' } }])).toContain('tabs["main"] = page;');
    expect(body([{ id: 'o', type: 'open-url', config: { url: 'https://a.test', where: 'window', waitUntil: 'networkidle' } }])).toBe(
      ['tabs["main"] = await newTab(context);', `await tabs["main"].goto("https://a.test", { waitUntil: 'networkidle' });`, 'data = { ...data, url: tabs["main"].url() };'].join('\n'),
    );
  });

  it('Timer: a delay after another block, a comment at the start', () => {
    expect(
      body([
        { id: 't', type: 'timer', config: { seconds: 60 } },
        { id: 'd', type: 'timer', config: { seconds: 2 } },
      ]),
    ).toBe(['// Timer: a BlockFlow trigger; the test starts here instead.', 'await page.waitForTimeout(2000);', 'data = { ...data, firedAt: new Date().toISOString() };'].join('\n'));
    expect(body([{ id: 's', type: 'schedule', config: {} }])).toBe('// Schedule: a BlockFlow trigger; the test starts here instead.');
  });

  it('data blocks run through the runtime: Data Table, Set Variable, Transform, Filter', () => {
    expect(
      body([
        { id: 'd', type: 'data-table', config: { text: 'a;b\n1;2', into: 'rows' } },
        { id: 's', type: 'set-variable', config: { name: 'my-key', value: '{{ count * 2 }}' } },
        { id: 't', type: 'transform', config: { values: [{ name: 'total', expression: "sum(pluck(rows, 'a'))" }, { name: '', expression: 'skipped' }] } },
        { id: 'f', type: 'filter', config: { list: 'rows', left: '{{item.a}}', operator: 'greater', right: '{{limit}}', into: '' } },
      ]),
    ).toBe(
      [
        '{ const rows = parseRows("a;b\\n1;2"); data = { ...data, "rows": rows, count: rows.length }; }',
        'data = { ...data, "my-key": render("{{ count * 2 }}", data) };',
        `data = { ...data, "total": evaluate("sum(pluck(rows, 'a'))", data, "total") };`,
        '{',
        'const items = listAt("rows", data);',
        'const kept = items.filter((item) => compare(render("{{item.a}}", { ...data, item }), "greater", render("{{limit}}", { ...data, item })));',
        'data = { ...data, "rows": kept, count: kept.length };',
        '}',
      ].join('\n'),
    );
  });

  it('For Each and Repeat give each round its item, then continue from "done" with the input', () => {
    expect(
      body(
        [
          { id: 'e', type: 'for-each', config: { list: 'data.results', as: 'row' } },
          { id: 'in', type: 'log', config: { message: '{{row.name}} {{index}}/{{total}}' } },
          { id: 'r', type: 'repeat', config: { times: 2 } },
          { id: 'again', type: 'log', config: { message: '{{iteration}}' } },
          { id: 'end', type: 'log', config: { message: '{{count}}' } },
        ],
        [['e', 'in', 'each'], ['e', 'r', 'done'], ['r', 'again', 'each'], ['r', 'end', 'done']],
      ),
    ).toBe(
      [
        '{',
        'const input = data;',
        'const items = listAt("data.results", input);',
        'for (const [index, item] of items.entries()) {',
        'data = { ...input, "row": item, index, total: items.length };',
        'console.log(render("{{row.name}} {{index}}/{{total}}", data));',
        '}',
        'data = { ...input, count: items.length };',
        '}',
        '{',
        'const input = data;',
        'for (let iteration = 1; iteration <= 2; iteration += 1) {',
        'data = { ...input, iteration };',
        'console.log(render("{{iteration}}", data));',
        '}',
        'data = input;',
        '}',
        'console.log(render("{{count}}", data));',
      ].join('\n'),
    );
  });

  it('If uses BlockFlow conditions on rendered values, with an else branch', () => {
    expect(
      body(
        [
          { id: 'i', type: 'if', config: { left: '{{a}}', operator: 'matches', right: '/x/i' } },
          { id: 'y', type: 'log', config: { message: 'yes' } },
          { id: 'n', type: 'log', config: { message: 'no' } },
        ],
        [['i', 'y', 'true'], ['i', 'n', 'false']],
      ),
    ).toBe(['if (compare(render("{{a}}", data), "matches", "/x/i")) {', 'console.log("yes");', '}', 'else {', 'console.log("no");', '}'].join('\n'));
  });

  it('Dialogs, Upload File, Wait for Popup and Run Script use Playwright APIs', () => {
    expect(body([{ id: 'd', type: 'dialogs', config: { action: 'accept', text: '{{name}}' } }])).toBe('data = { ...data, ...answerDialogs(tabs["main"], "accept", render("{{name}}", data)) };');
    expect(body([{ id: 'u', type: 'upload-file', config: { locator: '#f', source: 'text', content: 'a,b', filename: 'x.csv', mime: 'text/csv' } }])).toBe(
      '{ const file = { name: "x.csv", mimeType: "text/csv", buffer: Buffer.from("a,b") }; await tabs["main"].locator("#f").setInputFiles(file); data = { ...data, uploaded: file.name }; }',
    );
    expect(body([{ id: 'u', type: 'upload-file', config: { locator: '#f', source: 'url', url: '{{img}}', filename: '' } }])).toContain(
      'const file = await fileFromUrl(request, render("{{img}}", data), "");',
    );
    expect(body([{ id: 'p', type: 'wait-for-popup', config: { name: 'help', waitUntil: 'load' }, step: { timeoutSeconds: 5 } }])).toBe(
      ['tabs["help"] = await waitForPopup(context, "load", 5000);', 'data = { ...data, popupUrl: tabs["help"].url() };'].join('\n'),
    );
    expect(body([{ id: 's', type: 'run-script', config: { code: 'const n = 1;\nreturn n + data.x;', into: 'sum' } }])).toBe(
      ['data = { ...data, "sum": (await tabs["main"].evaluate(async (data: any) => {', 'const n = 1;', 'return n + data.x;', '}, data)) ?? null };'].join('\n'),
    );
  });

  it('M2 browser blocks: screenshot, download, cookies and storage, request and response body', () => {
    expect(body([{ id: 's', type: 'screenshot', config: { area: 'full', format: 'jpeg', quality: 60 } }])).toBe(
      '{ const shot = await tabs["main"].screenshot({ fullPage: true, type: \'jpeg\', quality: 60 }); await test.info().attach("Screenshot", { body: shot, contentType: "image/jpeg" }); data = { ...data, screenshotId: "s" }; }',
    );
    expect(body([{ id: 's', type: 'screenshot', config: { area: 'element', locator: '#card' } }])).toContain('await tabs["main"].locator("#card").first().screenshot();');
    expect(body([{ id: 'd', type: 'wait-for-download', config: { url: 'export.csv', read: 'csv' }, step: { timeoutSeconds: 9 } }])).toBe(
      'data = { ...data, ...(await waitForDownload(tabs["main"], "export.csv", "csv", 9000)) };',
    );
    expect(body([{ id: 'c', type: 'cookies-storage', config: { action: 'set', name: 'session', value: '{{token}}', maxAgeSeconds: 60, httpOnly: true } }])).toBe(
      'data = { ...data, ...(await cookies(context, tabs["main"].url(), "set", "session", { name: "session", value: render("{{token}}", data), url: tabs["main"].url(), expires: Math.round(Date.now() / 1000) + 60, httpOnly: true })) };',
    );
    expect(body([{ id: 'c', type: 'cookies-storage', config: { action: 'clear', url: 'https://shop.test' } }])).toBe('data = { ...data, ...(await cookies(context, "https://shop.test", "clear", "")) };');
    expect(body([{ id: 'c', type: 'cookies-storage', config: { area: 'local', action: 'get', name: 'theme' } }])).toBe('data = { ...data, ...(await pageStorage(tabs["main"], "local", "get", "theme", "")) };');
    expect(body([{ id: 'w', type: 'wait-for', config: { mode: 'request', url: '/api/save', method: 'POST' } }])).toBe('data = { ...data, request: await waitForRequest(tabs["main"], "/api/save", "POST") };');
    expect(body([{ id: 'w', type: 'wait-for', config: { mode: 'response', url: '/api', captureBody: true } }])).toBe('data = { ...data, response: await waitForResponse(tabs["main"], "/api", "", undefined, "", true) };');
    expect(body([{ id: 'w', type: 'wait-for', config: { mode: 'response', url: '/api' } }])).toBe('data = { ...data, response: await waitForResponse(tabs["main"], "/api", "") };');
  });

  it('what has no Playwright equivalent is a marked comment', () => {
    expect(body([{ id: 's', type: 'save-dataset', config: {} }])).toMatch(/^\/\/ BlockFlow-only: .+ has no Playwright equivalent, skipped\.$/);
  });
});
