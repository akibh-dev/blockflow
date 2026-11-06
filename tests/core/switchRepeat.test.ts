import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../src/core/blocks';
import { casePorts, switchBlock } from '../../src/core/blocks/switchBlock';
import { checkFile } from '../../src/core/check';
import { LAYOUT_Y, layoutWorkflow } from '../../src/core/layout';
import { declaredPorts, hasDynamicPorts, nodePorts } from '../../src/core/ports';
import { compileScript, decompile } from '../../src/core/script';
import { validateWorkflow } from '../../src/core/validate';
import type { Workflow } from '../../src/core/types';
import { flow, harness } from '../helpers/fakeHost';

const registry = createDefaultRegistry();

const cases = [
  { port: 'ok', operator: 'equals', value: '200' },
  { port: 'missing', operator: 'equals', value: '404' },
  { port: 'server', operator: 'matches', value: '/^5/' },
];

/** Start (with `status`) → Switch → one Log per output. */
function switchFlow(status: string, extra: Record<string, unknown> = {}) {
  return flow(
    [
      { id: 'set', type: 'set-variable', config: { name: 'status', value: status } },
      { id: 'sw', type: 'switch', config: { value: '{{status}}', cases, ...extra } },
      { id: 'ok', type: 'log', config: { message: 'went ok' } },
      { id: 'missing', type: 'log', config: { message: 'went missing' } },
      { id: 'server', type: 'log', config: { message: 'went server' } },
      { id: 'other', type: 'log', config: { message: 'went default' } },
    ],
    [['set', 'sw'], ['sw', 'ok', 'ok'], ['sw', 'missing', 'missing'], ['sw', 'server', 'server'], ['sw', 'other', 'default']],
  );
}

describe('dynamic ports', () => {
  it('Switch has one output per case, then default; nodePorts reads the node config', () => {
    expect(hasDynamicPorts(switchBlock)).toBe(true);
    expect(hasDynamicPorts(registry.get('if'))).toBe(false);
    expect(nodePorts(switchBlock, { config: { cases } })).toEqual(['ok', 'missing', 'server', 'default']);
    expect(nodePorts(switchBlock, { config: { cases }, step: { onError: 'port' } })).toEqual(['ok', 'missing', 'server', 'default', 'error']);
    // No config: the default config's cases.
    expect(nodePorts(switchBlock, {})).toEqual(['first', 'second', 'default']);
    expect(nodePorts(switchBlock, { config: { cases: [] } })).toEqual(['default']);
  });

  it('a nameless, invalid, reserved or repeated case keeps a stand-in output case<N>', () => {
    expect(casePorts({ cases: [{ port: 'a' }, { port: '' }, { port: 'a' }, { port: 'two words' }, { port: 'error' }, { port: 'case2' }] as never })).toEqual([
      'a',
      'case2_2',
      'case3',
      'case4',
      'case5',
      'case2',
    ]);
  });

  it('declaredPorts never returns "error", duplicates or nothing, and survives a throwing ports()', () => {
    const def = { ...switchBlock, ports: () => ['x', 'x', 'error', ''] };
    expect(declaredPorts(def, {})).toEqual(['x']);
    expect(declaredPorts({ ...switchBlock, ports: () => [] }, {})).toEqual(['out']);
    expect(declaredPorts({ ...switchBlock, ports: () => { throw new Error('bad'); } }, {})).toEqual(['out']);
  });
});

describe('Switch block', () => {
  it.each([
    ['200', 'went ok'],
    ['404', 'went missing'],
    ['503', 'went server'],
    ['302', 'went default'],
  ])('status %s takes the first matching case', async (status, message) => {
    const h = harness(switchFlow(status));
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(h.messages('info').filter((m) => m.startsWith('went '))).toEqual([message]);
  });

  it('first match wins when several cases match', async () => {
    const h = harness(switchFlow('200', { cases: [{ port: 'any', operator: 'not-empty', value: '' }, ...cases] }));
    // "ok" is not connected from "any"; nothing else runs.
    const run = await h.runner.runOnce();
    expect(run.steps.find((step) => step.nodeId === 'sw')?.port).toBe('any');
    expect(h.messages('info').filter((m) => m.startsWith('went '))).toEqual([]);
  });

  it('validate: names must be valid and unique, operators known', () => {
    const problems = switchBlock.validate?.({
      value: 'x',
      cases: [
        { port: 'ok', operator: 'equals', value: '' },
        { port: 'ok', operator: 'equals', value: '' },
        { port: 'default', operator: 'equals', value: '' },
        { port: '9lives', operator: 'equals', value: '' },
        { port: 'fine', operator: 'is', value: '' },
      ],
    });
    expect(problems?.map((problem) => problem.message)).toEqual([
      'Case 2: output name "ok" is used twice',
      'Case 3 output name "default" is reserved',
      'Case 4 output name "9lives" must start with a letter and use only letters, digits, "_" and "-" (at most 40)',
      expect.stringMatching(/^Case 5 has an unknown condition "is"/),
    ]);
  });

  it('check: an edge from a port the cases do not have is edge.port.unknown, with did-you-mean over the real cases', () => {
    const raw = {
      name: 'T',
      nodes: [
        { id: 'sw', type: 'switch', config: { value: '{{status}}', cases } },
        { id: 'a', type: 'log', config: { message: 'a' } },
        { id: 'b', type: 'log', config: { message: 'b' } },
      ],
      edges: [
        { id: 'e1', source: 'sw', target: 'a', sourcePort: 'mising' },
        { id: 'e2', source: 'sw', target: 'b', sourcePort: 'default' },
      ],
    };
    const issues = checkFile(raw, registry);
    expect(issues.filter((issue) => issue.level === 'error')).toEqual([
      expect.objectContaining({ code: 'edge.port.unknown', path: '/edges/0/sourcePort', message: 'Block "sw" (switch) has no output "mising".', hint: 'Did you mean "missing"?' }),
    ]);
  });

  it('check: bad case settings point at config/cases', () => {
    const issues = checkFile({ name: 'T', nodes: [{ id: 'sw', type: 'switch', config: { cases: [{ port: 'out', operator: 'equals', value: '' }] } }], edges: [] }, registry);
    expect(issues.filter((issue) => issue.level === 'error')).toEqual([expect.objectContaining({ code: 'config.value', path: '/nodes/0/config/cases' })]);
  });

  it('validateWorkflow (editor) warns about a connection from a case that is gone', () => {
    const workflow = switchFlow('200', { cases: cases.slice(0, 2) });
    const issues = validateWorkflow(workflow, registry);
    expect(issues).toEqual([expect.objectContaining({ level: 'warning', edgeId: 'sw-server-server', message: 'The "server" output is not in use, so its connection never runs' })]);
  });

  it('layout puts case branches in case order, default last', () => {
    const workflow = switchFlow('x', { cases: [cases[2], cases[0], cases[1]] });
    const laid = layoutWorkflow(workflow, registry);
    const row = (id: string) => (laid.nodes.find((node) => node.id === id)?.position.y ?? NaN) / LAYOUT_Y;
    expect([row('server'), row('ok'), row('missing'), row('other')]).toEqual([...[row('server'), row('ok'), row('missing'), row('other')]].sort((a, b) => a - b));
    expect(new Set([row('server'), row('ok'), row('missing'), row('other')]).size).toBe(4);
  });
});

describe('Switch in scripts', () => {
  const script = (steps: unknown[]) => compileScript({ format: 'blockflow-script', version: 1, name: 'T', steps }, registry);
  const wiring = (workflow: Workflow | undefined) =>
    (workflow?.edges ?? []).map((edge) => `${edge.source}${edge.sourcePort ? `:${edge.sourcePort}` : ''}>${edge.target}`).sort();

  it('branch keys are case names; branches rejoin like If, and a case without a list falls through', () => {
    const result = script([
      { id: 'sw', switch: { value: '{{status}}', cases }, ok: [{ id: 'a', log: 'ok' }], server: [{ id: 'b', log: '5xx' }, { id: 'c', log: 'again' }] },
      { id: 'after', log: 'after' },
    ]);
    expect(result.issues).toEqual([]);
    expect(wiring(result.workflow)).toEqual(['a>after', 'b>c', 'c>after', 'sw:default>after', 'sw:missing>after', 'sw:ok>a', 'sw:server>b']);
  });

  it('an unknown branch key is edge.port.unknown with a suggestion from the cases', () => {
    const result = script([{ switch: { cases }, sever: [{ log: 'x' }] }]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'edge.port.unknown',
        path: '/steps/0/sever',
        message: '"switch" has no output "sever". Its branch keys: "ok", "missing", "server", "default", "onError".',
        hint: 'Did you mean "server"?',
      }),
    ]);
  });

  it('decompiles and compiles back to the same graph', () => {
    const compiled = script([
      { id: 'sw', switch: { value: '{{status}}', cases }, ok: [{ id: 'a', log: 'ok' }], default: [{ id: 'd', log: 'other' }] },
      { id: 'after', log: 'after' },
    ]).workflow as Workflow;
    const back = decompile(compiled, registry);
    expect(back?.steps).toEqual([
      { id: 'sw', switch: { value: '{{status}}', cases }, ok: [{ id: 'a', log: 'ok' }], default: [{ id: 'd', log: 'other' }] },
      { id: 'after', log: 'after' },
    ]);
  });
});

describe('Repeat until / while', () => {
  /** Repeat → (each) Set Variable n = iteration*10 ; (done) Log iterations. */
  const repeatFlow = (config: Record<string, unknown>) =>
    flow(
      [
        { id: 'r', type: 'repeat', config },
        { id: 'n', type: 'set-variable', config: { name: 'n', value: '{{iteration * 10}}' } },
        { id: 'each', type: 'log', config: { message: 'each {{iteration}} n={{n}}' } },
        { id: 'done', type: 'log', config: { message: 'done {{iterations}}{{n ? " n=" + n : ""}}' } },
      ],
      [['r', 'n', 'each'], ['n', 'each'], ['r', 'done', 'done']],
    );
  const lines = (h: ReturnType<typeof harness>) => h.messages('info').filter((m) => /^(each|done) /.test(m));

  it('times still works (no mode = times) and done gets iterations', async () => {
    const h = harness(repeatFlow({ times: 2 }));
    await h.runner.runOnce();
    expect(lines(h)).toEqual(['each 1 n=10', 'each 2 n=20', 'done 2']);
  });

  it('until checks after each round, against the data the round ended with; done carries it', async () => {
    const h = harness(repeatFlow({ mode: 'until', left: '{{n}}', operator: 'greater-equal', right: '30' }));
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(lines(h)).toEqual(['each 1 n=10', 'each 2 n=20', 'each 3 n=30', 'done 3 n=30']);
  });

  it('until runs at least once', async () => {
    const h = harness(repeatFlow({ mode: 'until', left: 'yes', operator: 'true', right: '' }));
    await h.runner.runOnce();
    expect(lines(h)).toEqual(['each 1 n=10', 'done 1 n=10']);
  });

  it('while checks before each round and may run zero times', async () => {
    const h = harness(repeatFlow({ mode: 'while', left: '{{iteration}}', operator: 'less', right: '2' }));
    await h.runner.runOnce();
    expect(lines(h)).toEqual(['each 1 n=10', 'each 2 n=20', 'done 2 n=20']);
    const none = harness(repeatFlow({ mode: 'while', left: '', operator: 'not-empty', right: '' }));
    await none.runner.runOnce();
    expect(lines(none)).toEqual(['done 0']);
  });

  it('max: fails by default, or continues from done with failAtMax off', async () => {
    const h = harness(repeatFlow({ mode: 'until', left: 'never', operator: 'equals', right: 'x', max: 2 }));
    const run = await h.runner.runOnce();
    expect(run.status).toBe('failed');
    expect(run.error).toBe('Repeat: Repeat until: the condition was still false after 2 times');
    expect(lines(h)).toEqual(['each 1 n=10', 'each 2 n=20']);

    const soft = harness(repeatFlow({ mode: 'while', left: 'yes', operator: 'true', right: '', max: 3, failAtMax: false }));
    const ok = await soft.runner.runOnce();
    expect(ok.status).toBe('passed');
    expect(lines(soft)).toEqual(['each 1 n=10', 'each 2 n=20', 'each 3 n=30', 'done 3 n=30']);
    expect(soft.messages('warn')).toContain('Stopped: the condition still held after 3 times');
  });

  it('with nothing on "each", the condition sees the round input (iteration)', async () => {
    const h = harness(
      flow(
        [
          { id: 'r', type: 'repeat', config: { mode: 'until', left: '{{iteration}}', operator: 'equals', right: '4' } },
          { id: 'done', type: 'log', config: { message: 'done {{iterations}}' } },
        ],
        [['r', 'done', 'done']],
      ),
    );
    await h.runner.runOnce();
    expect(lines(h)).toEqual(['done 4']);
  });

  it('a script can use until (scripts keep the shorthand for times)', () => {
    const result = compileScript(
      { steps: [{ repeat: { mode: 'until', left: '{{count}}', operator: 'greater-equal', right: '50', max: 20 }, each: [{ click: 'text=Load more' }] }, { log: 'x' }] },
      registry,
    );
    expect(result.issues).toEqual([]);
    expect(checkFile(result.workflow, registry).filter((issue) => issue.level === 'error')).toEqual([]);
    const short = compileScript({ steps: [{ repeat: 3, each: [{ log: '{{iteration}}' }] }] }, registry);
    expect(short.workflow?.nodes[0]?.config).toMatchObject({ mode: 'times', times: 3 });
  });
});
