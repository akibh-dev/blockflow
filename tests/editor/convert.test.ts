import { describe, expect, it } from 'vitest';
import { followPortChanges, fromFlow, sameGraph, toFlow } from '../../src/entrypoints/editor/flow/convert';
import { switchBlock } from '../../src/core/blocks/switchBlock';
import { nodePorts } from '../../src/core/ports';
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
      schemaVersion: 2,
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
      schemaVersion: 2,
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

  it('Switch: edges keep their case port through toFlow / fromFlow', () => {
    const workflow: Workflow = {
      schemaVersion: 2,
      id: 'w',
      name: 'W',
      enabled: false,
      nodes: [
        { id: 'sw', type: 'switch', position: { x: 0, y: 0 }, config: { value: '{{v}}', cases: [{ port: 'ok', operator: 'equals', value: '1' }] } },
        { id: 'a', type: 'log', position: { x: 1, y: 0 }, config: {} },
        { id: 'b', type: 'log', position: { x: 1, y: 1 }, config: {} },
      ],
      edges: [
        { id: 'e1', source: 'sw', target: 'a', sourcePort: 'ok' },
        { id: 'e2', source: 'sw', target: 'b', sourcePort: 'default' },
      ],
    };
    const flowed = toFlow(workflow);
    expect(flowed.edges.map((edge) => edge.sourceHandle)).toEqual(['ok', 'default']);
    expect(fromFlow(workflow, flowed.nodes, flowed.edges)).toEqual(workflow);
  });

  it('followPortChanges: a renamed case keeps its connections, a removed one loses them', () => {
    const ports = (names: string[]) => nodePorts(switchBlock, { config: { cases: names.map((port) => ({ port, operator: 'equals', value: '' })) } });
    const edges = [
      { id: 'e1', source: 'sw', target: 'a', sourceHandle: 'ok' },
      { id: 'e2', source: 'sw', target: 'b', sourceHandle: 'bad' },
      { id: 'e3', source: 'sw', target: 'c', sourceHandle: 'default' },
      { id: 'e4', source: 'other', target: 'd', sourceHandle: 'ok' },
    ];
    // Typing a new name: "ok" → "" (stand-in case1) → "g" → "good"; the connection follows every step.
    let current = edges;
    for (const [before, after] of [[['ok', 'bad'], ['', 'bad']], [['', 'bad'], ['g', 'bad']], [['g', 'bad'], ['good', 'bad']]] as const) {
      current = followPortChanges(current, 'sw', ports([...before]), ports([...after]));
    }
    expect(current.map((edge) => `${edge.id}:${edge.sourceHandle}`)).toEqual(['e1:good', 'e2:bad', 'e3:default', 'e4:ok']);
    // Removing the "bad" row removes its connection; other nodes are untouched.
    const removed = followPortChanges(current, 'sw', ports(['good', 'bad']), ports(['good']));
    expect(removed.map((edge) => edge.id)).toEqual(['e1', 'e3', 'e4']);
    // Adding a case changes nothing (same array back).
    expect(followPortChanges(removed, 'sw', ports(['good']), ports(['good', 'new']))).toBe(removed);
  });
});
