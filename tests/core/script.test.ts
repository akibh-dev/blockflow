import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../src/core/blocks';
import { parseImport } from '../../src/core/library';
import { compileScript, compileScriptFile, decompile, didYouMean, isScriptFile, sameScriptGraph } from '../../src/core/script';
import type { Workflow } from '../../src/core/types';

const registry = createDefaultRegistry();

function compile(steps: unknown[], extra: Record<string, unknown> = {}) {
  return compileScript({ format: 'blockflow-script', version: 1, name: 'T', steps, ...extra }, registry);
}

/** Edges as "source:port>target" (port "out" written as nothing), sorted. */
function wiring(workflow: Workflow | undefined): string[] {
  return (workflow?.edges ?? []).map((edge) => `${edge.source}${edge.sourcePort ? `:${edge.sourcePort}` : ''}>${edge.target}`).sort();
}

describe('compileScript', () => {
  it('chains steps, fills defaults and resolves aliases and shorthands', () => {
    const result = compile([
      { open: 'https://example.com' },
      { click: 'text=Save' },
      { fill: { locator: 'label=Name', value: 'Ada' } },
      { press: 'Enter' },
      { log: 'done' },
    ]);
    expect(result.issues).toEqual([]);
    const workflow = result.workflow as Workflow;
    expect(workflow.nodes.map((node) => `${node.id}:${node.type}`)).toEqual(['s1:open-url', 's2:click', 's3:fill', 's4:press-key', 's5:log']);
    expect(workflow.nodes[0]?.config).toMatchObject({ url: 'https://example.com', tab: 'main', waitUntil: 'load' });
    expect(workflow.nodes[1]?.config).toMatchObject({ locator: 'text=Save', action: 'click' });
    expect(workflow.nodes[3]?.config.key).toBe('Enter');
    expect(workflow.nodes[4]?.config.message).toBe('done');
    expect(wiring(workflow)).toEqual(['s1>s2', 's2>s3', 's3>s4', 's4>s5']);
    expect(workflow.nodes.every((node) => node.origin === node.id)).toBe(true);
    expect(workflow.enabled).toBe(false);
    expect(workflow.schemaVersion).toBe(2);
  });

  it('If rejoins: the next step follows the end of each branch, and a port without a list', () => {
    const result = compile([
      { id: 'check', if: { left: '{{x}}', operator: 'equals', right: '1' }, true: [{ id: 'a', log: 'a' }, { id: 'b', log: 'b' }] },
      { id: 'after', log: 'after' },
    ]);
    expect(result.issues).toEqual([]);
    expect(wiring(result.workflow)).toEqual(['a>b', 'b>after', 'check:false>after', 'check:true>a']);
  });

  it('If with both branches and nested If rejoins at the outer next step', () => {
    const result = compile([
      {
        id: 'outer',
        if: {},
        true: [{ id: 'inner', if: {}, true: [{ id: 'a', log: 'a' }], false: [{ id: 'b', log: 'b' }] }],
        false: [{ id: 'c', log: 'c' }],
      },
      { id: 'd', log: 'd' },
    ]);
    expect(wiring(result.workflow)).toEqual(['a>d', 'b>d', 'c>d', 'inner:false>b', 'inner:true>a', 'outer:false>c', 'outer:true>inner']);
  });

  it('loops: "each" is a body that does not continue; the next step follows "done"', () => {
    const result = compile([
      { id: 'loop', 'for-each': 'rows', each: [{ id: 'body', log: '{{item}}' }] },
      { id: 'end', log: 'end' },
    ]);
    expect(result.workflow?.nodes[0]?.config).toMatchObject({ list: 'rows', as: 'item' });
    expect(wiring(result.workflow)).toEqual(['loop:done>end', 'loop:each>body']);
  });

  it('onError list wires the error port and sets step.onError', () => {
    const result = compile([
      { id: 'a', assert: { expected: 'x' }, step: { retries: 1 }, onError: [{ id: 'n', notify: '{{error}}' }] },
      { id: 'b', log: 'ok' },
    ]);
    expect(result.issues).toEqual([]);
    expect(result.workflow?.nodes[0]?.step).toEqual({ retries: 1, onError: 'port' });
    expect(wiring(result.workflow)).toEqual(['a:error>n', 'a>b']);
  });

  it('records the JSON Pointer of every step and config', () => {
    const result = compile([{ id: 'x', if: {}, true: [{ click: 'a' }] }]);
    expect(result.nodePaths).toEqual({ x: '/steps/0', s2: '/steps/0/true/0' });
    expect(result.configPaths).toEqual({ x: '/steps/0/if', s2: '/steps/0/true/0/click' });
  });

  it('generated ids count steps top to bottom and avoid author ids', () => {
    const result = compile([{ log: 'a' }, { id: 's1', log: 'b' }, { log: 'c' }]);
    expect(result.workflow?.nodes.map((node) => node.id)).toEqual(['s1-2', 's1', 's3']);
  });

  it('moves old key names (migrate.ts) before filling defaults', () => {
    const result = compile([{ 'read-element': { selector: '.price', url: 'https://x.dev' } }]);
    expect(result.workflow?.nodes[0]?.config.locator).toBe('.price');
    expect(result.workflow?.nodes[0]?.config).not.toHaveProperty('selector');
  });

  describe('issues', () => {
    const codes = (raw: unknown) => compileScript(raw, registry).issues.map((issue) => [issue.code, issue.path]);

    it('script shape and version', () => {
      expect(codes([])).toEqual([['script.shape', '']]);
      expect(codes({ format: 'blockflow-script' })).toEqual([['script.shape', '/steps']]);
      expect(codes({ format: 'blockflow-script', version: 2, steps: [{ log: 'x' }] })).toEqual([['script.version', '/version']]);
      expect(compileScript({ steps: [] }, registry).issues).toMatchObject([{ code: 'script.empty', level: 'warning' }]);
    });

    it('unknown block with did-you-mean', () => {
      const result = compile([{ open: 'https://x.dev' }, { clik: 'text=Go' }]);
      expect(result.workflow).toBeUndefined();
      expect(result.issues).toEqual([
        { level: 'error', code: 'node.type.unknown', path: '/steps/1/clik', message: 'Unknown block "clik".', hint: 'Did you mean "click"?' },
      ]);
      expect(compile([{ 'open-ulr': 'x' }]).issues[0]?.hint).toBe('Did you mean "open-url"?');
    });

    it('step shape: none or two blocks, bad settings, bad shorthand', () => {
      expect(compile([{ id: 'a' }]).issues.map((issue) => issue.code)).toEqual(['step.shape']);
      expect(compile([{ click: 'a', log: 'b' }]).issues.map((issue) => [issue.code, issue.path])).toEqual([['step.shape', '/steps/0']]);
      expect(compile(['click']).issues[0]?.code).toBe('step.shape');
      expect(compile([{ assert: 'text' }]).issues.map((issue) => [issue.code, issue.path])).toEqual([['step.shape', '/steps/0/assert']]);
      expect(compile([{ log: 'a', step: 3 }]).issues.map((issue) => [issue.code, issue.path])).toEqual([['step.shape', '/steps/0/step']]);
    });

    it('duplicate ids', () => {
      expect(compile([{ id: 'a', log: 'x' }, { id: 'a', log: 'y' }]).issues.map((issue) => [issue.code, issue.path])).toEqual([['node.id.duplicate', '/steps/1/id']]);
    });

    it('branch keys that are not ports, or the continue port', () => {
      const result = compile([{ if: {}, ture: [{ log: 'x' }] }]);
      expect(result.issues.map((issue) => [issue.code, issue.path, issue.hint])).toEqual([['edge.port.unknown', '/steps/0/ture', 'Did you mean "true"?']]);
      expect(compile([{ log: 'x', true: [] }]).issues[0]?.code).toBe('edge.port.unknown');
      expect(compile([{ repeat: 2, done: [{ log: 'x' }] }]).issues.map((issue) => issue.code)).toEqual(['step.branch.next']);
      expect(compile([{ log: 'x', step: { onError: 'continue' }, onError: [{ log: 'y' }] }]).issues.map((issue) => issue.code)).toEqual(['step.onError.conflict']);
    });

    it('nested paths', () => {
      const result = compile([{ 'for-each': 'items', each: [{ log: 'ok' }, { nope: 1 }] }]);
      expect(result.issues.map((issue) => issue.path)).toEqual(['/steps/0/each/1/nope']);
    });
  });
});

describe('compileScriptFile', () => {
  it('several scripts, with paths under /scripts/N', () => {
    const file = { format: 'blockflow-script', version: 1, scripts: [{ name: 'A', steps: [{ log: 'a' }] }, { name: 'B', steps: [{ lgo: 'b' }] }] };
    const result = compileScriptFile(file, registry);
    expect(result.scripts).toHaveLength(2);
    expect(result.scripts[0]?.workflow?.name).toBe('A');
    expect(result.issues.map((issue) => issue.path)).toEqual(['/scripts/1/steps/0/lgo']);
  });
});

describe('isScriptFile / parseImport', () => {
  it('detects scripts', () => {
    expect(isScriptFile({ format: 'blockflow-script' })).toBe(true);
    expect(isScriptFile({ steps: [] })).toBe(true);
    expect(isScriptFile({ nodes: [], edges: [] })).toBe(false);
  });

  it('imports a script: fresh ids, origin kept, laid out, off', () => {
    const text = JSON.stringify({ format: 'blockflow-script', version: 1, name: 'Mine', steps: [{ id: 'go', open: 'https://x.dev' }, { log: 'hi' }] });
    const result = parseImport(text, [{ schemaVersion: 2, id: 'x', name: 'Mine', enabled: false, nodes: [], edges: [] }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [workflow] = result.workflows;
    expect(workflow?.name).toBe('Mine 2');
    expect(workflow?.nodes.map((node) => node.origin)).toEqual(['go', 's2']);
    expect(workflow?.nodes.map((node) => node.position)).toEqual([{ x: 0, y: 0 }, { x: 260, y: 0 }]);
    expect(workflow?.nodes[0]?.id).not.toBe('go');
    expect(workflow?.edges).toHaveLength(1);
  });

  it('reports script errors with paths', () => {
    const result = parseImport(JSON.stringify({ format: 'blockflow-script', version: 1, steps: [{ clik: 'x' }] }), []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Unknown block "clik"');
    expect(result.issues[0]).toMatchObject({ code: 'node.type.unknown', path: '/steps/0/clik', hint: expect.stringContaining('Did you mean "click"?') });
  });

  it('Run Workflow can name another script of the file by id or name', () => {
    const text = JSON.stringify({
      format: 'blockflow-script',
      version: 1,
      scripts: [
        { id: 'login', name: 'Log in', steps: [{ log: 'in' }] },
        { name: 'Test', steps: [{ 'run-workflow': 'login' }, { 'run-workflow': 'Log in' }] },
      ],
    });
    const result = parseImport(text, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [login, test] = result.workflows;
    expect(test?.nodes.map((node) => node.config.workflow)).toEqual([login?.id, login?.id]);
  });

  it('lays out graph files written without positions', () => {
    const text = JSON.stringify({ name: 'G', nodes: [{ id: 'a', type: 'log', config: {} }, { id: 'b', type: 'log', config: {} }], edges: [{ source: 'a', target: 'b' }] });
    const result = parseImport(text, []);
    expect(result.ok && result.workflows[0]?.nodes.map((node) => node.position)).toEqual([{ x: 0, y: 0 }, { x: 260, y: 0 }]);
  });
});

describe('decompile', () => {
  const graph = (nodes: [string, string, Record<string, unknown>?][], edges: [string, string, string?][]): Workflow => ({
    schemaVersion: 2,
    id: 'w',
    name: 'W',
    enabled: false,
    nodes: nodes.map(([id, type, config]) => ({ id, type, position: { x: 0, y: 0 }, config: config ?? {} })),
    edges: edges.map(([source, target, sourcePort], index) => ({ id: `e${index}`, source, target, ...(sourcePort ? { sourcePort } : {}) })),
  });

  it('uses aliases, shorthands and drops default values', () => {
    const script = decompile(graph([['a', 'open-url', { url: 'https://x.dev', tab: 'main' }], ['b', 'click', { locator: 'text=Go', action: 'click' }]], [['a', 'b']]), registry);
    expect(script?.steps).toEqual([{ id: 'a', open: 'https://x.dev' }, { id: 'b', click: 'text=Go' }]);
  });

  it('writes an If join as the step after the If', () => {
    const workflow = graph(
      [['i', 'if'], ['t', 'log'], ['f', 'log'], ['j', 'log']],
      [['i', 't', 'true'], ['i', 'f', 'false'], ['t', 'j'], ['f', 'j']],
    );
    const script = decompile(workflow, registry);
    expect(script?.steps.map((step) => step.id)).toEqual(['i', 'j']);
    expect(script?.steps[0]).toMatchObject({ true: [{ id: 't' }], false: [{ id: 'f' }] });
    const back = compileScript(script, registry).workflow as Workflow;
    expect(sameScriptGraph(workflow, back, registry)).toBe(true);
  });

  it('If without else falls through', () => {
    const script = decompile(graph([['i', 'if'], ['t', 'log'], ['j', 'log']], [['i', 't', 'true'], ['i', 'j', 'false'], ['t', 'j']]), registry);
    expect(script?.steps.map((step) => step.id)).toEqual(['i', 'j']);
    expect(script?.steps[0]).not.toHaveProperty('false');
  });

  it('drops ids a compile would generate, and uuids', () => {
    const script = decompile(graph([['s1', 'log'], ['0f8fad5b-d9cb-469f-a165-70867728950e', 'log'], ['keep', 'log']], [['s1', '0f8fad5b-d9cb-469f-a165-70867728950e'], ['0f8fad5b-d9cb-469f-a165-70867728950e', 'keep']]), registry);
    expect(script?.steps.map((step) => step.id)).toEqual([undefined, undefined, 'keep']);
  });

  it('returns null for graphs that are not a list of steps', () => {
    expect(decompile(graph([['a', 'log'], ['b', 'log']], []), registry)).toBeNull(); // two starts
    expect(decompile(graph([['a', 'log'], ['b', 'log'], ['c', 'log']], [['a', 'b'], ['a', 'c']]), registry)).toBeNull(); // fan-out
    expect(decompile(graph([['a', 'log'], ['b', 'log']], [['a', 'b'], ['b', 'a']]), registry)).toBeNull(); // cycle
    // A join that is not after an If: an each-body end feeding the step after the loop.
    expect(decompile(graph([['l', 'repeat'], ['b', 'log'], ['n', 'log']], [['l', 'b', 'each'], ['l', 'n', 'done'], ['b', 'n']]), registry)).toBeNull();
    expect(decompile(graph([['a', 'nope']], []), registry)).toBeNull();
  });

  it('an empty workflow is an empty script', () => {
    expect(decompile(graph([], []), registry)?.steps).toEqual([]);
  });
});

describe('didYouMean', () => {
  it('finds close words (transpositions count once)', () => {
    expect(didYouMean('clcik', ['click', 'check'])).toBe('click');
    expect(didYouMean('xyz', ['click'])).toBeUndefined();
    expect(didYouMean('for_each', ['for-each'])).toBe('for-each');
  });
});

describe('strict check of scripts (check.ts through parseImport)', () => {
  const script = (steps: unknown[]) => JSON.stringify({ format: 'blockflow-script', version: 1, name: 'S', steps });
  const issuesOf = (text: string) => {
    const result = parseImport(text, []);
    return result.issues.map((issue) => `${issue.level} ${issue.code} ${issue.path}`);
  };

  it('points config problems at the step\'s block key', () => {
    expect(issuesOf(script([{ open: 'https://a.test' }, { click: { locater: 'text=Go' } }]))).toContain('error config.key.unknown /steps/1/click/locater');
  });

  it('points a bad shorthand value at the shorthand itself', () => {
    expect(issuesOf(script([{ open: 'not a url' }]))).toContain('error config.url.invalid /steps/0/open');
  });

  it('points step settings and nested branches at the right step', () => {
    const issues = issuesOf(
      script([
        { open: 'https://a.test' },
        { if: { left: '1', operator: 'equals', right: '1' }, true: [{ click: 'text=A', step: { retrys: 2 } }] },
      ]),
    );
    expect(issues).toContain('error step.key.unknown /steps/1/true/0/step/retrys');
  });

  it('uses /scripts/N paths in a file with several scripts, and knows called scripts get their tabs from the caller', () => {
    const text = JSON.stringify({
      format: 'blockflow-script',
      version: 1,
      scripts: [
        { id: 'main', name: 'Main', steps: [{ open: 'https://a.test' }, { 'run-workflow': 'login' }] },
        { id: 'login', name: 'Login', steps: [{ click: 'text=Sign in' }, { fill: { locator: 'label=Email', valeu: 'x' } }] },
      ],
    });
    const issues = issuesOf(text);
    expect(issues).toContain('error config.key.unknown /scripts/1/steps/1/fill/valeu');
    expect(issues.filter((issue) => issue.includes('page.no-tab'))).toEqual([]);
  });

  it('warns about a page step with no tab, at that step', () => {
    expect(issuesOf(script([{ click: 'text=Go' }]))).toContain('warning page.no-tab /steps/0');
  });
});
