import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../src/core/blocks';
import { checkFile, locatorProblem, parseJson } from '../../src/core/check';
import { parseImport } from '../../src/core/library';
import { closest, editDistance } from '../../src/core/suggest';
import { validateWorkflow } from '../../src/core/validate';
import type { CheckOptions } from '../../src/core/check';
import type { Issue } from '../../src/core/issues';
import type { Workflow } from '../../src/core/types';

const registry = createDefaultRegistry();

type RawNode = { id: string; type: string; config?: Record<string, unknown>; step?: unknown; [key: string]: unknown };

/** A bare workflow as an author would write it: nodes without positions, edges as [source, target, port?]. */
function file(nodes: RawNode[], edges: ([string, string] | [string, string, string])[] = [], extra: Record<string, unknown> = {}) {
  return {
    name: 'Test',
    nodes: nodes.map((node) => ({ config: {}, ...node })),
    edges: edges.map(([source, target, sourcePort], index) => ({ id: `e${index}`, source, target, ...(sourcePort ? { sourcePort } : {}) })),
    ...extra,
  };
}

const open = (id = 'open', config: Record<string, unknown> = {}): RawNode => ({ id, type: 'open-url', config: { url: 'https://example.com', ...config } });
const check = (raw: unknown, options?: CheckOptions) => checkFile(raw, registry, options);
const only = (issues: Issue[], code: string) => issues.filter((issue) => issue.code === code);

describe('checkFile: one fixture per code', () => {
  it('json.invalid', () => {
    const result = parseJson('{"name": "x",}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]).toMatchObject({ level: 'error', code: 'json.invalid', path: '' });
  });

  it('file.shape: not an object, workflows not a list, missing edges, node without id', () => {
    expect(check(42)).toMatchObject([{ code: 'file.shape', path: '' }]);
    expect(check({ workflows: {} })).toMatchObject([{ code: 'file.shape', path: '/workflows' }]);
    expect(check({ workflows: [] })).toMatchObject([{ code: 'file.shape', path: '/workflows' }]);
    expect(check({ format: 'other', workflows: [file([open()])] })).toMatchObject([{ code: 'file.shape', path: '/format' }]);
    expect(check({ name: 'x', nodes: [] })).toMatchObject([{ code: 'file.shape', path: '/edges' }]);
    expect(only(check(file([{ id: '', type: 'log' }])), 'file.shape')).toMatchObject([{ path: '/nodes/0/id', level: 'error' }]);
    expect(only(check(file([{ id: 'a', type: 'log', config: [] as unknown as Record<string, unknown> }])), 'file.shape')).toMatchObject([{ path: '/nodes/0/config' }]);
  });

  it('file.key.unknown (warning) with aliases: settings → config, from → source', () => {
    const raw = file([{ id: 'a', type: 'log', settings: { message: 'x' } }]);
    (raw.edges as unknown[]).push({ from: 'a', source: 'a', target: 'a' });
    const issues = check({ format: 'blockflow-workflows', workflows: [raw] });
    expect(only(issues, 'file.key.unknown')).toMatchObject([
      { level: 'warning', path: '/workflows/0/nodes/0/settings', hint: 'Did you mean "config"?' },
      { level: 'warning', path: '/workflows/0/edges/0/from', hint: 'Did you mean "source"?' },
    ]);
  });

  it('node.id.duplicate', () => {
    expect(only(check(file([{ id: 'a', type: 'log' }, { id: 'a', type: 'log' }])), 'node.id.duplicate')).toMatchObject([
      { level: 'error', path: '/nodes/1/id' },
    ]);
  });

  it('node.type.unknown, with did-you-mean by spelling and by label', () => {
    const issues = check(file([{ id: 'a', type: 'clik' }, { id: 'b', type: 'open-tab' }, { id: 'c', type: 'teleport' }]));
    expect(only(issues, 'node.type.unknown')).toMatchObject([
      { level: 'error', path: '/nodes/0/type', hint: 'Did you mean "click"?' },
      { path: '/nodes/1/type', hint: 'Did you mean "open-url"?' },
      { path: '/nodes/2/type', hint: 'See blocks.md for the block types.' },
    ]);
  });

  it('config.key.unknown, with did-you-mean or the valid keys', () => {
    const issues = check(file([open(), { id: 'c', type: 'click', config: { locater: '#go', zzzzzz: 1 } }], [['open', 'c']]));
    expect(only(issues, 'config.key.unknown')).toMatchObject([
      { level: 'error', path: '/nodes/1/config/locater', hint: 'Did you mean "locator"?' },
      { path: '/nodes/1/config/zzzzzz', hint: expect.stringMatching(/^Valid keys: locator, /) },
    ]);
    // Columns of rows settings too.
    const rows = check(file([open(), { id: 'f', type: 'fill-form', config: { fields: [{ selector: '#a', value: 'x' }] } }], [['open', 'f']]));
    expect(only(rows, 'config.key.unknown')).toMatchObject([{ path: '/nodes/1/config/fields/0/selector', hint: 'Valid keys: locator, value.' }]);
  });

  it('config.key.renamed (info) for old key names, which still import', () => {
    const raw = file([open(), { id: 'r', type: 'read-element', config: { selector: '.price' } }], [['open', 'r']]);
    const issues = check(raw);
    expect(issues).toMatchObject([{ level: 'info', code: 'config.key.renamed', path: '/nodes/1/config/selector', hint: 'Use "locator".' }]);
    const result = parseImport(JSON.stringify(raw), []);
    expect(result.ok && result.workflows[0]?.nodes[1]?.config).toEqual({ locator: '.price' });
  });

  it('legacy keys a block still reads are not unknown (Open Tab newTab)', () => {
    expect(check(file([open('open', { newTab: false })]))).toEqual([]);
  });

  it('config.type: numbers, booleans, text and rows', () => {
    const issues = check(
      file(
        [
          { id: 't', type: 'timer', config: { seconds: 'soon', repeat: 'yes' } },
          open(),
          { id: 'f', type: 'fill', config: { locator: '#q', value: 42 } },
          { id: 'ff', type: 'fill-form', config: { fields: 'email' } },
        ],
        [
          ['t', 'open'],
          ['open', 'f'],
          ['f', 'ff'],
        ],
      ),
    );
    expect(only(issues, 'config.type').map((issue) => [issue.path, issue.hint])).toEqual([
      ['/nodes/0/config/seconds', expect.any(String)],
      ['/nodes/0/config/repeat', 'Write true or false without quotes.'],
      ['/nodes/2/config/value', 'Write it in quotes: "42".'],
      ['/nodes/3/config/fields', undefined],
    ]);
    // Numeric strings work (withDefaults coerces them).
    expect(only(check(file([{ id: 't', type: 'timer', config: { seconds: '30' } }])), 'config.type')).toEqual([]);
  });

  it('config.required, including an empty row', () => {
    const issues = check(file([open('open', { url: '' }), { id: 'ff', type: 'fill-form', config: { fields: [{ locator: '', value: 'x' }] } }], [['open', 'ff']]));
    expect(only(issues, 'config.required').map((issue) => issue.path)).toEqual(['/nodes/0/config/url', '/nodes/1/config/fields/0/locator']);
  });

  it('config.enum, with did-you-mean or the options', () => {
    const issues = check(file([open('open', { where: 'newtab' }), open('two', { waitUntil: 'whenever' })]));
    expect(only(issues, 'config.enum')).toMatchObject([
      { path: '/nodes/0/config/where', hint: 'One of: "new", "workflow", "window", "current".' },
      { path: '/nodes/1/config/waitUntil' },
    ]);
    expect(only(check(file([open('open', { waitUntil: 'lod' })])), 'config.enum')[0]?.hint).toBe('Did you mean "load"?');
  });

  it('config.value: numbers out of range, bad times', () => {
    const issues = check(file([{ id: 'r', type: 'repeat', config: { times: 0 } }, { id: 's', type: 'schedule', config: { every: 'day', at: '9am' } }]));
    expect(only(issues, 'config.value').map((issue) => issue.path)).toEqual(['/nodes/0/config/times', '/nodes/1/config/at']);
  });

  it('config.locator.invalid: unclosed quotes and brackets, mistyped engines, bad nth', () => {
    const issues = check(
      file(
        [
          open(),
          { id: 'a', type: 'click', config: { locator: 'role=button[name="Save]' } },
          { id: 'b', type: 'click', config: { locator: 'rol=button' } },
          { id: 'c', type: 'click', config: { locator: '.item >> nth=first' } },
          { id: 'd', type: 'click', config: { locator: '{{ which }}' } },
          { id: 'e', type: 'click', config: { locator: 'role=button[name="Save"] >> nth=0' } },
        ],
        [
          ['open', 'a'],
          ['a', 'b'],
          ['b', 'c'],
          ['c', 'd'],
          ['d', 'e'],
        ],
      ),
    );
    expect(only(issues, 'config.locator.invalid').map((issue) => [issue.path, issue.hint])).toEqual([
      ['/nodes/1/config/locator', undefined],
      ['/nodes/2/config/locator', 'Did you mean "role"?'],
      ['/nodes/3/config/locator', undefined],
    ]);
    expect(locatorProblem('text="Sign in" >> xpath=//a')).toBeNull();
    expect(locatorProblem('input[name=email]')).toBeNull();
  });

  it('config.url.invalid (templated URLs are checked at run time)', () => {
    const issues = check(file([open('a', { url: 'javascript:alert(1)' }), open('b', { url: '{{link}}' }), open('c', { url: 'example.com' })]));
    expect(only(issues, 'config.url.invalid').map((issue) => issue.path)).toEqual(['/nodes/0/config/url']);
  });

  it('config.template.invalid and config.template.unsupported (warning)', () => {
    const issues = check(
      file([
        { id: 'l', type: 'log', config: { message: 'Total: {{ price * }}' } },
        { id: 'm', type: 'log', config: { message: 'Hello {{name' } },
        { id: 'f', type: 'for-each', config: { list: '{{items}}' } },
      ]),
    );
    expect(only(issues, 'config.template.invalid').map((issue) => issue.path)).toEqual(['/nodes/0/config/message', '/nodes/1/config/message']);
    expect(only(issues, 'config.template.unsupported')).toMatchObject([{ level: 'warning', path: '/nodes/2/config/list', hint: expect.stringContaining('without braces') }]);
  });

  it('edge.endpoint.missing, with did-you-mean against block ids', () => {
    const issues = check(file([open(), { id: 'click', type: 'click', config: { locator: '#go' } }], [['open', 'clik']]));
    expect(only(issues, 'edge.endpoint.missing')).toMatchObject([{ level: 'error', path: '/edges/0/target', hint: 'Did you mean "click"?' }]);
  });

  it('edge.port.unknown, with did-you-mean, and the error output without onError "port"', () => {
    const issues = check(
      file(
        [
          { id: 'if', type: 'if', config: { left: '1', operator: 'equals', right: '1' } },
          { id: 'yes', type: 'log', config: { message: 'y' } },
          { id: 'oops', type: 'log', config: { message: 'o' } },
        ],
        [
          ['if', 'yes', 'ture'],
          ['yes', 'oops', 'error'],
        ],
      ),
    );
    expect(only(issues, 'edge.port.unknown')).toMatchObject([
      { level: 'error', path: '/edges/0/sourcePort', hint: 'Did you mean "true"?' },
      { path: '/edges/1/sourcePort', hint: 'Set "step": {"onError": "port"} on the source block.' },
    ]);
    const fixed = check(
      file(
        [
          { id: 'a', type: 'log', config: { message: 'a' }, step: { onError: 'port' } },
          { id: 'b', type: 'log', config: { message: 'b' } },
        ],
        [['a', 'b', 'error']],
      ),
    );
    expect(fixed).toEqual([]);
  });

  it('edge.target.no-input and edge.duplicate', () => {
    const issues = check(
      file(
        [
          { id: 'l', type: 'log', config: { message: 'x' } },
          { id: 't', type: 'schedule', config: {} },
          { id: 'm', type: 'log', config: { message: 'y' } },
        ],
        [
          ['l', 't'],
          ['l', 'm'],
          ['l', 'm'],
        ],
      ),
    );
    expect(only(issues, 'edge.target.no-input')).toMatchObject([{ level: 'error', path: '/edges/0/target' }]);
    expect(only(issues, 'edge.duplicate')).toMatchObject([{ level: 'warning', path: '/edges/2' }]);
  });

  it('step.key.unknown and step.value', () => {
    const issues = check(file([{ id: 'l', type: 'log', config: { message: 'x' }, step: { timeout: 5, retries: 9, onError: 'ignore', screenshot: 'always' } }]));
    expect(only(issues, 'step.key.unknown')).toMatchObject([{ level: 'error', path: '/nodes/0/step/timeout', hint: expect.stringMatching(/^Step settings: timeoutSeconds/) }]);
    expect(only(issues, 'step.value').map((issue) => issue.path)).toEqual(['/nodes/0/step/retries', '/nodes/0/step/onError']);
    expect(only(check(file([{ id: 'l', type: 'log', config: { message: 'x' }, step: { retires: 1 } }])), 'step.key.unknown')[0]?.hint).toBe('Did you mean "retries"?');
  });

  it('graph.no-start (error) when every block has an input', () => {
    const issues = check(file([{ id: 'a', type: 'log', config: { message: 'a' } }, { id: 'b', type: 'log', config: { message: 'b' } }], [['a', 'b'], ['b', 'a']]));
    expect(only(issues, 'graph.no-start')).toMatchObject([{ level: 'error', path: '/edges' }]);
  });

  it('graph.cycle: a loop back is a warning, a block wired to itself an error', () => {
    const loop = check(
      file(
        [
          { id: 's', type: 'log', config: { message: 's' } },
          { id: 'a', type: 'log', config: { message: 'a' } },
          { id: 'b', type: 'log', config: { message: 'b' } },
        ],
        [
          ['s', 'a'],
          ['a', 'b'],
          ['b', 'a'],
        ],
      ),
    );
    expect(only(loop, 'graph.cycle')).toMatchObject([{ level: 'warning', path: '/edges/2' }]);
    expect(only(check(file([{ id: 'a', type: 'log', config: { message: 'a' } }], [['a', 'a']])), 'graph.cycle')).toMatchObject([{ level: 'error', path: '/edges/0' }]);
  });

  it('graph.unreachable (warning)', () => {
    // a → b, and c ↔ d: c and d have inputs but nothing starts them.
    const issues = check(
      file(
        ['a', 'b', 'c', 'd'].map((id) => ({ id, type: 'log', config: { message: id } })),
        [
          ['a', 'b'],
          ['c', 'd'],
          ['d', 'c'],
        ],
      ),
    );
    expect(only(issues, 'graph.unreachable')).toMatchObject([
      { level: 'warning', path: '/nodes/2' },
      { level: 'warning', path: '/nodes/3' },
    ]);
  });

  it('page.no-tab (warning): a page block without its Open Tab on every path', () => {
    const noOpen = check(file([{ id: 'c', type: 'click', config: { locator: '#go' } }]));
    expect(noOpen).toMatchObject([{ level: 'warning', code: 'page.no-tab', path: '/nodes/0' }]);

    // Only on the "true" branch: the join after If misses it on the "false" path.
    const branch = check(
      file(
        [
          { id: 'if', type: 'if', config: { left: '1', operator: 'equals', right: '1' } },
          open(),
          { id: 'log', type: 'log', config: { message: 'no tab' } },
          { id: 'c', type: 'click', config: { locator: '#go' } },
        ],
        [
          ['if', 'open', 'true'],
          ['if', 'log', 'false'],
          ['open', 'c'],
          ['log', 'c'],
        ],
      ),
    );
    expect(only(branch, 'page.no-tab').map((issue) => issue.path)).toEqual(['/nodes/3']);

    // Wrong tab name: the hint names the tabs that are open.
    const wrongName = check(file([open('open', { tab: 'admin' }), { id: 'c', type: 'click', config: { locator: '#go' } }], [['open', 'c']]));
    expect(only(wrongName, 'page.no-tab')[0]?.hint).toMatch(/Tabs open here: "admin"/);

    // Wait for Popup names a new tab; the error output of Open Tab does not carry its tab.
    const popup = check(
      file(
        [
          open(),
          { id: 'p', type: 'wait-for-popup', config: { name: 'popup' } },
          { id: 'c', type: 'click', config: { locator: '#go', tab: 'popup' } },
        ],
        [
          ['open', 'p'],
          ['p', 'c'],
        ],
      ),
    );
    expect(popup).toEqual([]);
    const failed = check(
      file([{ ...open(), step: { onError: 'port' } }, { id: 'c', type: 'click', config: { locator: '#go' } }], [['open', 'c', 'error']]),
    );
    expect(only(failed, 'page.no-tab')).toHaveLength(1);

    // Blocks that do not need a tab: Read Element with a URL, Extract from HTML, Assert on a value.
    const noTab = check(
      file([
        { id: 'r', type: 'read-element', config: { url: 'https://example.com', locator: 'h1' } },
        { id: 'x', type: 'extract-list', config: { source: 'html', html: '{{body}}', locator: '.item' } },
        { id: 'a', type: 'assert', config: { subject: 'value', value: '{{x}}', operator: 'equals', expected: '1' } },
      ]),
    );
    expect(only(noTab, 'page.no-tab')).toEqual([]);
  });

  it('page.no-tab is skipped for a workflow that Run Workflow calls (its tabs come from the caller)', () => {
    const callee = { ...file([{ id: 'c', type: 'click', config: { locator: '#go' } }]), id: 'sub' };
    const caller = { ...file([open(), { id: 'call', type: 'run-workflow', config: { workflow: 'sub' } }], [['open', 'call']]), id: 'main' };
    expect(check({ format: 'blockflow-workflows', workflows: [callee, caller] })).toEqual([]);
  });

  it('workflow.call.missing, with a hint when the name was used instead of the id', () => {
    const callee = { ...file([{ id: 'l', type: 'log', config: { message: 'x' } }]), id: 'sub', name: 'Login' };
    const caller = { ...file([{ id: 'call', type: 'run-workflow', config: { workflow: 'Login' } }]), id: 'main' };
    expect(only(check({ workflows: [callee, caller] }), 'workflow.call.missing')).toMatchObject([
      { level: 'error', path: '/workflows/1/nodes/0/config/workflow', hint: 'Use the workflow\'s id "sub", not its name.' },
    ]);
    // A saved workflow may be called by its id.
    const alone = file([{ id: 'call', type: 'run-workflow', config: { workflow: 'saved-1' } }]);
    expect(only(check(alone), 'workflow.call.missing')).toHaveLength(1);
    expect(only(check(alone, { workflowIds: ['saved-1'] }), 'workflow.call.missing')).toEqual([]);
  });

  it('secret.unknown (warning) only when the secret names are known', () => {
    const raw = file([{ id: 'l', type: 'log', config: { message: 'token {{ secret.apiTokn }}' } }]);
    expect(check(raw)).toEqual([]);
    expect(check(raw, { secrets: ['apiToken'] })).toMatchObject([
      { level: 'warning', code: 'secret.unknown', path: '/nodes/0/config/message', hint: 'Did you mean "apiToken"?' },
    ]);
  });
});

describe('block validate hooks (shared by check.ts and the editor)', () => {
  const cases: [RawNode, string][] = [
    [{ id: 'x', type: 'assert', config: { subject: 'text', locator: '' } }, '/nodes/1/config/locator'],
    [{ id: 'x', type: 'assert', config: { subject: 'attribute', locator: '#a', name: '' } }, '/nodes/1/config/name'],
    [{ id: 'x', type: 'wait-for', config: { mode: 'text' } }, '/nodes/1/config/text'],
    [{ id: 'x', type: 'wait-for', config: { mode: 'url' } }, '/nodes/1/config/url'],
    [{ id: 'x', type: 'wait-for', config: { mode: 'visible' } }, '/nodes/1/config/locator'],
    [{ id: 'x', type: 'upload-file', config: { source: 'url' } }, '/nodes/1/config/url'],
    [{ id: 'x', type: 'upload-file', config: { source: 'text', content: '' } }, '/nodes/1/config/content'],
    [{ id: 'x', type: 'download', config: { from: 'dataset', dataset: '' } }, '/nodes/1/config/dataset'],
    [{ id: 'x', type: 'read-element', config: { locator: 'h1', read: 'attribute' } }, '/nodes/1/config/name'],
    [{ id: 'x', type: 'navigate', config: { action: 'goto' } }, '/nodes/1/config/url'],
    [{ id: 'x', type: 'extract-table', config: { source: 'html', html: '' } }, '/nodes/1/config/html'],
  ];
  for (const [node, path] of cases) {
    it(`${node.type} ${JSON.stringify(node.config)}`, () => {
      const raw = file([open(), node], [['open', 'x']]);
      expect(check(raw).filter((issue) => issue.level === 'error')).toMatchObject([{ code: 'config.required', path }]);
      const workflow = { ...raw, id: 'w', enabled: false, schemaVersion: 2, nodes: raw.nodes.map((n) => ({ ...n, position: { x: 0, y: 0 } })) } as unknown as Workflow;
      expect(validateWorkflow(workflow, registry).some((issue) => issue.level === 'error' && issue.nodeId === 'x')).toBe(true);
    });
  }

  it('Navigate back needs no URL', () => {
    expect(check(file([open(), { id: 'x', type: 'navigate', config: { action: 'back' } }], [['open', 'x']]))).toEqual([]);
  });
});

describe('parseImport', () => {
  it('refuses a file with errors and returns every issue', () => {
    const result = parseImport(JSON.stringify(file([{ id: 'a', type: 'clik' }, { id: 'b', type: 'log', config: { mesage: 'x' } }])), []);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe('Block "a" has an unknown type "clik". (and 1 more problem)');
    expect(result.issues.map((issue) => issue.code)).toEqual(['node.type.unknown', 'config.key.unknown']);
  });

  it('imports with warnings and passes them on', () => {
    const result = parseImport(JSON.stringify(file([{ id: 'c', type: 'click', config: { locator: '#go' } }])), []);
    expect(result.ok).toBe(true);
    expect(result.issues.map((issue) => issue.code)).toEqual(['page.no-tab']);
  });

  it('accepts Run Workflow calls to saved workflows', () => {
    const saved = { schemaVersion: 2, id: 'saved-1', name: 'Saved', enabled: false, nodes: [], edges: [] } as Workflow;
    const text = JSON.stringify(file([{ id: 'call', type: 'run-workflow', config: { workflow: 'saved-1' } }]));
    expect(parseImport(text, []).ok).toBe(false);
    expect(parseImport(text, [saved]).ok).toBe(true);
  });
});

describe('did-you-mean', () => {
  it('Damerau-Levenshtein counts a swap as one edit', () => {
    expect(editDistance('locator', 'locaotr')).toBe(1);
    expect(editDistance('locator', 'locater')).toBe(1);
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('', 'abc')).toBe(3);
  });

  it('suggests within 2 edits (1 for short words), case-insensitive', () => {
    expect(closest('Locatr', ['locator', 'url'])).toBe('locator');
    expect(closest('xyz', ['locator', 'url'])).toBeUndefined();
    expect(closest('ur', ['url', 'tab'])).toBe('url');
    expect(closest('tb', ['url'])).toBeUndefined();
  });
});
