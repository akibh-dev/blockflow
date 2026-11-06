import { createDefaultRegistry } from './blocks';
import { uid } from './id';
import { pointer } from './issues';
import type { Issue } from './issues';
import { layoutWorkflow } from './layout';
import { migrateNode } from './migrate';
import { DEFAULT_PORT, ERROR_PORT, edgePort, nodePorts } from './ports';
import type { BlockRegistry } from './registry';
import type { AnyBlockDefinition, EdgeDef, NodeDef, StepSettings, Workflow } from './types';

/**
 * The script format: a workflow written as a list of steps instead of nodes and edges (PLAN.md §8.5).
 * The recommended format for people and LLMs; the editor still stores and shows a graph.
 *
 * ```json
 * { "format": "blockflow-script", "version": 1, "name": "Login test",
 *   "steps": [
 *     { "open": "https://example.com/login" },
 *     { "click": "role=button[name=\"Sign in\"]" },
 *     { "if": { "left": "{{url}}", "operator": "contains", "right": "/home" },
 *       "true": [ { "log": "in" } ], "false": [ { "notify": "login failed" } ] },
 *     { "log": "done" } ] }
 * ```
 *
 * Wiring rules (docs/wiki/Workflows-as-Scripts.md):
 * - A step connects to the next step of its list from its *continue port*: `out`, or `done` for loops
 *   (For Each, Repeat, Paginate). Other ports (`each`, `error`…) take a branch list that ends where it
 *   ends: an `each` body runs once per item, an `onError` list handles the failure.
 * - A block with no continue port (If: `true`/`false`) *rejoins*: the next step of the list is connected
 *   from the end of every branch list, and straight from each of its ports that has no list
 *   ("if without else" falls through).
 *
 * `compileScript` turns a script into a Workflow (laid out by layout.ts); `decompile` goes back when
 * the graph is a tree in this sense (null otherwise). Per-field config checks are check.ts's job; the
 * compiler reports only script-shape issues, with JSON Pointers into the script (`nodePaths` maps each
 * node id to its step so other checkers can point into the script too).
 */

export const SCRIPT_FORMAT = 'blockflow-script';
export const SCRIPT_VERSION = 1;

/** A step as written: `{ "<block type or alias>": config, id?, step?, <port>: Step[], onError?: Step[] }`. */
export type ScriptStep = Record<string, unknown>;

/** One script (what `decompile` returns and `compileScript` accepts). */
export interface Script {
  format: typeof SCRIPT_FORMAT;
  version: typeof SCRIPT_VERSION;
  /** Only used in a file of several scripts, so Run Workflow can name another script of the file. */
  id?: string;
  name: string;
  steps: ScriptStep[];
}

/** Short names for common blocks. Kept small on purpose; every block also works under its own type. */
export const SCRIPT_ALIASES: Readonly<Record<string, string>> = {
  open: 'open-url',
  goto: 'navigate',
  press: 'press-key',
  select: 'select-option',
};

/**
 * Blocks that accept a bare value instead of a config object, and the config key it goes to:
 * `{ "click": "text=Save" }` is `{ "click": { "locator": "text=Save" } }`.
 */
export const SCRIPT_SHORTHAND: Readonly<Record<string, string>> = {
  'open-url': 'url',
  navigate: 'url',
  click: 'locator',
  check: 'locator',
  'wait-for': 'locator',
  'press-key': 'key',
  'run-script': 'code',
  'run-workflow': 'workflow',
  'for-each': 'list',
  repeat: 'times',
  log: 'message',
  notify: 'message',
};

/** Branch key for the error output (`step.onError: "port"`). */
export const ERROR_BRANCH = 'onError';
/** Keys of a step that are not the block. */
const RESERVED = new Set(['id', 'step']);

/** Result of compiling one script. */
export interface CompiledScript {
  /** Missing when there are errors. Node ids are the authors' `id`s (or s1, s2…), also kept as `origin`. */
  workflow?: Workflow;
  issues: Issue[];
  /** Node id → JSON Pointer of its step in the file, e.g. `/steps/2/true/0`. */
  nodePaths: Record<string, string>;
  /** Node id → JSON Pointer of its config (the value under the block key; may be a shorthand string). */
  configPaths: Record<string, string>;
  /** The script's `id` (several scripts in one file), for Run Workflow references. */
  scriptId?: string;
}

/** A deep copy of JSON data. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for `{ "format": "blockflow-script", … }` or a bare `{ "steps": [...] }` without nodes. */
export function isScriptFile(data: unknown): boolean {
  if (!isObject(data)) return false;
  if (data.format === SCRIPT_FORMAT) return true;
  return Array.isArray(data.steps) && !('nodes' in data);
}

/** The continue port of a block: `out`, or `done` for loops; undefined for If (it rejoins). */
export function continuePort(ports: string[]): string | undefined {
  if (ports.includes(DEFAULT_PORT)) return DEFAULT_PORT;
  if (ports.includes('done')) return 'done';
  return undefined;
}

/** Optimal string alignment (Damerau-Levenshtein) distance. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, d[i - 2]![j - 2]! + 1);
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}

/** The closest candidate within 2 edits (case-insensitive, `_`/space = `-`), or undefined. */
export function didYouMean(word: string, candidates: string[]): string | undefined {
  const norm = (text: string) => text.toLowerCase().replace(/[_\s]+/g, '-');
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of candidates) {
    const distance = editDistance(norm(word), norm(candidate));
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Block type for a step key (type or alias), or undefined. */
function resolveType(key: string, registry: BlockRegistry): string | undefined {
  if (registry.has(key)) return key;
  const aliased = SCRIPT_ALIASES[key];
  return aliased && registry.has(aliased) ? aliased : undefined;
}

/** Ports of a block that a step can give branch lists for (declared ports and `error`). */
function declaredPorts(def: AnyBlockDefinition): string[] {
  return nodePorts(def, {});
}

interface Exit {
  node: string;
  port: string;
}

/**
 * Compiles one script object (`{ format, version, name, steps }`). `base` prefixes every issue path
 * (`/scripts/0` in a file of several scripts).
 */
export function compileScript(raw: unknown, registry: BlockRegistry = createDefaultRegistry(), base = ''): CompiledScript {
  const issues: Issue[] = [];
  const nodePaths: Record<string, string> = {};
  const configPaths: Record<string, string> = {};
  const fail = (): CompiledScript => ({ issues, nodePaths, configPaths });
  const issue = (code: string, path: string, message: string, hint?: string, level: Issue['level'] = 'error') =>
    issues.push({ level, code, path: base + path, message, ...(hint ? { hint } : {}) });

  if (!isObject(raw)) {
    issue('script.shape', '', 'A script must be a JSON object with "steps".');
    return fail();
  }
  if (raw.format !== undefined && raw.format !== SCRIPT_FORMAT) {
    issue('script.shape', pointer('format'), `"format" must be "${SCRIPT_FORMAT}".`);
  }
  if (raw.version !== undefined && raw.version !== SCRIPT_VERSION) {
    issue('script.version', pointer('version'), `Script version ${JSON.stringify(raw.version)} is not supported.`, `Use "version": ${SCRIPT_VERSION}.`);
  }
  if (raw.name !== undefined && typeof raw.name !== 'string') issue('script.shape', pointer('name'), '"name" must be a string.');
  if (!Array.isArray(raw.steps)) {
    issue('script.shape', pointer('steps'), 'A script needs "steps": a list of steps.', 'Example: "steps": [ { "open": "https://example.com" } ]');
    return fail();
  }
  if (raw.steps.length === 0) issue('script.empty', pointer('steps'), 'The script has no steps.', undefined, 'warning');

  const nodes: NodeDef[] = [];
  const edges: EdgeDef[] = [];
  const knownTypes = [...registry.list().map((def) => def.type), ...Object.keys(SCRIPT_ALIASES)];

  // Author ids first, so generated ids (s<N>) never collide with them.
  const authorIds = new Set<string>();
  const collectIds = (list: unknown[]) => {
    for (const step of list) {
      if (!isObject(step)) continue;
      if (typeof step.id === 'string' && step.id) authorIds.add(step.id);
      for (const value of Object.values(step)) if (Array.isArray(value)) collectIds(value);
    }
  };
  collectIds(raw.steps);
  const usedIds = new Set<string>();
  let counter = 0;

  const connect = (from: Exit, target: string) => {
    const edge: EdgeDef = { id: `e${edges.length + 1}`, source: from.node, target };
    if (from.port !== DEFAULT_PORT) edge.sourcePort = from.port;
    edges.push(edge);
  };

  /** Compiles a list; returns its first node and its open ends (to connect to whatever follows). */
  const compileList = (list: unknown[], path: (string | number)[]): { first?: string; exits: Exit[] } => {
    let first: string | undefined;
    let exits: Exit[] = [];
    list.forEach((step, index) => {
      const compiled = compileStep(step, [...path, index]);
      if (!compiled) {
        exits = [];
        return;
      }
      if (index === 0) first = compiled.id;
      for (const exit of exits) connect(exit, compiled.id);
      exits = compiled.exits;
    });
    return { first, exits };
  };

  const compileStep = (step: unknown, path: (string | number)[]): { id: string; exits: Exit[] } | null => {
    counter += 1;
    const at = pointer(...path);
    if (!isObject(step)) {
      issue('step.shape', at, 'A step must be an object like { "click": "text=Save" }.');
      return null;
    }
    if (ERROR_BRANCH in step && !Array.isArray(step[ERROR_BRANCH])) {
      issue('step.shape', pointer(...path, ERROR_BRANCH), '"onError" must be a list of steps.');
      return null;
    }
    const blockKeys = Object.keys(step).filter((key) => !RESERVED.has(key) && !Array.isArray(step[key]));
    if (blockKeys.length !== 1) {
      const known = blockKeys.filter((key) => resolveType(key, registry));
      issue(
        'step.shape',
        at,
        blockKeys.length === 0 ? 'This step has no block: write { "<block type>": settings }.' : `A step must have exactly one block, this one has ${blockKeys.map((key) => `"${key}"`).join(', ')}.`,
        known.length > 1 ? 'Split it into one step per block.' : undefined,
      );
      return null;
    }
    const key = blockKeys[0] as string;
    const type = resolveType(key, registry);
    if (!type) {
      const guess = didYouMean(key, knownTypes);
      issue('node.type.unknown', pointer(...path, key), `Unknown block "${key}".`, guess ? `Did you mean "${guess}"?` : 'See docs/guide/blocks.md for the block types.');
      return null;
    }
    const def = registry.get(type) as AnyBlockDefinition;

    // id
    let id: string;
    if (step.id !== undefined && (typeof step.id !== 'string' || !step.id.trim())) {
      issue('step.shape', pointer(...path, 'id'), '"id" must be a non-empty string.');
    }
    if (typeof step.id === 'string' && step.id.trim()) {
      id = step.id;
      if (usedIds.has(id)) {
        issue('node.id.duplicate', pointer(...path, 'id'), `Two steps have the id "${id}".`, 'Give every step a different id.');
        return null;
      }
    } else {
      id = `s${counter}`;
      for (let n = 2; authorIds.has(id) || usedIds.has(id); n += 1) id = `s${counter}-${n}`;
    }
    usedIds.add(id);

    // config
    const value = step[key];
    let config: Record<string, unknown>;
    if (isObject(value)) config = value;
    else if (value === null || value === undefined) config = {};
    else if (SCRIPT_SHORTHAND[type] && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
      config = { [SCRIPT_SHORTHAND[type] as string]: value };
    } else {
      const short = SCRIPT_SHORTHAND[type];
      issue(
        'step.shape',
        pointer(...path, key),
        `The settings of "${key}" must be an object${short ? ` or a value for "${short}"` : ''}.`,
        short ? undefined : `Write { "${key}": { …settings } }.`,
      );
      return null;
    }

    // step settings
    let settings: StepSettings | undefined;
    if (step.step !== undefined) {
      if (isObject(step.step)) settings = { ...(step.step as StepSettings) };
      else issue('step.shape', pointer(...path, 'step'), '"step" must be an object of step settings, e.g. { "retries": 2 }.');
    }

    // branches
    const ports = declaredPorts(def);
    const next = continuePort(ports);
    const branches: [string, unknown[], (string | number)[]][] = [];
    for (const [branchKey, list] of Object.entries(step)) {
      if (!Array.isArray(list)) continue;
      const port = branchKey === ERROR_BRANCH || branchKey === ERROR_PORT ? ERROR_PORT : branchKey;
      const branchPath = [...path, branchKey];
      if (port === ERROR_PORT) {
        if (settings?.onError && settings.onError !== 'port') {
          issue('step.onError.conflict', pointer(...path, 'step', 'onError'), `An "onError" list needs step.onError "port", not "${settings.onError}".`, 'Remove step.onError (the list sets it) or the "onError" list.');
          continue;
        }
        settings = { ...settings, onError: 'port' };
      } else if (!ports.includes(port)) {
        const guess = didYouMean(branchKey, [...ports.filter((candidate) => candidate !== next), ERROR_BRANCH]);
        issue(
          'edge.port.unknown',
          pointer(...branchPath),
          `"${key}" has no output "${branchKey}". Its branch keys: ${[...ports.filter((candidate) => candidate !== next && candidate !== ERROR_PORT), ERROR_BRANCH].map((candidate) => `"${candidate}"`).join(', ')}.`,
          guess ? `Did you mean "${guess}"?` : undefined,
        );
        continue;
      } else if (port === next) {
        issue(
          'step.branch.next',
          pointer(...branchPath),
          `"${branchKey}" is where the next step connects; it takes no list.`,
          `Put these steps after this step, in the same list.`,
        );
        continue;
      }
      branches.push([port, list, branchPath]);
    }

    // Old key names (selector → locator…) are moved before defaults fill in the rest (migrate.ts).
    const authored = migrateNode({ id, type, position: { x: 0, y: 0 }, config: copy(config) }).config;
    const node: NodeDef = { id, type, position: { x: 0, y: 0 }, config: { ...copy(def.defaultConfig as Record<string, unknown>), ...authored }, origin: id };
    if (settings && Object.keys(settings).length > 0) node.step = settings;
    nodes.push(node);
    nodePaths[id] = base + at;
    configPaths[id] = base + pointer(...path, key);

    // Branches in the order they are written (generated ids count steps top to bottom).
    const compiledBranches = new Map<string, { first?: string; exits: Exit[] }>();
    for (const [port, list, branchPath] of branches) {
      const compiled = compileList(list, branchPath);
      compiledBranches.set(port, compiled);
      if (compiled.first) connect({ node: id, port }, compiled.first);
    }
    // What flows on to the next step: the continue port, or (If) the end of each branch, or the
    // port itself when it has no list.
    const exits: Exit[] = next ? [{ node: id, port: next }] : [];
    if (!next) {
      for (const port of ports) {
        if (port === ERROR_PORT) continue;
        const compiled = compiledBranches.get(port);
        if (compiled?.first) exits.push(...compiled.exits);
        else exits.push({ node: id, port });
      }
    }
    return { id, exits };
  };

  compileList(raw.steps, ['steps']);
  if (issues.some((entry) => entry.level === 'error')) return fail();

  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Imported script';
  const workflow = layoutWorkflow({ schemaVersion: 2, id: uid(), name, enabled: false, nodes, edges }, registry);
  return { workflow, issues, nodePaths, configPaths, ...(typeof raw.id === 'string' ? { scriptId: raw.id } : {}) };
}

/** Compiles a script file: one script, or `{ "format": "blockflow-script", "scripts": [ … ] }`. */
export function compileScriptFile(raw: unknown, registry: BlockRegistry = createDefaultRegistry()): { scripts: CompiledScript[]; issues: Issue[] } {
  if (isObject(raw) && Array.isArray(raw.scripts)) {
    const issues: Issue[] = [];
    if (raw.version !== undefined && raw.version !== SCRIPT_VERSION) {
      issues.push({ level: 'error', code: 'script.version', path: pointer('version'), message: `Script version ${JSON.stringify(raw.version)} is not supported.`, hint: `Use "version": ${SCRIPT_VERSION}.` });
    }
    const scripts = raw.scripts.map((script, index) =>
      compileScript(isObject(script) ? { format: SCRIPT_FORMAT, ...script } : script, registry, pointer('scripts', index)),
    );
    if (scripts.length === 0) issues.push({ level: 'error', code: 'script.shape', path: pointer('scripts'), message: 'The file has no scripts.' });
    return { scripts, issues: [...issues, ...scripts.flatMap((script) => script.issues)] };
  }
  const script = compileScript(raw, registry);
  return { scripts: [script], issues: script.issues };
}

// ---------------------------------------------------------------------------
// Decompile: graph → script
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

/** Normalised step settings: undefined when empty. */
function stepOf(node: NodeDef): StepSettings | undefined {
  return node.step && Object.keys(node.step).length > 0 ? node.step : undefined;
}

/**
 * True when two workflows are the same graph up to node ids being matched by `idOf`: same block types,
 * configs (with defaults filled in), step settings and connections (by port).
 */
export function sameScriptGraph(a: Workflow, b: Workflow, registry: BlockRegistry, idOf: { a: (node: NodeDef) => string; b: (node: NodeDef) => string } = { a: (n) => n.id, b: (n) => n.id }): boolean {
  if (a.nodes.length !== b.nodes.length) return false;
  const describe = (workflow: Workflow, key: (node: NodeDef) => string) => {
    const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
    const nodes = new Map<string, unknown>();
    for (const node of workflow.nodes) {
      const def = registry.get(node.type);
      nodes.set(key(node), { type: node.type, config: { ...(def?.defaultConfig ?? {}), ...node.config }, step: stepOf(node) ?? {} });
    }
    const edges = new Set<string>();
    for (const edge of workflow.edges) {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (!source || !target) return null;
      edges.add(`${key(source)}\u0000${edgePort(edge, nodePorts(registry.get(source.type), source))}\u0000${key(target)}`);
    }
    return { nodes, edges };
  };
  const left = describe(a, idOf.a);
  const right = describe(b, idOf.b);
  if (!left || !right || left.nodes.size !== a.nodes.length || right.nodes.size !== b.nodes.length) return false;
  if (left.edges.size !== right.edges.size || [...left.edges].some((edge) => !right.edges.has(edge))) return false;
  return [...left.nodes].every(([id, value]) => deepEqual(value, right.nodes.get(id)));
}

/**
 * The workflow as a script, or null when its graph cannot be written as one (several start blocks,
 * one output feeding several blocks, joins other than after an If, cycles…). The result compiles back
 * to the same graph (checked here), with step ids from `origin` (or readable node ids).
 */
export function decompile(workflow: Workflow, registry: BlockRegistry = createDefaultRegistry()): Script | null {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const portsOf = (node: NodeDef) => nodePorts(registry.get(node.type), node);
  if (workflow.nodes.some((node) => !registry.has(node.type))) return null;

  // Outgoing edges by node and port; in-degree.
  const out = new Map<string, Map<string, string[]>>();
  const inDegree = new Map<string, number>(workflow.nodes.map((node) => [node.id, 0]));
  for (const edge of workflow.edges) {
    const source = byId.get(edge.source);
    if (!source || !byId.has(edge.target)) return null;
    const port = edgePort(edge, portsOf(source));
    const ports = out.get(source.id) ?? new Map<string, string[]>();
    ports.set(port, [...(ports.get(port) ?? []), edge.target]);
    out.set(source.id, ports);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }
  const targetOf = (id: string, port: string): string | undefined | null => {
    const targets = out.get(id)?.get(port) ?? [];
    if (targets.length > 1) return null; // fan-out: not expressible
    return targets[0];
  };

  // Step ids: the author's (origin) when unique, else the node id.
  const origins = new Map<string, number>();
  for (const node of workflow.nodes) if (node.origin) origins.set(node.origin, (origins.get(node.origin) ?? 0) + 1);
  const stepId = (node: NodeDef) => (node.origin && origins.get(node.origin) === 1 ? node.origin : node.id);

  const reach = new Map<string, Set<string>>();
  const reachable = (start: string): Set<string> => {
    const cached = reach.get(start);
    if (cached) return cached;
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const targets of out.get(id)?.values() ?? []) stack.push(...targets);
    }
    reach.set(start, seen);
    return seen;
  };

  const visited = new Set<string>();
  let broken = false;

  const build = (start: string | undefined, stop: string | undefined): ScriptStep[] => {
    const steps: ScriptStep[] = [];
    let current = start;
    while (current !== undefined && current !== stop && !broken) {
      if (visited.has(current)) {
        broken = true;
        break;
      }
      visited.add(current);
      const node = byId.get(current) as NodeDef;
      const def = registry.get(node.type) as AnyBlockDefinition;
      const ports = portsOf(node);
      const next = continuePort(ports);
      const step = stepFor(node, def, stepId(node));
      const branches: Record<string, ScriptStep[]> = {};
      let following: string | undefined;

      if (next) {
        for (const port of ports) {
          if (port === next) continue;
          const target = targetOf(current, port);
          if (target === null) broken = true;
          else if (target !== undefined) branches[port] = build(target, undefined);
        }
        const target = targetOf(current, next);
        if (target === null) broken = true;
        else following = target;
      } else {
        const declared = ports.filter((port) => port !== ERROR_PORT);
        const targets = declared.map((port) => targetOf(current as string, port));
        if (targets.some((target) => target === null)) {
          broken = true;
          break;
        }
        // The join: the first node every branch reaches (only when every port is connected).
        let join: string | undefined;
        if (targets.every((target) => typeof target === 'string')) {
          const sets = (targets as string[]).map(reachable);
          const common = [...(sets[0] ?? [])].filter((id) => sets.every((set) => set.has(id)));
          join = common.find((candidate) => common.every((other) => reachable(candidate).has(other)));
        }
        declared.forEach((port, index) => {
          const target = targets[index];
          if (typeof target === 'string' && target !== join) branches[port] = build(target, join);
        });
        if (ports.includes(ERROR_PORT)) {
          const target = targetOf(current, ERROR_PORT);
          if (target === null) broken = true;
          else if (target !== undefined) branches[ERROR_PORT] = build(target, undefined);
        }
        following = join;
      }
      // Branch keys in port order, with "onError" for the error output (which then implies step.onError).
      for (const port of ports) {
        const list = branches[port];
        if (!list) continue;
        if (port === ERROR_PORT) {
          step[ERROR_BRANCH] = list;
          const settings = { ...(step.step as StepSettings | undefined) };
          delete settings.onError;
          if (Object.keys(settings).length > 0) step.step = settings;
          else delete step.step;
        } else step[port] = list;
      }
      steps.push(step);
      current = following;
    }
    return steps;
  };

  const roots = workflow.nodes.filter((node) => inDegree.get(node.id) === 0);
  if (workflow.nodes.length > 0 && roots.length !== 1) return null;
  const steps = build(roots[0]?.id, undefined);
  if (broken || visited.size !== workflow.nodes.length) return null;

  const script: Script = { format: SCRIPT_FORMAT, version: SCRIPT_VERSION, name: workflow.name, steps };
  // Check: the script compiles back to this graph.
  const compiled = compileScript(script, registry);
  if (!compiled.workflow || !sameScriptGraph(workflow, compiled.workflow, registry, { a: stepId, b: (node) => node.id })) return null;
  dropGeneratedIds(script.steps, { n: 0 });
  return script;
}

/** One step for a node: alias and shorthand when they fit, config without default values. */
function stepFor(node: NodeDef, def: AnyBlockDefinition, id: string): ScriptStep {
  const defaults = def.defaultConfig as Record<string, unknown>;
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.config)) {
    if (!deepEqual(value, defaults[key])) config[key] = value;
  }
  const alias = Object.entries(SCRIPT_ALIASES).find(([, type]) => type === node.type)?.[0];
  const key = alias ?? node.type;
  const short = SCRIPT_SHORTHAND[node.type];
  const keys = Object.keys(config);
  const value = short && keys.length === 1 && keys[0] === short && ['string', 'number', 'boolean'].includes(typeof config[short]) ? config[short] : config;
  const step: ScriptStep = { id, [key]: value };
  const settings = stepOf(node);
  if (settings) step.step = { ...settings };
  return step;
}

/** Removes ids a compile would generate anyway (`s<N>` for the Nth step, top to bottom) and node uuids. */
function dropGeneratedIds(steps: ScriptStep[], counter: { n: number }): void {
  for (const step of steps) {
    counter.n += 1;
    if (typeof step.id === 'string' && (step.id === `s${counter.n}` || UUID.test(step.id))) delete step.id;
    for (const value of Object.values(step)) if (Array.isArray(value)) dropGeneratedIds(value as ScriptStep[], counter);
  }
}
