import type { Workflow } from './types';

export { uid } from './id';
import { uid } from './id';

/** A new empty, disabled workflow with a fresh id. */
export function createWorkflow(name = 'Untitled workflow'): Workflow {
  return { schemaVersion: 1, id: uid(), name, enabled: false, nodes: [], edges: [] };
}

/**
 * Identity of a workflow's start blocks (the ones nothing feeds): ids, types, settings. Only these
 * hold schedules and listeners. Every other block is read from storage when a run reaches it, so
 * editing it needs no restart.
 */
export function rootSignature(workflow: Workflow): string {
  const fed = new Set(workflow.edges.map((edge) => edge.target));
  const roots = workflow.nodes
    .filter((node) => !fed.has(node.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((node) => [node.id, node.type, node.config, node.step ?? null]);
  return JSON.stringify(roots);
}

export interface WorkflowDiff {
  /** Workflows just switched on (or added switched on): start them, plain start blocks included. */
  start: string[];
  /** Enabled workflows whose start blocks changed: re-arm their triggers, without running plain start blocks. */
  restart: string[];
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
  const diff: WorkflowDiff = { start: [], restart: [], stop: [] };

  for (const [id, workflow] of after) {
    const old = before.get(id);
    if (workflow.enabled) {
      if (!old || !old.enabled) diff.start.push(id);
      else if (rootSignature(old) !== rootSignature(workflow)) diff.restart.push(id);
    } else if (old?.enabled) {
      diff.stop.push(id);
    }
  }
  for (const [id, workflow] of before) {
    if (!after.has(id) && workflow.enabled) diff.stop.push(id);
  }
  return diff;
}
