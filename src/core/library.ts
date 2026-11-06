import { createDefaultRegistry } from './blocks';
import { EXPORT_FORMAT, checkFile, parseJson } from './check';
import { uid } from './id';
import { hasErrors } from './issues';
import { migrateNode } from './migrate';
import type { Issue } from './issues';
import type { BlockRegistry } from './registry';
import type { EdgeDef, NodeDef, StepSettings, Workflow } from './types';

/**
 * Managing a collection of workflows: copy, export, import. Pure functions, no browser APIs.
 */

/** "Foo" → "Foo", or "Foo 2", "Foo 3"… when the name is taken. */
export function uniqueName(wanted: string, taken: string[]): string {
  const base = wanted.trim() || 'Untitled workflow';
  const used = new Set(taken.map((name) => name.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** Copy with fresh ids everywhere, switched off. Connections are remapped to the new block ids. */
export function cloneWorkflow(source: Workflow, name: string): Workflow {
  const idMap = new Map<string, string>();
  const nodes: NodeDef[] = source.nodes.map((node) => {
    const id = uid();
    idMap.set(node.id, id);
    const copy: NodeDef = {
      id,
      type: node.type,
      position: { ...node.position },
      config: JSON.parse(JSON.stringify(node.config)) as Record<string, unknown>,
    };
    if (node.step) copy.step = JSON.parse(JSON.stringify(node.step)) as StepSettings;
    if (node.origin) copy.origin = node.origin;
    return copy;
  });
  const edges: EdgeDef[] = source.edges.flatMap((edge) => {
    const from = idMap.get(edge.source);
    const to = idMap.get(edge.target);
    if (!from || !to) return [];
    const copy: EdgeDef = { id: uid(), source: from, target: to };
    if (edge.sourcePort) copy.sourcePort = edge.sourcePort;
    return [copy];
  });
  return { schemaVersion: 2, id: uid(), name, enabled: false, nodes, edges };
}

/** A disabled copy named "<name> copy" (numbered when taken). */
export function duplicateWorkflow(source: Workflow, existing: Workflow[]): Workflow {
  return cloneWorkflow(source, uniqueName(`${source.name} copy`, existing.map((w) => w.name)));
}

/** JSON text for a file the user can keep or share. Never exported as enabled. */
export function exportWorkflows(workflows: Workflow[]): string {
  return JSON.stringify(
    {
      format: EXPORT_FORMAT,
      version: 1,
      workflows: workflows.map((workflow) => ({ ...workflow, enabled: false })),
    },
    null,
    2,
  );
}

/**
 * Outcome of `parseImport`. `issues` (check.ts) come with both: on success only warnings and info
 * (the editor shows them in a banner), on failure at least one error. `error` sums up the errors.
 */
export type ImportResult = { ok: true; workflows: Workflow[]; issues: Issue[] } | { ok: false; error: string; issues: Issue[] };

/** What `parseImport` may know besides the existing workflows. */
export interface ImportOptions {
  /** Block types to check against. Default: every built-in block. */
  registry?: BlockRegistry;
  /** Names of the user's secrets; when given, unknown `{{secret.x}}` names are warnings. */
  secrets?: Iterable<string>;
}

/** The built-in registry, made on first import. */
let builtIn: BlockRegistry | undefined;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A refused import: the first error as `error`, with a count of the others. */
function refuse(issues: Issue[]): ImportResult {
  const errors = issues.filter((issue) => issue.level === 'error');
  const more = errors.length > 1 ? ` (and ${errors.length - 1} more problem${errors.length === 2 ? '' : 's'})` : '';
  return { ok: false, error: `${errors[0]?.message ?? 'This file cannot be imported.'}${more}`, issues };
}

/** A node of a checked file (checkFile verified the shape). */
function readNode(raw: Record<string, unknown>): NodeDef {
  const position = isObject(raw.position) ? raw.position : {};
  const node: NodeDef = {
    id: raw.id as string,
    type: raw.type as string,
    position: {
      x: typeof position.x === 'number' ? position.x : 0,
      y: typeof position.y === 'number' ? position.y : 0,
    },
    config: isObject(raw.config) ? raw.config : {},
  };
  if (isObject(raw.step)) node.step = raw.step as StepSettings;
  // The author's id, kept through the fresh-id clone (see NodeDef.origin).
  node.origin = raw.id as string;
  return node;
}

/**
 * Reads an export file (or a single bare workflow). The file is checked first (check.ts): any error
 * refuses the whole file. Imported workflows get new ids and are switched off, so importing can never
 * start something by surprise or overwrite a workflow.
 */
export function parseImport(text: string, existing: Workflow[], options: ImportOptions = {}): ImportResult {
  const parsed = parseJson(text);
  if (!parsed.ok) return refuse(parsed.issues);
  const data = parsed.data;

  builtIn ??= createDefaultRegistry();
  const issues = checkFile(data, options.registry ?? builtIn, {
    workflowIds: existing.map((workflow) => workflow.id),
    ...(options.secrets ? { secrets: options.secrets } : {}),
  });
  if (hasErrors(issues)) return refuse(issues);

  const rawList = (isObject(data) && Array.isArray(data.workflows) ? data.workflows : [data]) as Record<string, unknown>[];
  const taken = existing.map((workflow) => workflow.name);
  const imported: Workflow[] = [];

  for (const raw of rawList) {
    // Old key names (v1 files, or a script written from older docs) are accepted and moved (migrate.ts).
    const nodes = (raw.nodes as Record<string, unknown>[]).map((node) => migrateNode(readNode(node)));
    const edges = (raw.edges as Record<string, unknown>[]).map((edge) => {
      const copy: EdgeDef = { id: uid(), source: edge.source as string, target: edge.target as string };
      if (typeof edge.sourcePort === 'string' && edge.sourcePort) copy.sourcePort = edge.sourcePort;
      return copy;
    });
    const name = uniqueName(typeof raw.name === 'string' ? raw.name : 'Imported workflow', taken);
    taken.push(name);
    imported.push(cloneWorkflowFromParts(name, nodes, edges));
  }

  // Run Workflow blocks point at workflows by id; imported ones got new ids.
  const newIds = new Map<string, string>();
  rawList.forEach((raw, index) => {
    const target = imported[index];
    if (typeof raw.id === 'string' && target) newIds.set(raw.id, target.id);
  });
  for (const workflow of imported) {
    for (const node of workflow.nodes) {
      const called = node.config.workflow;
      if (node.type === 'run-workflow' && typeof called === 'string' && newIds.has(called.trim())) {
        node.config = { ...node.config, workflow: newIds.get(called.trim()) };
      }
    }
  }
  return { ok: true, workflows: imported, issues };
}

/** `cloneWorkflow` over loose parts (fresh ids, disabled). */
function cloneWorkflowFromParts(name: string, nodes: NodeDef[], edges: EdgeDef[]): Workflow {
  return cloneWorkflow({ schemaVersion: 2, id: '', name, enabled: false, nodes, edges }, name);
}
