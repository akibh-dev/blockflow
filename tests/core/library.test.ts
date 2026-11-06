import { describe, expect, it } from 'vitest';
import { cloneWorkflow, duplicateWorkflow, exportWorkflows, parseImport, uniqueName } from '../../src/core/library';
import { flow } from '../helpers/fakeHost';

const sample = () =>
  flow(
    [
      { id: 'a', type: 'timer', config: { seconds: 30 } },
      { id: 'b', type: 'open-url', config: { url: 'https://example.com' } },
    ],
    [['a', 'b']],
  );

describe('uniqueName', () => {
  it('adds a number only when needed, ignoring case', () => {
    expect(uniqueName('Foo', ['Bar'])).toBe('Foo');
    expect(uniqueName('Foo', ['foo'])).toBe('Foo 2');
    expect(uniqueName('Foo', ['Foo', 'Foo 2'])).toBe('Foo 3');
    expect(uniqueName('  ', [])).toBe('Untitled workflow');
  });
});

describe('cloneWorkflow / duplicateWorkflow', () => {
  it('gives new ids, remaps connections, switches off, and does not share config', () => {
    const original = sample();
    const copy = cloneWorkflow(original, 'Copy');
    expect(copy.id).not.toBe(original.id);
    expect(copy.enabled).toBe(false);
    expect(copy.nodes.map((n) => n.id)).not.toContain('a');
    const [edge] = copy.edges;
    expect(copy.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([edge?.source, edge?.target]));
    (copy.nodes[0]?.config as Record<string, unknown>).seconds = 99;
    expect(original.nodes[0]?.config.seconds).toBe(30);
  });

  it('names the duplicate "<name> copy"', () => {
    const original = sample();
    expect(duplicateWorkflow(original, [original]).name).toBe(`${original.name} copy`);
  });
});

describe('export / import', () => {
  it('round-trips and never imports as enabled', () => {
    const original = sample();
    const result = parseImport(exportWorkflows([original]), [original]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [imported] = result.workflows;
    expect(imported?.enabled).toBe(false);
    expect(imported?.id).not.toBe(original.id);
    expect(imported?.name).toBe(`${original.name} 2`);
    expect(imported?.nodes.map((n) => n.type)).toEqual(['timer', 'open-url']);
    expect(imported?.edges).toHaveLength(1);
  });

  it('accepts a single bare workflow', () => {
    expect(parseImport(JSON.stringify(sample()), []).ok).toBe(true);
  });

  it('rejects junk with a readable error', () => {
    const junk = parseImport('nope', []);
    expect(junk.ok).toBe(false);
    expect(!junk.ok && junk.error).toMatch(/^This file is not valid JSON: /);
    expect(junk.issues.map((issue) => issue.code)).toEqual(['json.invalid']);
    expect(parseImport('{"a":1}', []).ok).toBe(false);
    expect(parseImport('{"nodes":[{"id":1}],"edges":[]}', []).ok).toBe(false);
    expect(parseImport('{"workflows":[]}', []).ok).toBe(false);
  });

  it('rejects connections that point at missing blocks, and duplicate block ids', () => {
    const wf = sample();
    wf.edges.push({ id: 'x', source: 'a', target: 'ghost' });
    expect(parseImport(JSON.stringify(wf), [])).toEqual({
      ok: false,
      error: 'A connection\'s target "ghost" is not a block id.',
      issues: [{ level: 'error', code: 'edge.endpoint.missing', path: '/edges/1/target', message: 'A connection\'s target "ghost" is not a block id.', hint: 'Block ids: a, b.' }],
    });
    const twice = sample();
    twice.nodes.push({ ...twice.nodes[0]!, config: {} });
    const refused = parseImport(JSON.stringify(twice), []);
    expect(!refused.ok && refused.error).toBe('Two blocks have the id "a".');
    expect(refused.issues.map((issue) => [issue.code, issue.path])).toEqual([['node.id.duplicate', '/nodes/2/id']]);
    expect(parseImport(JSON.stringify({ ...sample(), edges: [{ source: 'a' }] }), []).ok).toBe(false);
  });

  it('keeps step settings and output ports (If false, error outputs) through import and duplicate', () => {
    const wf = flow(
      [
        { id: 'if', type: 'if', config: { left: '1', operator: 'equals', right: '2' } },
        { id: 'yes', type: 'log', config: { message: 'yes' } },
        { id: 'no', type: 'log', config: { message: 'no' }, step: { retries: 2, onError: 'port', note: 'n' } },
        { id: 'oops', type: 'log', config: { message: 'oops' } },
      ],
      [],
    );
    wf.edges = [
      { id: 'e1', source: 'if', target: 'yes', sourcePort: 'true' },
      { id: 'e2', source: 'if', target: 'no', sourcePort: 'false' },
      { id: 'e3', source: 'no', target: 'oops', sourcePort: 'error' },
    ];
    const check = (copy: typeof wf) => {
      const byOldId = (old: string) => copy.nodes[wf.nodes.findIndex((n) => n.id === old)]!.id;
      expect(copy.edges.map((e) => [e.source, e.target, e.sourcePort])).toEqual([
        [byOldId('if'), byOldId('yes'), 'true'],
        [byOldId('if'), byOldId('no'), 'false'],
        [byOldId('no'), byOldId('oops'), 'error'],
      ]);
      expect(copy.nodes.find((n) => n.id === byOldId('no'))?.step).toEqual({ retries: 2, onError: 'port', note: 'n' });
    };
    check(duplicateWorkflow(wf, [wf]));
    const imported = parseImport(exportWorkflows([wf]), []);
    expect(imported.ok).toBe(true);
    if (imported.ok) check(imported.workflows[0]!);
    // The copy does not share step objects with the original.
    const copy = duplicateWorkflow(wf, [wf]);
    copy.nodes[2]!.step!.retries = 5;
    expect(wf.nodes[2]!.step!.retries).toBe(2);
  });

  it('keeps Run Workflow blocks pointing at workflows imported with them', () => {
    const callee = sample();
    const caller = flow([{ id: 'c', type: 'run-workflow', config: { workflow: callee.id } }], []);
    const result = parseImport(exportWorkflows([callee, caller]), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [newCallee, newCaller] = result.workflows;
    expect(newCaller?.nodes[0]?.config.workflow).toBe(newCallee?.id);
  });
});
