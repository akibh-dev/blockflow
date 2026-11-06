import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../src/core/blocks';
import { LAYOUT_X, LAYOUT_Y, layoutGraph, layoutWorkflow } from '../../src/core/layout';
import type { Workflow } from '../../src/core/types';

const registry = createDefaultRegistry();

function workflow(nodes: [string, string][], edges: [string, string, string?][]): Workflow {
  return {
    schemaVersion: 2,
    id: 'w',
    name: 'W',
    enabled: false,
    nodes: nodes.map(([id, type]) => ({ id, type, position: { x: 999, y: 999 }, config: {} })),
    edges: edges.map(([source, target, sourcePort], index) => ({ id: `e${index}`, source, target, ...(sourcePort ? { sourcePort } : {}) })),
  };
}

/** "id@column,row" for every node. */
function grid(result: Workflow): string[] {
  return result.nodes.map((node) => `${node.id}@${node.position.x / LAYOUT_X},${node.position.y / LAYOUT_Y}`);
}

function noOverlaps(result: Workflow): void {
  const spots = result.nodes.map((node) => `${node.position.x},${node.position.y}`);
  expect(new Set(spots).size).toBe(spots.length);
}

describe('layout', () => {
  it('a chain is one straight row', () => {
    const result = layoutWorkflow(workflow([['a', 'log'], ['b', 'log'], ['c', 'log']], [['a', 'b'], ['b', 'c']]), registry);
    expect(grid(result)).toEqual(['a@0,0', 'b@1,0', 'c@2,0']);
  });

  it('If: true above false, the join one column after the longest branch', () => {
    const result = layoutWorkflow(
      workflow(
        [['j', 'log'], ['f', 'log'], ['i', 'if'], ['t1', 'log'], ['t2', 'log']],
        [['i', 'f', 'false'], ['i', 't1', 'true'], ['t1', 't2'], ['t2', 'j'], ['f', 'j']],
      ),
      registry,
    );
    expect(grid(result)).toEqual(['j@3,0', 'f@1,1', 'i@0,0', 't1@1,0', 't2@2,0']);
    noOverlaps(result);
  });

  it('loops: each above done, error outputs last', () => {
    const result = layoutWorkflow(
      workflow(
        [['l', 'for-each'], ['done', 'log'], ['body', 'log'], ['oops', 'notify']],
        [['l', 'done', 'done'], ['l', 'body', 'each'], ['body', 'oops', 'error']],
      ),
      registry,
    );
    expect(grid(result)).toEqual(['l@0,0', 'done@1,1', 'body@1,0', 'oops@2,0']);
  });

  it('several start blocks stack; cycles do not hang; nothing overlaps', () => {
    const result = layoutWorkflow(
      workflow(
        [['a', 'log'], ['b', 'log'], ['c', 'log'], ['d', 'log'], ['e', 'log']],
        [['a', 'c'], ['b', 'c'], ['c', 'd'], ['d', 'c'], ['b', 'e']],
      ),
      registry,
    );
    expect(grid(result).slice(0, 2)).toEqual(['a@0,0', 'b@0,1']);
    noOverlaps(result);
  });

  it('without a registry, ports are ordered by the built-in order', () => {
    const positions = layoutGraph(
      [{ id: 'i' }, { id: 'f' }, { id: 't' }],
      [
        { source: 'i', target: 'f', sourcePort: 'false' },
        { source: 'i', target: 't', sourcePort: 'true' },
      ],
      (edge) => (edge.sourcePort === 'true' ? 0 : 1),
    );
    expect(positions.get('t')).toEqual({ x: LAYOUT_X, y: 0 });
    expect(positions.get('f')).toEqual({ x: LAYOUT_X, y: LAYOUT_Y });
    expect(layoutWorkflow(workflow([['i', 'if'], ['f', 'log'], ['t', 'log']], [['i', 'f', 'false'], ['i', 't', 'true']])).nodes[2]?.position).toEqual({ x: LAYOUT_X, y: 0 });
  });

  it('a big random DAG has no overlaps and every edge points right', () => {
    const nodes: [string, string][] = Array.from({ length: 40 }, (_, index) => [`n${index}`, 'log']);
    const edges: [string, string][] = [];
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let index = 1; index < 40; index += 1) {
      edges.push([`n${Math.floor(random() * index)}`, `n${index}`]);
      if (random() < 0.3) edges.push([`n${Math.floor(random() * index)}`, `n${index}`]);
    }
    const result = layoutWorkflow(workflow(nodes, edges), registry);
    noOverlaps(result);
    const x = new Map(result.nodes.map((node) => [node.id, node.position.x]));
    for (const [source, target] of edges) expect(x.get(target)! > x.get(source)!).toBe(true);
  });
});
