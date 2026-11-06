import type { NodeDef, Workflow } from './types';

/**
 * Workflow schema versions and the steps between them. Pure: applied when workflows are loaded from
 * storage (`loadWorkflows`), when the stored list is rewritten once after an update, and on import.
 *
 * - v1: the first format.
 * - v2: every element setting is called `locator`. Read Element and Watch Element used `selector`,
 *   Paginate used `next` (PLAN.md §8.6). Old keys are still accepted in files and moved here.
 */

export const CURRENT_SCHEMA_VERSION = 2;

/** A config key that was renamed, per block type: old key → new key. */
export const RENAMED_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'read-element': { selector: 'locator' },
  'watch-element': { selector: 'locator' },
  paginate: { next: 'locator' },
};

/** One key moved by `migrateNode`, for check.ts to report (`config.key.renamed`). */
export interface Rename {
  nodeId: string;
  type: string;
  from: string;
  to: string;
}

/**
 * The node with renamed keys moved to their new name. When both are present the new key wins and
 * the old one is dropped. Returns the same object when nothing changed.
 */
export function migrateNode(node: NodeDef, renames?: Rename[]): NodeDef {
  const renamed = RENAMED_KEYS[node.type];
  if (!renamed) return node;
  let config: Record<string, unknown> | null = null;
  for (const [from, to] of Object.entries(renamed)) {
    if (!(from in node.config)) continue;
    config ??= { ...node.config };
    if (!(to in config)) config[to] = config[from];
    delete config[from];
    renames?.push({ nodeId: node.id, type: node.type, from, to });
  }
  return config ? { ...node, config } : node;
}

/** The workflow at the current schema version. Returns the same object when it already is. */
export function migrateWorkflow(workflow: Workflow, renames?: Rename[]): Workflow {
  const version = Number((workflow as { schemaVersion?: unknown }).schemaVersion) || 1;
  if (version >= CURRENT_SCHEMA_VERSION) return workflow;
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes.map((node) => migrateNode(node, renames)) : [];
  return { ...workflow, schemaVersion: CURRENT_SCHEMA_VERSION, nodes };
}

/** Every workflow migrated, and whether anything changed (so the caller knows to save the list). */
export function migrateWorkflows(list: Workflow[]): { workflows: Workflow[]; changed: boolean } {
  const workflows = list.map((workflow) => migrateWorkflow(workflow));
  return { workflows, changed: workflows.some((workflow, index) => workflow !== list[index]) };
}
