import { uid } from './id';
import type { EdgeDef, NodeDef, Workflow } from './types';

/**
 * Managing a collection of workflows: copy, export, import. Pure functions, no browser APIs.
 */

const EXPORT_FORMAT = 'blockflow-workflows';

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
    return {
      id,
      type: node.type,
      position: { ...node.position },
      config: JSON.parse(JSON.stringify(node.config)) as Record<string, unknown>,
    };
  });
  const edges: EdgeDef[] = source.edges.flatMap((edge) => {
    const from = idMap.get(edge.source);
    const to = idMap.get(edge.target);
    return from && to ? [{ id: uid(), source: from, target: to }] : [];
  });
  return { schemaVersion: 1, id: uid(), name, enabled: false, nodes, edges };
}

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

export type ImportResult = { ok: true; workflows: Workflow[] } | { ok: false; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNode(raw: unknown): NodeDef | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.type !== 'string') return null;
  const position = isObject(raw.position) ? raw.position : {};
  return {
    id: raw.id,
    type: raw.type,
    position: {
      x: typeof position.x === 'number' ? position.x : 0,
      y: typeof position.y === 'number' ? position.y : 0,
    },
    config: isObject(raw.config) ? raw.config : {},
  };
}

/**
 * Reads an export file (or a single bare workflow). Imported workflows get new ids and are
 * switched off, so importing can never start something by surprise or overwrite a workflow.
 */
export function parseImport(text: string, existing: Workflow[]): ImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This file is not valid JSON.' };
  }

  const rawList: unknown[] = isObject(data) && Array.isArray(data.workflows) ? data.workflows : [data];
  const taken = existing.map((workflow) => workflow.name);
  const imported: Workflow[] = [];

  for (const raw of rawList) {
    if (!isObject(raw) || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
      return { ok: false, error: 'This file does not look like a BlockFlow workflow.' };
    }
    const nodes = raw.nodes.map(readNode);
    if (nodes.some((node) => node === null)) {
      return { ok: false, error: 'A block in this file is malformed.' };
    }
    const edges: EdgeDef[] = raw.edges.flatMap((edge: unknown) =>
      isObject(edge) && typeof edge.source === 'string' && typeof edge.target === 'string'
        ? [{ id: uid(), source: edge.source, target: edge.target }]
        : [],
    );
    const name = uniqueName(typeof raw.name === 'string' ? raw.name : 'Imported workflow', taken);
    taken.push(name);
    const copy = cloneWorkflowFromParts(name, nodes as NodeDef[], edges);
    imported.push(copy);
  }
  if (imported.length === 0) return { ok: false, error: 'No workflows found in this file.' };

  // Run Workflow blocks point at workflows by id; imported ones got new ids.
  const newIds = new Map<string, string>();
  rawList.forEach((raw, index) => {
    const id = isObject(raw) && typeof raw.id === 'string' ? raw.id : undefined;
    const target = imported[index];
    if (id && target) newIds.set(id, target.id);
  });
  for (const workflow of imported) {
    for (const node of workflow.nodes) {
      const called = node.config.workflow;
      if (node.type === 'run-workflow' && typeof called === 'string' && newIds.has(called)) {
        node.config = { ...node.config, workflow: newIds.get(called) };
      }
    }
  }
  return { ok: true, workflows: imported };
}

function cloneWorkflowFromParts(name: string, nodes: NodeDef[], edges: EdgeDef[]): Workflow {
  return cloneWorkflow({ schemaVersion: 1, id: '', name, enabled: false, nodes, edges }, name);
}
