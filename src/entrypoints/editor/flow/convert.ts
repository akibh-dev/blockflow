import { DEFAULT_PORT } from '../../../core/ports';
import type { EdgeDef, NodeDef, StepSettings, Workflow } from '../../../core/types';

/**
 * Conversion between the saved workflow model and what React Flow draws.
 * Kept free of React so it can be unit-tested. The shapes below are structurally
 * compatible with React Flow's Node and Edge types.
 */

/** What a React Flow node of type `block` carries: the block type, its settings and step settings. */
// Must be a `type` alias (not an interface) to satisfy React Flow's Record<string, unknown> constraint.
export type BlockNodeData = {
  blockType: string;
  config: Record<string, unknown>;
  step?: StepSettings;
};

/** A canvas node, structurally a React Flow `Node<BlockNodeData>`. `type` is always `'block'`. */
export interface FlowNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: BlockNodeData;
  selected?: boolean;
}

/** A canvas edge, structurally a React Flow `Edge`. */
export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  /** The output (port) the edge leaves from; React Flow calls it the source handle. */
  sourceHandle?: string | null;
}

/**
 * Saved workflow → canvas nodes and edges (copies, so editing the canvas never mutates `workflow`).
 *
 * `portOf` says which output an edge leaves from (edges saved before ports existed have none);
 * React Flow needs it to attach the edge to the right dot.
 */
export function toFlow(
  workflow: Workflow,
  portOf: (edge: EdgeDef) => string = (edge) => edge.sourcePort ?? DEFAULT_PORT,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  return {
    nodes: workflow.nodes.map((node) => ({
      id: node.id,
      type: 'block',
      position: { ...node.position },
      data: {
        blockType: node.type,
        config: { ...node.config },
        ...(node.step ? { step: { ...node.step } } : {}),
      },
    })),
    edges: workflow.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: portOf(edge),
    })),
  };
}

/**
 * Builds the saved model from the canvas, keeping the workflow's id, name and enabled flag from `base`.
 * Positions are rounded to whole pixels, empty step settings and the default `out` port are dropped,
 * so `fromFlow(w, ...toFlow(w))` equals `w` (tested in `tests/editor/convert.test.ts`).
 */
export function fromFlow(base: Workflow, nodes: FlowNode[], edges: FlowEdge[]): Workflow {
  // The author's ids from an imported file (NodeDef.origin) are not on the canvas: keep them by node id.
  const origins = new Map(base.nodes.flatMap((node) => (node.origin ? [[node.id, node.origin] as const] : [])));
  return {
    ...base,
    nodes: nodes.map(
      (node): NodeDef => ({
        id: node.id,
        type: node.data.blockType,
        position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
        config: { ...node.data.config },
        ...(node.data.step && Object.keys(node.data.step).length > 0 ? { step: { ...node.data.step } } : {}),
        ...(origins.has(node.id) ? { origin: origins.get(node.id) } : {}),
      }),
    ),
    edges: edges.map(
      (edge): EdgeDef => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        // "out" is the default, so it is not written: workflows from before ports stay identical.
        ...(edge.sourceHandle && edge.sourceHandle !== DEFAULT_PORT ? { sourcePort: edge.sourceHandle } : {}),
      }),
    ),
  };
}

/**
 * True when two workflows have identical blocks, settings, positions and connections.
 * Compares JSON, so key order matters; the editor uses it to ignore canvas changes that are only
 * selection or measurement.
 */
export function sameGraph(a: Workflow, b: Workflow): boolean {
  return JSON.stringify([a.nodes, a.edges]) === JSON.stringify([b.nodes, b.edges]);
}

/**
 * Keeps a node's connections in step with outputs that depend on its settings (Switch cases). Called
 * after a settings change with the node's outputs before and after it:
 * - one output gone and one new (a case renamed): its connections move to the new name;
 * - outputs gone otherwise (a case removed): their connections are removed, so no connection is left
 *   on an output that is not drawn.
 * Returns `edges` itself when nothing changes. (Switch gives a nameless or half-typed case a stand-in
 * output `case<N>`, so typing a new name is a chain of renames and keeps the connections.)
 */
export function followPortChanges<E extends FlowEdge>(edges: E[], nodeId: string, before: string[], after: string[]): E[] {
  const gone = before.filter((port) => !after.includes(port));
  if (gone.length === 0) return edges;
  const added = after.filter((port) => !before.includes(port));
  const renamed = gone.length === 1 && added.length === 1 ? { from: gone[0], to: added[0] as string } : undefined;
  let changed = false;
  const next: E[] = [];
  for (const edge of edges) {
    const port = edge.sourceHandle ?? DEFAULT_PORT;
    if (edge.source !== nodeId || !gone.includes(port)) {
      next.push(edge);
      continue;
    }
    changed = true;
    if (renamed) next.push({ ...edge, sourceHandle: renamed.to });
  }
  return changed ? next : edges;
}
