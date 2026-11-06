import { createDefaultRegistry } from './blocks';
import { EXPORT_FORMAT, checkFile, parseJson } from './check';
import { uid } from './id';
import { hasErrors } from './issues';
import type { Issue } from './issues';
import { layoutWorkflow } from './layout';
import { migrateNode } from './migrate';
import type { BlockRegistry } from './registry';
import { compileScriptFile, isScriptFile } from './script';
import type { CompiledScript } from './script';
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
  // The script format (a list of steps) has its own reader: parseScriptImport below.
  if (isScriptFile(data)) return parseScriptImport(data, existing, options);

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
    const copy = cloneWorkflowFromParts(name, nodes, edges);
    // A file written without positions (by hand, by an LLM) is laid out (layout.ts).
    imported.push((raw.nodes as unknown[]).some((node) => isObject(node) && isObject(node.position)) ? copy : layoutWorkflow(copy));
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

/**
 * Imports a script file (script.ts): compile, then the same strict check as a graph file (check.ts),
 * with its paths moved from the compiled graph (`/nodes/3/config/url`) back to the author's steps
 * (`/steps/2/open/url`). Any error refuses the file.
 */
function parseScriptImport(data: unknown, existing: Workflow[], options: ImportOptions): ImportResult {
  builtIn ??= createDefaultRegistry();
  const registry = options.registry ?? builtIn;
  const { scripts, issues } = compileScriptFile(data, registry);
  if (hasErrors(issues)) return refuse(issues);
  const several = isObject(data) && Array.isArray(data.scripts);
  // Checked as one export file, so a script that another one calls is known to get its tabs from the
  // caller. Ids: the script's id or name, which is what Run Workflow names it by.
  const ids = scripts.map((script, index) => script.scriptId ?? script.workflow?.name ?? `script-${index + 1}`);
  const byName = new Map(scripts.flatMap((script, index) => [script.scriptId, script.workflow?.name].filter(Boolean).map((key) => [key as string, ids[index] as string])));
  const asFile = {
    format: EXPORT_FORMAT,
    version: 1,
    workflows: scripts.map((script, index) => {
      const workflow = script.workflow as Workflow;
      const nodes = workflow.nodes.map((node) => {
        const called = node.config.workflow;
        return node.type === 'run-workflow' && typeof called === 'string' && byName.has(called) ? { ...node, config: { ...node.config, workflow: byName.get(called) } } : node;
      });
      return { ...workflow, id: ids[index], nodes };
    }),
  };
  const found = checkFile(asFile, registry, { workflowIds: existing.map((workflow) => workflow.id), ...(options.secrets ? { secrets: options.secrets } : {}) });
  for (const issue of found) {
    const match = /^\/workflows\/(\d+)(.*)$/.exec(issue.path);
    const index = match ? Number(match[1]) : -1;
    const script = scripts[index];
    const base = several && index >= 0 ? `/scripts/${index}` : '';
    issues.push({ ...issue, path: script ? scriptPath(match?.[2] ?? '', script, data, base) : base });
  }
  if (hasErrors(issues)) return refuse(issues);

  const taken = existing.map((workflow) => workflow.name);
  const newIds = new Map<string, string>();
  const imported = scripts.map((script) => {
    const compiled = script.workflow as Workflow;
    const name = uniqueName(compiled.name, taken);
    taken.push(name);
    const copy = cloneWorkflow(compiled, name);
    if (script.scriptId) newIds.set(script.scriptId, copy.id);
    if (!newIds.has(compiled.name)) newIds.set(compiled.name, copy.id);
    return copy;
  });
  for (const workflow of imported) {
    for (const node of workflow.nodes) {
      const called = node.config.workflow;
      if (node.type === 'run-workflow' && typeof called === 'string' && newIds.has(called)) {
        node.config = { ...node.config, workflow: newIds.get(called) };
      }
    }
  }
  return { ok: true, workflows: imported, issues };
}

/** The value at a JSON Pointer, or undefined. */
function atPointer(data: unknown, path: string): unknown {
  let value = data;
  for (const part of path.split('/').slice(1)) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(value)) value = value[Number(key)];
    else if (isObject(value)) value = value[key];
    else return undefined;
  }
  return value;
}

/**
 * A check.ts path in a compiled script's graph, as a path in the script file: block settings map to
 * the step's block key (or to the shorthand string itself), step settings to the step's `step`, a
 * connection to the step it leaves from, anything else to the script.
 */
function scriptPath(path: string, script: CompiledScript, data: unknown, base: string): string {
  const workflow = script.workflow as Workflow;
  const match = /^\/(nodes|edges)\/(\d+)(\/[^/]+)?(\/.*)?$/.exec(path);
  if (!match) return base;
  const [, list, index, key = '', rest = ''] = match;
  const nodeId = list === 'nodes' ? workflow.nodes[Number(index)]?.id : workflow.edges[Number(index)]?.source;
  const step = nodeId ? script.nodePaths[nodeId] : undefined;
  if (!nodeId || !step) return base;
  if (list === 'nodes' && key === '/config') {
    const config = script.configPaths[nodeId] ?? step;
    return isObject(atPointer(data, config)) ? `${config}${rest}` : config;
  }
  if (list === 'nodes' && key === '/step') return `${step}/step${rest}`;
  return step;
}
