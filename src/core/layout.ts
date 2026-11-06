import { edgePort, nodePorts } from './ports';
import type { BlockRegistry } from './registry';
import type { EdgeDef, NodeDef, Workflow } from './types';

/**
 * Automatic layout: blocks in columns from left to right, in the order data flows.
 * Used for compiled scripts (script.ts), for imported workflows without positions (library.ts) and for
 * the editor's "Tidy up" button. Pure and deterministic.
 *
 * 1. Layers (columns): longest path from a start block, so every connection points right.
 *    Connections that close a loop are ignored for this.
 * 2. Order within a column: barycentric. Each block sits near the average row of the blocks feeding it,
 *    outputs taken in port order (If "true" above "false", "each" above "done", "error" last).
 * 3. Rows: a block takes its parents' average row (rounded up the page) when free, else the next free row below, so a plain
 *    chain is one straight line and branches open downwards. Columns are LAYOUT_X apart, rows LAYOUT_Y.
 */

export const LAYOUT_X = 260;
export const LAYOUT_Y = 140;

/** Port order used when no registry is given: the order the built-in blocks declare them in. */
const FALLBACK_PORT_ORDER = ['out', 'true', 'each', 'false', 'done', 'error'];

/** Positions for every node, by id. `portRank(edge)` orders a node's outputs (smaller = higher). */
export function layoutGraph<E extends Pick<EdgeDef, 'source' | 'target'>>(
  nodes: Pick<NodeDef, 'id'>[],
  edges: E[],
  portRank: (edge: E) => number = () => 0,
): Map<string, { x: number; y: number }> {
  const ids = nodes.map((node) => node.id);
  const known = new Set(ids);
  const valid = edges.filter((edge) => known.has(edge.source) && known.has(edge.target) && edge.source !== edge.target);
  const outgoing = new Map<string, typeof valid>(ids.map((id) => [id, []]));
  for (const edge of valid) outgoing.get(edge.source)?.push(edge);
  for (const list of outgoing.values()) list.sort((a, b) => portRank(a) - portRank(b));

  // Drop edges that close a cycle (DFS from start blocks first, then from anything left).
  const forward: typeof valid = [];
  const state = new Map<string, 1 | 2>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const edge of outgoing.get(id) ?? []) {
      const seen = state.get(edge.target);
      if (seen === 1) continue; // back edge
      forward.push(edge);
      if (!seen) visit(edge.target);
    }
    state.set(id, 2);
  };
  const hasInput = new Set(valid.map((edge) => edge.target));
  for (const id of ids) if (!hasInput.has(id) && !state.has(id)) visit(id);
  for (const id of ids) if (!state.has(id)) visit(id);

  // 1. Longest-path layers (topological order over forward edges).
  const parents = new Map<string, typeof forward>(ids.map((id) => [id, []]));
  const children = new Map<string, typeof forward>(ids.map((id) => [id, []]));
  for (const edge of forward) {
    parents.get(edge.target)?.push(edge);
    children.get(edge.source)?.push(edge);
  }
  const layer = new Map<string, number>();
  const pending = new Map(ids.map((id) => [id, parents.get(id)?.length ?? 0]));
  const queue = ids.filter((id) => pending.get(id) === 0);
  const topo: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    topo.push(id);
    for (const edge of children.get(id) ?? []) {
      layer.set(edge.target, Math.max(layer.get(edge.target) ?? 0, (layer.get(id) ?? 0) + 1));
      const left = (pending.get(edge.target) ?? 1) - 1;
      pending.set(edge.target, left);
      if (left === 0) queue.push(edge.target);
    }
  }
  for (const id of ids) if (!layer.has(id)) layer.set(id, 0);

  // 2. Order within each layer: a key per node from its parents' order and the port it hangs off.
  const columns = new Map<number, string[]>();
  const order = new Map<string, number>();
  for (const id of [...topo, ...ids.filter((id) => !topo.includes(id))]) {
    const column = layer.get(id) as number;
    columns.set(column, [...(columns.get(column) ?? []), id]);
    order.set(id, -1);
  }
  // Column by column, left to right: sort by the parents' (already final) indexes plus the port slot,
  // then replace the key by the index. Start blocks keep their file order.
  const sorted = [...columns.keys()].sort((a, b) => a - b);
  for (const column of sorted) {
    const list = columns.get(column) as string[];
    for (const id of list) {
      const incoming = parents.get(id) ?? [];
      if (incoming.length > 0) order.set(id, average(incoming.map((edge) => (order.get(edge.source) ?? 0) + portSlot(edge, children))));
    }
    const stable = new Map(list.map((id, index) => [id, index]));
    list.sort((a, b) => (order.get(a) as number) - (order.get(b) as number) || (stable.get(a) as number) - (stable.get(b) as number));
    list.forEach((id, index) => order.set(id, index));
  }

  // 3. Rows: parents' average row when free, else the next free row.
  const row = new Map<string, number>();
  const positions = new Map<string, { x: number; y: number }>();
  for (const column of sorted) {
    let last = -1;
    for (const id of columns.get(column) as string[]) {
      const incoming = parents.get(id) ?? [];
      const wanted = incoming.length === 0 ? last + 1 : Math.floor(average(incoming.map((edge) => row.get(edge.source) ?? 0)));
      const placed = Math.max(wanted, last + 1);
      row.set(id, placed);
      last = placed;
      positions.set(id, { x: column * LAYOUT_X, y: placed * LAYOUT_Y });
    }
  }
  return positions;
}

/** A small offset in (0, 1) for an edge by its rank among its source's outputs, so siblings keep port order. */
function portSlot(edge: Pick<EdgeDef, 'source' | 'target'>, children: Map<string, Pick<EdgeDef, 'source' | 'target'>[]>): number {
  const siblings = children.get(edge.source) ?? [];
  return (siblings.indexOf(edge) + 1) / (siblings.length + 1);
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

/**
 * The workflow with every node placed by `layoutGraph`. With a registry, outputs are ordered as the
 * blocks declare them; without one, by FALLBACK_PORT_ORDER.
 */
export function layoutWorkflow(workflow: Workflow, registry?: BlockRegistry): Workflow {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const rankOf = (full: EdgeDef) => {
    const node = byId.get(full.source);
    if (registry && node) {
      const ports = nodePorts(registry.get(node.type), node);
      return ports.indexOf(edgePort(full, ports));
    }
    const rank = FALLBACK_PORT_ORDER.indexOf(full.sourcePort ?? 'out');
    return rank < 0 ? FALLBACK_PORT_ORDER.length : rank;
  };
  const positions = layoutGraph(workflow.nodes, workflow.edges, rankOf);
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position })),
  };
}
