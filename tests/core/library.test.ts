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
    expect(parseImport('nope', [])).toEqual({ ok: false, error: 'This file is not valid JSON.' });
    expect(parseImport('{"a":1}', []).ok).toBe(false);
    expect(parseImport('{"nodes":[{"id":1}],"edges":[]}', []).ok).toBe(false);
    expect(parseImport('{"workflows":[]}', []).ok).toBe(false);
  });

  it('drops connections that point at missing blocks', () => {
    const wf = sample();
    wf.edges.push({ id: 'x', source: 'a', target: 'ghost' });
    const result = parseImport(JSON.stringify(wf), []);
    expect(result.ok && result.workflows[0]?.edges).toHaveLength(1);
  });
});
