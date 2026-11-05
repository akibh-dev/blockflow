import type { EdgeDef, NodeDef, Workflow } from './types';

export { uid } from './id';
import { uid } from './id';

/** A new empty, disabled workflow with a fresh id. */
export function createWorkflow(name = 'Untitled workflow'): Workflow {
  return { schemaVersion: 1, id: uid(), name, enabled: false, nodes: [], edges: [] };
}

/**
 * Identity of a workflow's behaviour: block types, settings, step settings and connections.
 * Positions and names are excluded, so dragging a block or renaming the workflow does not
 * restart it.
 */
export function behaviourSignature(workflow: Workflow): string {
  const nodes = [...workflow.nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((node: NodeDef) => [node.id, node.type, node.config, node.step ?? null]);
  const edges = workflow.edges
    .map((edge: EdgeDef) => `${edge.source}:${edge.sourcePort ?? ''}->${edge.target}`)
    .sort();
  return JSON.stringify({ nodes, edges });
}

export interface WorkflowDiff {
  /** Workflows to (re)start: newly enabled, or enabled and edited. */
  start: string[];
  /** Workflows to stop: disabled or deleted. */
  stop: string[];
}

/** Compares two saved lists and says what the background worker must do about it. */
export function diffWorkflows(
  previous: Workflow[] | undefined,
  next: Workflow[] | undefined,
): WorkflowDiff {
  const before = new Map((previous ?? []).map((workflow) => [workflow.id, workflow]));
  const after = new Map((next ?? []).map((workflow) => [workflow.id, workflow]));
  const diff: WorkflowDiff = { start: [], stop: [] };

  for (const [id, workflow] of after) {
    const old = before.get(id);
    if (workflow.enabled) {
      if (!old || !old.enabled || behaviourSignature(old) !== behaviourSignature(workflow)) {
        diff.start.push(id);
      }
    } else if (old?.enabled) {
      diff.stop.push(id);
    }
  }
  for (const [id, workflow] of before) {
    if (!after.has(id) && workflow.enabled) diff.stop.push(id);
  }
  return diff;
}
