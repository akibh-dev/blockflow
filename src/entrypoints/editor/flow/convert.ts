import type { EdgeDef, NodeDef, Workflow } from '../../../core/types';

/**
 * Conversion between the saved workflow model and what React Flow draws.
 * Kept free of React so it can be unit-tested. The shapes below are structurally
 * compatible with React Flow's Node and Edge types.
 */

// Must be a `type` alias (not an interface) to satisfy React Flow's Record<string, unknown> constraint.
export type BlockNodeData = {
  blockType: string;
  config: Record<string, unknown>;
};

export interface FlowNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: BlockNodeData;
  selected?: boolean;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
}

export function toFlow(workflow: Workflow): { nodes: FlowNode[]; edges: FlowEdge[] } {
  return {
    nodes: workflow.nodes.map((node) => ({
      id: node.id,
      type: 'block',
      position: { ...node.position },
      data: { blockType: node.type, config: { ...node.config } },
    })),
    edges: workflow.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
  };
}

/** Builds the saved model from the canvas, keeping the workflow's id, name and enabled flag from `base`. */
export function fromFlow(base: Workflow, nodes: FlowNode[], edges: FlowEdge[]): Workflow {
  return {
    ...base,
    nodes: nodes.map(
      (node): NodeDef => ({
        id: node.id,
        type: node.data.blockType,
        position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
        config: { ...node.data.config },
      }),
    ),
    edges: edges.map((edge): EdgeDef => ({ id: edge.id, source: edge.source, target: edge.target })),
  };
}

/** True when two workflows have identical blocks, settings, positions and connections. */
export function sameGraph(a: Workflow, b: Workflow): boolean {
  return JSON.stringify([a.nodes, a.edges]) === JSON.stringify([b.nodes, b.edges]);
}
