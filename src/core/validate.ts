import { validateConfig, withDefaults } from './config';
import type { BlockRegistry } from './registry';
import type { Workflow } from './types';

export interface Issue {
  level: 'error' | 'warning';
  nodeId?: string;
  edgeId?: string;
  message: string;
}

/** Checks a workflow without running it. Used by the editor to flag problems. */
export function validateWorkflow(workflow: Workflow, registry: BlockRegistry): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set<string>();

  if (workflow.nodes.length === 0) {
    issues.push({ level: 'warning', message: 'This workflow is empty. Add a block to start.' });
    return issues;
  }

  for (const node of workflow.nodes) {
    if (ids.has(node.id)) {
      issues.push({ level: 'error', nodeId: node.id, message: `Duplicate block id "${node.id}"` });
    }
    ids.add(node.id);

    const def = registry.get(node.type);
    if (!def) {
      issues.push({ level: 'error', nodeId: node.id, message: `Unknown block type "${node.type}"` });
      continue;
    }
    for (const message of validateConfig(def, withDefaults(def, node.config), 'design')) {
      issues.push({ level: 'error', nodeId: node.id, message });
    }
  }

  const seenEdges = new Set<string>();
  const incoming = new Map<string, number>();
  for (const edge of workflow.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      issues.push({ level: 'error', edgeId: edge.id, message: 'A connection points to a missing block' });
      continue;
    }
    if (edge.source === edge.target) {
      issues.push({ level: 'error', edgeId: edge.id, message: 'A block cannot connect to itself' });
      continue;
    }
    const pair = `${edge.source}->${edge.target}`;
    if (seenEdges.has(pair)) {
      issues.push({ level: 'warning', edgeId: edge.id, message: 'Duplicate connection' });
    }
    seenEdges.add(pair);
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);

    const targetNode = workflow.nodes.find((node) => node.id === edge.target);
    const targetDef = targetNode ? registry.get(targetNode.type) : undefined;
    if (targetDef && !targetDef.run) {
      issues.push({
        level: 'error',
        nodeId: edge.target,
        message: `${targetDef.label} cannot take input from another block`,
      });
    }
  }

  const roots = workflow.nodes.filter((node) => !incoming.has(node.id));
  if (roots.length === 0) {
    issues.push({
      level: 'error',
      message: 'Nothing can start this workflow: every block has an input. Remove a connection.',
    });
  } else {
    const reachable = reachableFrom(roots.map((node) => node.id), workflow);
    for (const node of workflow.nodes) {
      if (!reachable.has(node.id)) {
        issues.push({
          level: 'warning',
          nodeId: node.id,
          message: 'This block can never run: no start block leads to it',
        });
      }
    }
  }

  if (hasCycle(workflow)) {
    issues.push({
      level: 'warning',
      message: 'This workflow contains a loop. It will stop after 25 blocks in a row.',
    });
  }

  return issues;
}

function reachableFrom(startIds: string[], workflow: Workflow): Set<string> {
  const seen = new Set<string>(startIds);
  const queue = [...startIds];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of workflow.edges) {
      if (edge.source === current && !seen.has(edge.target)) {
        seen.add(edge.target);
        queue.push(edge.target);
      }
    }
  }
  return seen;
}

function hasCycle(workflow: Workflow): boolean {
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): boolean => {
    const current = state.get(id);
    if (current === 'visiting') return true;
    if (current === 'done') return false;
    state.set(id, 'visiting');
    for (const edge of workflow.edges) {
      if (edge.source === id && visit(edge.target)) return true;
    }
    state.set(id, 'done');
    return false;
  };
  return workflow.nodes.some((node) => visit(node.id));
}
