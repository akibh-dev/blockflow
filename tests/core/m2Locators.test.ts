import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { assertBlock, createDefaultRegistry, pressKeyBlock } from '../../src/core/blocks';
import { locatorProblem } from '../../src/core/check';
import { withDefaults } from '../../src/core/config';
import { LocatorSyntaxError, parseLocatorAlternatives, parseLocatorSteps, parseRoleSelector, splitAlternatives } from '../../src/core/locatorSyntax';
import { toPlaywrightLocator, workflowToPlaywright } from '../../src/core/playwright';
import { FakeHost, flow, harness } from '../helpers/fakeHost';

vi.mock('wxt/browser', () => ({ browser: {} }));
const { pressKey } = await import('../../src/browser/cdp');

// M2.1 filters and `||`, M2.2 role options, M2.9 Assert subjects, M2.14 Press Key: parsing, checking, export.

const registry = createDefaultRegistry();
type Node = { id: string; type: string; config?: Record<string, unknown>; step?: Record<string, unknown> };

describe('locator syntax', () => {
  it('filters are steps; a bare `visible` is the visible filter', () => {
    expect(parseLocatorSteps('li >> has-text=Apple >> has="b >> i" >> visible >> visible=false')).toEqual([
      { engine: 'css', body: 'li' },
      { engine: 'has-text', body: 'Apple' },
      { engine: 'has', body: '"b >> i"' },
      { engine: 'visible', body: 'true' },
      { engine: 'visible', body: 'false' },
    ]);
  });

  it('`||` splits alternatives outside quotes and brackets, and binds loosest', () => {
    expect(splitAlternatives('a >> b || text="x || y" || role=button[name="p||q"]')).toEqual(['a >> b', 'text="x || y"', 'role=button[name="p||q"]']);
    expect(splitAlternatives('//a | //b')).toEqual(['//a | //b']);
    expect(parseLocatorAlternatives('#a || #b')).toHaveLength(2);
    expect(() => splitAlternatives('|| #a')).toThrow(LocatorSyntaxError);
  });

  it('role options, in written order, quotes kept', () => {
    expect(parseRoleSelector('button[name="Bold"][pressed][expanded=false][disabled=true][selected]')).toEqual({
      role: 'button',
      options: [{ key: 'name', value: '"Bold"' }, { key: 'pressed' }, { key: 'expanded', value: 'false' }, { key: 'disabled', value: 'true' }, { key: 'selected' }],
    });
    expect(() => parseRoleSelector('button[presed]')).toThrow('Unknown role option [presed]');
  });
});

describe('locatorProblem accepts the new syntax and flags typos in it', () => {
  it.each([
    'role=listitem >> has-text=Apple',
    'li >> has-not-text="Sold out"',
    'li >> has=role=button[name="Buy"]',
    'li >> has-not="span >> text=Sale"',
    'button >> visible',
    'button >> visible=false',
    '#a || role=button[name="Save"] || text=Save',
    'role=button[pressed][expanded=false][selected=true][disabled]',
  ])('ok: %s', (locator) => {
    expect(locatorProblem(locator)).toBeNull();
  });

  it.each([
    ['li >> has-txt=Apple', 'not a locator engine', 'Did you mean "has-text"?'],
    ['has-text=Apple', 'filters the matches of a step before it', undefined],
    ['li >> visible=yes', 'visible= takes true or false', undefined],
    ['li >> visibel', 'mistyped visible filter', 'Did you mean "visible"?'],
    ['li >> has="rol=button"', 'inside has=', 'Did you mean "role"?'],
    ['role=button[presed]', 'Unknown role option [presed]', undefined],
    ['role=button[pressed=maybe]', 'takes true or false', undefined],
    ['#a ||', 'needs a locator on both sides', undefined],
  ])('problem: %s', (locator, message, hint) => {
    const problem = locatorProblem(locator);
    expect(problem?.message).toContain(message);
    if (hint) expect(problem?.hint).toBe(hint);
  });
});

describe('export to Playwright', () => {
  it.each([
    ['role=listitem >> has-text=Apple', `page.getByRole("listitem").filter({ hasText: "Apple" })`],
    ['li >> has-text="Cherry pie"', `page.locator("li").filter({ hasText: /^Cherry pie$/ })`],
    ['li >> has-text=/ap+le/i', `page.locator("li").filter({ hasText: /ap+le/i })`],
    ['li >> has-not-text=Sold', `page.locator("li").filter({ hasNotText: "Sold" })`],
    ['li >> has=role=button[name="Buy"]', `page.locator("li").filter({ has: page.getByRole("button", { name: "Buy" }) })`],
    ['li >> has-not="span >> text=Sale"', `page.locator("li").filter({ hasNot: page.locator("span").getByText("Sale") })`],
    ['frame=#f >> li >> has=em', `page.frameLocator("#f").locator("li").filter({ has: page.frameLocator("#f").locator("em") })`],
    ['button >> visible', `page.locator("button").filter({ visible: true })`],
    ['button >> visible=false', `page.locator("button").filter({ visible: false })`],
    ['#a || text=Save', `page.locator("#a").or(page.getByText("Save"))`],
    [
      'role=button[name="Bold"][pressed][expanded=false][selected][disabled=false]',
      `page.getByRole("button", { name: "Bold", pressed: true, expanded: false, selected: true, disabled: false })`,
    ],
    ['role=button[include-hidden]', `page.getByRole("button", { includeHidden: true })`],
  ])('%s', (locator, code) => {
    expect(toPlaywrightLocator(locator, 'page')).toBe(code);
  });

  const exported = (nodes: Node[]) => {
    const all: Node[] = [{ id: 'open', type: 'open-url', config: { url: 'https://shop.test/' } }, ...nodes];
    return workflowToPlaywright(flow(all, all.slice(1).map((node, index) => [all[index]!.id, node.id] as [string, string])), { registry });
  };

  it('new Assert subjects use web-first matchers', () => {
    const spec = exported([
      { id: 'a', type: 'assert', config: { subject: 'focused', locator: '#q' } },
      { id: 'b', type: 'assert', config: { subject: 'editable', locator: '#q' } },
      { id: 'c', type: 'assert', config: { subject: 'in-viewport', locator: '#q' } },
      { id: 'd', type: 'assert', config: { subject: 'class', locator: '#q', operator: 'contains', expected: 'active big' } },
      { id: 'e', type: 'assert', config: { subject: 'class', locator: '#q', operator: 'equals', expected: 'a b' } },
      { id: 'f', type: 'assert', config: { subject: 'css', locator: '#q', name: 'color', operator: 'equals', expected: 'rgb(0, 0, 0)' } },
      { id: 'g', type: 'assert', config: { subject: 'accessible-name', locator: '#q', operator: 'contains', expected: 'Sear' } },
      { id: 'h', type: 'assert', config: { subject: 'accessible-description', locator: '#q', operator: 'matches', expected: '/hint/i' } },
      { id: 'i', type: 'assert', config: { subject: 'css', locator: '#q', name: 'width', operator: 'greater', expected: '10' } },
    ]);
    const loc = 'tabs["main"].locator("#q").first()';
    expect(spec).toContain(`await expect(${loc}).toBeFocused();`);
    expect(spec).toContain(`await expect(${loc}).toBeEditable();`);
    expect(spec).toContain(`await expect(${loc}).toBeInViewport();`);
    expect(spec).toContain(`await expect(${loc}).toContainClass("active big");`);
    expect(spec).toContain(`await expect(${loc}).toHaveClass("a b");`);
    expect(spec).toContain(`await expect(${loc}).toHaveCSS("color", "rgb(0, 0, 0)");`);
    expect(spec).toContain(`await expect(${loc}).toHaveAccessibleName(textPattern("contains", "Sear"));`);
    expect(spec).toContain(`await expect(${loc}).toHaveAccessibleDescription(regexOf("/hint/i"));`);
    expect(spec).toContain(`compare(await peek(tabs["main"].locator("#q"), "css", "width"), "greater", "10")`);
    const helpers = ts.transpileModule(spec.slice(spec.indexOf('// --- helpers')), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const textPattern = new Function(`${helpers}\nreturn textPattern;`)() as (op: string, text: string) => RegExp;
    expect(textPattern('contains', 'a.b (c)')).toEqual(/a\.b \(c\)/);
    expect(textPattern('starts-with', 'x')).toEqual(/^x/);
    expect(textPattern('ends-with', 'x')).toEqual(/x$/);
  });

  it('Press Key: chords as written, insert text through keyboard.insertText', () => {
    const spec = exported([
      { id: 'k', type: 'press-key', config: { key: 'ControlOrMeta+Shift+K' } },
      { id: 't', type: 'press-key', config: { mode: 'text', text: 'Hi {{name}}', locator: '#q' } },
    ]);
    expect(spec).toContain('await tabs["main"].keyboard.press("ControlOrMeta+Shift+K");');
    expect(spec).toContain('await tabs["main"].locator("#q").focus();\n');
    expect(spec).toContain('await tabs["main"].keyboard.insertText(render("Hi {{name}}", data));');
  });
});

describe('Assert: new subjects', () => {
  type Config = Parameters<NonNullable<typeof assertBlock.validate>>[0];
  const problems = (config: Partial<Config>) => assertBlock.validate!(withDefaults(assertBlock, config) as Config);

  it('css needs the property in name; the yes/no ones need an element', () => {
    expect(problems({ subject: 'css', locator: '#a' })).toEqual([expect.objectContaining({ key: 'name', code: 'config.required' })]);
    expect(problems({ subject: 'css', locator: '#a', name: 'color' })).toEqual([]);
    expect(problems({ subject: 'in-viewport' })).toEqual([expect.objectContaining({ key: 'locator' })]);
    expect(problems({ subject: 'accessible-name', locator: '#a' })).toEqual([]);
  });

  it('class "contains" means has the class (not a substring)', async () => {
    const host = new FakeHost();
    host.agent = async () => ({ text: 'btn inactive', count: 1 });
    const one = (expected: string, operator = 'contains') =>
      harness(flow([{ id: 'open', type: 'open-url', config: { url: 'https://shop.test/' } }, { id: 'a', type: 'assert', config: { subject: 'class', locator: '#b', operator, expected }, step: { timeoutSeconds: 1 } }], [['open', 'a']]), host);
    expect((await one('active').runner.runOnce()).status).toBe('failed');
    expect((await one('inactive btn').runner.runOnce()).status).toBe('passed');
    expect((await one('active', 'not-contains').runner.runOnce()).status).toBe('passed');
  });

  it('reads with the matching kind', async () => {
    const host = new FakeHost();
    host.agent = async (_tab, request) => ({ text: request.op === 'read' && request.kind === 'css' ? 'block' : 'true', count: 1 });
    const h = harness(
      flow(
        [
          { id: 'open', type: 'open-url', config: { url: 'https://shop.test/' } },
          { id: 'a', type: 'assert', config: { subject: 'focused', locator: '#q' } },
          { id: 'b', type: 'assert', config: { subject: 'css', locator: '#q', name: 'display', operator: 'equals', expected: 'block' } },
        ],
        [['open', 'a'], ['a', 'b']],
      ),
      host,
    );
    expect((await h.runner.runOnce()).status).toBe('passed');
    expect(host.actions.map((action) => action.request)).toEqual([
      { op: 'read', locator: '#q', kind: 'focused', name: '' },
      { op: 'read', locator: '#q', kind: 'css', name: 'display' },
    ]);
  });
});

describe('Press Key', () => {
  it('old configs (no mode) press the key; mode text inserts text', async () => {
    const host = new FakeHost();
    host.agent = async () => ({});
    const h = harness(
      flow(
        [
          { id: 'open', type: 'open-url', config: { url: 'https://shop.test/' } },
          { id: 'k', type: 'press-key', config: { key: 'Control+Shift+K', locator: '#q' } },
          { id: 't', type: 'press-key', config: { mode: 'text', text: 'héllo {{url}}' } },
        ],
        [['open', 'k'], ['k', 't']],
      ),
      host,
    );
    expect((await h.runner.runOnce()).status).toBe('passed');
    expect(host.actions.map((action) => action.request)).toEqual([
      { op: 'press', key: 'Control+Shift+K', locator: '#q' },
      { op: 'insert-text', text: 'héllo https://shop.test/' },
    ]);
  });

  it('validate: key for keys, text for text', () => {
    type Config = Parameters<NonNullable<typeof pressKeyBlock.validate>>[0];
    const problems = (config: Partial<Config>) => pressKeyBlock.validate!(withDefaults(pressKeyBlock, config) as Config);
    expect(problems({ key: ' ' })).toEqual([expect.objectContaining({ key: 'key' })]);
    expect(problems({ mode: 'text' })).toEqual([expect.objectContaining({ key: 'text' })]);
    expect(problems({ mode: 'text', text: 'x', key: '' })).toEqual([]);
  });
});

describe('real input: CDP key events for chords', () => {
  it('modifiers down first, up last, each carrying the modifiers held', async () => {
    const sent: Record<string, unknown>[] = [];
    await pressKey(async (_method, params) => {
      sent.push(params as Record<string, unknown>);
      return {};
    }, 'Control+Shift+k');
    expect(sent.map((event) => `${event.type}:${event.key}:${event.modifiers}${event.text ? `:${event.text}` : ''}`)).toEqual([
      'rawKeyDown:Control:2',
      'rawKeyDown:Shift:10',
      'rawKeyDown:K:10',
      'keyUp:K:10',
      'keyUp:Shift:2',
      'keyUp:Control:0',
    ]);
    sent.length = 0;
    await pressKey(async (_method, params) => {
      sent.push(params as Record<string, unknown>);
      return {};
    }, 'Shift+a');
    expect(sent[1]).toMatchObject({ type: 'keyDown', key: 'A', code: 'KeyA', text: 'A', modifiers: 8 });
  });
});
