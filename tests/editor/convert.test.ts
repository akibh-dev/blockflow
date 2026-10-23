import { describe, expect, it } from 'vitest';
import { fromFlow, sameGraph, toFlow } from '../../src/entrypoints/editor/flow/convert';
import { sampleWorkflows } from '../../src/core/samples';
import type { Workflow } from '../../src/core/types';

describe('workflow ⇄ canvas conversion', () => {
  it('round-trips a workflow without losing anything', () => {
    for (const workflow of sampleWorkflows()) {
      const { nodes, edges } = toFlow(workflow);
      expect(fromFlow(workflow, nodes, edges)).toEqual(workflow);
    }
  });

  it('maps blocks to canvas nodes carrying the block type and settings', () => {
    const [workflow] = sampleWorkflows();
    const { nodes, edges } = toFlow(workflow!);
    expect(nodes.map((node) => node.type)).toEqual(['block', 'block']);
    expect(nodes[0]!.data).toEqual({ blockType: 'timer', config: { seconds: 300, repeat: true } });
    expect(edges).toHaveLength(1);
  });

  it('rounds positions and ignores canvas-only fields such as selection', () => {
    const [workflow] = sampleWorkflows();
    const { nodes, edges } = toFlow(workflow!);
    nodes[0] = { ...nodes[0]!, position: { x: 10.6, y: 20.4 }, selected: true };
    const saved = fromFlow(workflow!, nodes, edges);
    expect(saved.nodes[0]!.position).toEqual({ x: 11, y: 20 });
    expect(JSON.stringify(saved)).not.toContain('selected');
  });

  it('keeps workflow identity and metadata from the base', () => {
    const [workflow] = sampleWorkflows();
    const renamed = { ...workflow!, name: 'Renamed', enabled: true };
    const saved = fromFlow(renamed, [], []);
    expect(saved).toMatchObject({ id: workflow!.id, name: 'Renamed', enabled: true });
    expect(saved.nodes).toEqual([]);
  });

  it('does not share config objects with the saved workflow', () => {
    const [workflow] = sampleWorkflows();
    const { nodes } = toFlow(workflow!);
    nodes[0]!.data.config.seconds = 1;
    expect(workflow!.nodes[0]!.config.seconds).toBe(300);
  });

  it('sameGraph compares structure, including positions', () => {
    const [workflow] = sampleWorkflows();
    const { nodes, edges } = toFlow(workflow!);
    expect(sameGraph(workflow!, fromFlow(workflow!, nodes, edges))).toBe(true);
    nodes[0] = { ...nodes[0]!, position: { x: 999, y: 0 } };
    expect(sameGraph(workflow!, fromFlow(workflow!, nodes, edges))).toBe(false);
  });
});

describe('ports and step settings', () => {
  it('round-trips the output an edge leaves from and the step settings', () => {
    const workflow: Workflow = {
      schemaVersion: 1,
      id: 'w',
      name: 'W',
      enabled: false,
      nodes: [
        { id: 'i', type: 'if', position: { x: 0, y: 0 }, config: {}, step: { retries: 2 } },
        { id: 'a', type: 'notify', position: { x: 1, y: 0 }, config: {} },
        { id: 'b', type: 'notify', position: { x: 2, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'e1', source: 'i', target: 'a', sourcePort: 'true' },
        { id: 'e2', source: 'i', target: 'b', sourcePort: 'false' },
      ],
    };
    const flowed = toFlow(workflow);
    expect(flowed.edges.map((edge) => edge.sourceHandle)).toEqual(['true', 'false']);
    expect(flowed.nodes[0]?.data.step).toEqual({ retries: 2 });
    expect(fromFlow(workflow, flowed.nodes, flowed.edges)).toEqual(workflow);
  });

  it('does not write the default "out" port, so old workflows stay identical', () => {
    const workflow: Workflow = {
      schemaVersion: 1,
      id: 'w',
      name: 'W',
      enabled: false,
      nodes: [
        { id: 'a', type: 'timer', position: { x: 0, y: 0 }, config: {} },
        { id: 'b', type: 'notify', position: { x: 1, y: 0 }, config: {} },
      ],
      edges: [{ id: 'e', source: 'a', target: 'b' }],
    };
    const flowed = toFlow(workflow);
    expect(flowed.edges[0]?.sourceHandle).toBe('out');
    expect(sameGraph(workflow, fromFlow(workflow, flowed.nodes, flowed.edges))).toBe(true);
  });
});
