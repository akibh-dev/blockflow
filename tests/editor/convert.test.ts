import { describe, expect, it } from 'vitest';
import { fromFlow, sameGraph, toFlow } from '../../src/entrypoints/editor/flow/convert';
import { sampleWorkflows } from '../../src/core/samples';

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
