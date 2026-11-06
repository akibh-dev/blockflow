import { withDefaults } from './config';
import { pointer } from './issues';
import { ENGINES, LocatorSyntaxError, parseLocatorSteps } from './locatorSyntax';
import { CURRENT_SCHEMA_VERSION, RENAMED_KEYS } from './migrate';
import { nodePorts, DEFAULT_PORT, ERROR_PORT } from './ports';
import { DEFAULT_TAB } from './session';
import { didYouMean } from './suggest';
import { hasTemplate, templateErrors } from './template';
import { normalizeHttpUrl } from './url';
import type { Issue, IssueLevel } from './issues';
import type { BlockRegistry } from './registry';
import type { AnyBlockDefinition, FieldSpec, RowsField } from './types';

/**
 * Strict checking of a workflow file as its author wrote it (an export file or one bare workflow),
 * before import replaces the ids. Every problem is an `Issue` with a stable code and a JSON Pointer
 * into the file, so a person or an LLM can repair the file without guessing. Pure, no browser APIs.
 *
 * Levels: errors block the import (the file would not work as written); warnings import with a
 * banner (it may work, e.g. a sub-workflow that gets its tab from its caller); info is a note (an old
 * key name that was moved). The codes are listed in docs/guide/README.md ("Repair").
 */

/** What `checkFile` may know about the place the file is imported into. */
export interface CheckOptions {
  /** Ids of workflows that already exist, so Run Workflow may call them. */
  workflowIds?: Iterable<string>;
  /** Names of the user's secrets. When given, `{{secret.x}}` with an unknown name is a warning. */
  secrets?: Iterable<string>;
}

/** The `format` of an export file (library.ts writes it). */
export const EXPORT_FORMAT = 'blockflow-workflows';

const EXPORT_KEYS = ['format', 'version', 'workflows'];
const WORKFLOW_KEYS = ['schemaVersion', 'id', 'name', 'enabled', 'nodes', 'edges'];
const NODE_KEYS = ['id', 'type', 'position', 'config', 'step', 'origin'];
const EDGE_KEYS = ['id', 'source', 'target', 'sourcePort'];
/** Names other tools use for the same thing (React Flow, n8n, guesses), checked before edit distance. */
const ALIASES: Record<string, string> = {
  settings: 'config',
  params: 'config',
  parameters: 'config',
  props: 'config',
  options: 'config',
  from: 'source',
  to: 'target',
  sourceHandle: 'sourcePort',
  port: 'sourcePort',
  output: 'sourcePort',
  blocks: 'nodes',
  steps: 'nodes',
  connections: 'edges',
  links: 'edges',
  kind: 'type',
};

/** Step settings: key → the problem with a value, or null. Mirrors `StepSettings` in types.ts. */
const STEP_RULES: Record<string, (value: unknown) => string | null> = {
  timeoutSeconds: (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? null : 'must be a number of seconds above 0'),
  retries: (value) => (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 5 ? null : 'must be a whole number from 0 to 5'),
  onError: (value) => (value === 'stop' || value === 'continue' || value === 'port' ? null : 'must be "stop", "continue" or "port"'),
  disabled: (value) => (typeof value === 'boolean' ? null : 'must be true or false'),
  note: (value) => (typeof value === 'string' ? null : 'must be text'),
  screenshot: (value) => (value === 'error' || value === 'always' || value === 'never' ? null : 'must be "error", "always" or "never"'),
  realInput: (value) => (typeof value === 'boolean' ? null : 'must be true or false'),
};

/** Blocks that give the run a named tab: type → the tab name from its config. */
const TAB_PROVIDERS: Record<string, (config: Record<string, unknown>) => string> = {
  'open-url': (config) => tabName(config.tab),
  'wait-for-popup': (config) => tabName(config.name),
  'page-visited': () => DEFAULT_TAB,
  'context-menu': () => DEFAULT_TAB,
};

function tabName(value: unknown): string {
  return (typeof value === 'string' && value.trim()) || DEFAULT_TAB;
}

/** The tab a block acts on, or null when it does not need one (with these settings). */
function neededTab(def: AnyBlockDefinition, config: Record<string, unknown>): string | null {
  if (!def.fields.some((field) => field.key === 'tab')) return null;
  // Open Tab names its tab; Close Tab only logs when the tab is missing.
  if (def.type === 'open-url' || def.type === 'close-tab') return null;
  if (def.type === 'read-element' && typeof config.url === 'string' && config.url.trim()) return null;
  // Assert on a value from the data looks at no page.
  if (def.type === 'assert' && config.subject === 'value') return null;
  if ('source' in config && config.source === 'html') return null;
  return tabName(config.tab);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Hint for an unknown key: an alias, the closest valid key, or the list of valid keys. */
function keyHint(key: string, valid: string[]): string {
  const alias = ALIASES[key];
  if (alias && valid.includes(alias)) return `Did you mean "${alias}"?`;
  return didYouMean(key, valid) ?? (valid.length > 0 ? `Valid keys: ${valid.join(', ')}.` : 'This block has no settings.');
}

/** `type` → readable slugs of each block's label ("open-tab" for Open Tab), for type suggestions. */
function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * The problem with a locator string, or null. Templated locators (`{{…}}`) are only checked once
 * rendered, at run time. Catches what makes a locator silently match nothing or throw in the page.
 */
export function locatorProblem(source: string): { message: string; hint?: string } | null {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '(') depth += 1;
    else if (char === ']' || char === ')') depth -= 1;
    if (depth < 0) return { message: `Locator "${source}" closes a bracket it never opened` };
  }
  if (quote) return { message: `Locator "${source}" has an unclosed ${quote} quote` };
  if (depth > 0) return { message: `Locator "${source}" has an unclosed bracket` };
  let steps;
  try {
    steps = parseLocatorSteps(source);
  } catch (error) {
    if (error instanceof LocatorSyntaxError) return { message: error.message, hint: 'Steps are joined with >>, e.g. role=list >> text=Total' };
    throw error;
  }
  for (const step of steps) {
    if (step.engine === 'css') {
      // `rol=button` is not CSS (a bare "=" only belongs inside [attribute=value]): a mistyped engine.
      const engine = /^([a-zA-Z-]+)\s*=/.exec(step.body)?.[1];
      if (engine) {
        return {
          message: `Locator "${source}" uses "${engine}=", which is not a locator engine`,
          hint: didYouMean(engine, ENGINES) ?? `Engines: ${[...ENGINES].join(', ')}. Or plain CSS.`,
        };
      }
      continue;
    }
    if (!step.body) return { message: `Locator "${source}": "${step.engine}=" needs a value` };
    if (step.engine === 'nth' && !/^-?\d+$/.test(step.body)) return { message: `Locator "${source}": nth= takes a number (0 = first, -1 = last)` };
  }
  return null;
}

/** Template problems in a value: unbalanced braces, then bad expressions. */
function templateProblems(text: string): string[] {
  const open = text.split('{{').length - 1;
  const close = text.split('}}').length - 1;
  if (open !== close) return [`"{{" and "}}" do not pair up (${open} opening, ${close} closing)`];
  return templateErrors(text);
}

/** Collects issues; the helpers below share it. */
class Checker {
  readonly issues: Issue[] = [];
  private readonly types: string[];
  private readonly slugs = new Map<string, string>();
  /** Workflow ids that a Run Workflow block in the file calls (their tabs come from the caller). */
  private readonly called = new Set<string>();

  constructor(
    private readonly registry: BlockRegistry,
    private readonly options: { workflowIds: Set<string>; secrets: Set<string> | null },
  ) {
    this.types = registry.list().map((def) => def.type);
    for (const def of registry.list()) this.slugs.set(slug(def.label), def.type);
  }

  add(level: IssueLevel, code: string, path: string, message: string, hint?: string): void {
    this.issues.push(hint ? { level, code, path, message, hint } : { level, code, path, message });
  }

  file(raw: unknown): void {
    if (!isObject(raw)) {
      this.add('error', 'file.shape', '', 'The file must be a JSON object: an export file {"format", "workflows": [...]} or one workflow {"name", "nodes", "edges"}.');
      return;
    }
    if (!('workflows' in raw)) {
      this.workflow(raw, '', new Map());
      return;
    }
    if (raw.format !== undefined && raw.format !== EXPORT_FORMAT) {
      this.add('error', 'file.shape', pointer('format'), `Unknown file format "${String(raw.format)}".`, `Use "format": "${EXPORT_FORMAT}".`);
    }
    for (const key of Object.keys(raw)) {
      if (!EXPORT_KEYS.includes(key)) this.add('warning', 'file.key.unknown', pointer(key), `Unknown key "${key}" in the export file; it is ignored.`, keyHint(key, EXPORT_KEYS));
    }
    if (!Array.isArray(raw.workflows)) {
      this.add('error', 'file.shape', pointer('workflows'), '"workflows" must be a list of workflows.');
      return;
    }
    if (raw.workflows.length === 0) {
      this.add('error', 'file.shape', pointer('workflows'), 'No workflows found in this file.');
      return;
    }
    // Run Workflow may call any workflow in the same file, by its id or (for the hint) its name.
    const inFile = new Map<string, string>();
    for (const workflow of raw.workflows) {
      if (!isObject(workflow)) continue;
      if (typeof workflow.id === 'string') inFile.set(workflow.id, typeof workflow.name === 'string' ? workflow.name : '');
      for (const node of Array.isArray(workflow.nodes) ? workflow.nodes : []) {
        if (isObject(node) && node.type === 'run-workflow' && isObject(node.config) && typeof node.config.workflow === 'string') this.called.add(node.config.workflow.trim());
      }
    }
    raw.workflows.forEach((workflow, index) => this.workflow(workflow, pointer('workflows', index), inFile));
  }

  private workflow(raw: unknown, base: string, inFile: Map<string, string>): void {
    if (!isObject(raw)) {
      this.add('error', 'file.shape', base, 'A workflow must be an object with "name", "nodes" and "edges".');
      return;
    }
    const label = typeof raw.name === 'string' ? `Workflow "${raw.name}"` : 'The workflow';
    for (const key of Object.keys(raw)) {
      if (!WORKFLOW_KEYS.includes(key)) this.add('warning', 'file.key.unknown', `${base}${pointer(key)}`, `Unknown key "${key}" in a workflow; it is ignored.`, keyHint(key, WORKFLOW_KEYS));
    }
    if (raw.name !== undefined && typeof raw.name !== 'string') this.add('error', 'file.shape', `${base}${pointer('name')}`, 'The workflow name must be text.');
    const version = raw.schemaVersion;
    if (version !== undefined && !(typeof version === 'number' && Number.isInteger(version) && version >= 1)) {
      this.add('error', 'file.shape', `${base}${pointer('schemaVersion')}`, '"schemaVersion" must be a whole number.', `Use ${CURRENT_SCHEMA_VERSION}, or leave it out.`);
    } else if (typeof version === 'number' && version > CURRENT_SCHEMA_VERSION) {
      this.add('error', 'file.shape', `${base}${pointer('schemaVersion')}`, `This file was made by a newer BlockFlow (schema ${version}; this one reads up to ${CURRENT_SCHEMA_VERSION}).`, 'Update BlockFlow.');
    }
    if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
      const missing = !Array.isArray(raw.nodes) ? 'nodes' : 'edges';
      this.add('error', 'file.shape', `${base}${pointer(missing)}`, `${label} needs "${missing}" as a list${missing === 'edges' ? ' (use [] for none)' : ''}.`);
      return;
    }

    const nodes = this.nodes(raw.nodes, base, inFile);
    this.graph(raw.edges, base, nodes, typeof raw.id === 'string' && this.called.has(raw.id));
  }

  /** Checks every node; returns the valid ones by id (with index, definition and migrated config). */
  private nodes(list: unknown[], base: string, inFile: Map<string, string>): Map<string, CheckedNode> {
    const byId = new Map<string, CheckedNode>();
    list.forEach((raw, index) => {
      const path = `${base}${pointer('nodes', index)}`;
      if (!isObject(raw)) {
        this.add('error', 'file.shape', path, 'A block must be an object with "id", "type" and "config".');
        return;
      }
      for (const key of Object.keys(raw)) {
        if (!NODE_KEYS.includes(key)) this.add('warning', 'file.key.unknown', `${path}${pointer(key)}`, `Unknown key "${key}" on a block; it is ignored.`, keyHint(key, NODE_KEYS));
      }
      if (typeof raw.id !== 'string' || !raw.id) {
        this.add('error', 'file.shape', `${path}${pointer('id')}`, 'Every block needs an "id" (any text unique in the workflow).');
        return;
      }
      const id = raw.id;
      if (typeof raw.type !== 'string') {
        this.add('error', 'file.shape', `${path}${pointer('type')}`, `Block "${id}" needs a "type" (see blocks.md).`);
        return;
      }
      if (byId.has(id)) {
        this.add('error', 'node.id.duplicate', `${path}${pointer('id')}`, `Two blocks have the id "${id}".`, 'Give every block in a workflow its own id.');
        return;
      }
      if (raw.position !== undefined && !(isObject(raw.position) && typeof raw.position.x === 'number' && typeof raw.position.y === 'number')) {
        this.add('warning', 'file.shape', `${path}${pointer('position')}`, `Block "${id}": "position" should be {"x": number, "y": number}; it is placed at 0,0.`);
      }
      if (raw.config !== undefined && !isObject(raw.config)) {
        this.add('error', 'file.shape', `${path}${pointer('config')}`, `Block "${id}": "config" must be an object of settings.`);
        return;
      }
      if (raw.step !== undefined) this.step(raw.step, `${path}${pointer('step')}`, id);

      const def = this.registry.get(raw.type);
      const step = isObject(raw.step) ? raw.step : {};
      if (!def) {
        const hint = didYouMean(raw.type, this.types) ?? (this.slugs.has(slug(raw.type)) ? `Did you mean "${this.slugs.get(slug(raw.type))}"?` : 'See blocks.md for the block types.');
        this.add('error', 'node.type.unknown', `${path}${pointer('type')}`, `Block "${id}" has an unknown type "${raw.type}".`, hint);
        byId.set(id, { index, path, def: undefined, config: {}, step });
        return;
      }
      const config = this.config(def, isObject(raw.config) ? raw.config : {}, `${path}${pointer('config')}`, id, inFile);
      byId.set(id, { index, path, def, config, step });
    });
    return byId;
  }

  private step(raw: unknown, path: string, id: string): void {
    if (!isObject(raw)) {
      this.add('error', 'file.shape', path, `Block "${id}": "step" must be an object (timeoutSeconds, retries, onError…).`);
      return;
    }
    const known = Object.keys(STEP_RULES);
    for (const [key, value] of Object.entries(raw)) {
      const rule = STEP_RULES[key];
      if (!rule) {
        this.add('error', 'step.key.unknown', `${path}${pointer(key)}`, `Block "${id}": unknown step setting "${key}".`, didYouMean(key, known) ?? `Step settings: ${known.join(', ')}.`);
        continue;
      }
      const problem = rule(value);
      if (problem) this.add('error', 'step.value', `${path}${pointer(key)}`, `Block "${id}": step.${key} ${problem}.`);
    }
  }

  /** Checks one block's settings; returns them with renamed keys moved and defaults applied. */
  private config(def: AnyBlockDefinition, raw: Record<string, unknown>, path: string, id: string, inFile: Map<string, string>): Record<string, unknown> {
    const who = `Block "${id}" (${def.type})`;
    const config = { ...raw };
    const renamed = RENAMED_KEYS[def.type] ?? {};
    for (const [from, to] of Object.entries(renamed)) {
      if (!(from in raw)) continue;
      const both = to in raw;
      this.add('info', 'config.key.renamed', `${path}${pointer(from)}`, `${who}: "${from}" is now called "${to}"${both ? `; "${to}" is set too, so "${from}" is ignored` : ''}.`, `Use "${to}".`);
      if (!both) config[to] = config[from];
      delete config[from];
    }

    const fieldKeys = def.fields.map((field) => field.key);
    for (const key of Object.keys(raw)) {
      if (fieldKeys.includes(key) || key in renamed || def.legacyKeys?.includes(key)) continue;
      this.add('error', 'config.key.unknown', `${path}${pointer(key)}`, `${who} has no setting "${key}".`, keyHint(key, fieldKeys));
    }

    const merged = withDefaults(def, config);
    for (const field of def.fields) {
      const fieldPath = `${path}${pointer(field.key)}`;
      // Report against the key as written (`selector`) when it came from a renamed one.
      const writtenAt = field.key in raw ? fieldPath : `${path}${pointer(Object.keys(renamed).find((from) => renamed[from] === field.key && from in raw) ?? field.key)}`;
      this.field(field, config[field.key], merged[field.key], writtenAt, who);
    }

    for (const problem of def.validate?.(merged) ?? []) {
      this.add('error', problem.code, `${path}${pointer(problem.key)}`, `${who}: ${problem.message}.`);
    }

    if (def.type === 'run-workflow' && typeof merged.workflow === 'string' && merged.workflow.trim()) {
      const target = merged.workflow.trim();
      if (!inFile.has(target) && !this.options.workflowIds.has(target)) {
        const byName = [...inFile].find(([, name]) => name === target)?.[0];
        this.add(
          'error',
          'workflow.call.missing',
          `${path}${pointer('workflow')}`,
          `${who} calls workflow "${target}", which is not in this file or among your saved workflows.`,
          byName ? `Use the workflow's id "${byName}", not its name.` : didYouMean(target, inFile.keys()) ?? 'Put the called workflow in the same file (in "workflows") and use its "id".',
        );
      }
    }

    this.secrets(raw, path, who);
    return merged;
  }

  /** Type, required, enum, URL, locator and template checks for one setting. */
  private field(field: FieldSpec, value: unknown, merged: unknown, path: string, who: string): void {
    const name = `"${field.key}" (${field.label})`;
    switch (field.kind) {
      case 'number': {
        if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value)) && !(typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))) {
          this.add('error', 'config.type', path, `${who}: ${name} must be a number.`, `Write it without quotes, e.g. ${JSON.stringify(Number(value) || field.min || 1)}.`);
          return;
        }
        const number = Number(merged);
        if (field.min !== undefined && number < field.min) this.add('error', 'config.value', path, `${who}: ${name} must be at least ${field.min}.`);
        if (field.max !== undefined && number > field.max) this.add('error', 'config.value', path, `${who}: ${name} must be at most ${field.max}.`);
        return;
      }
      case 'boolean':
        if (value !== undefined && typeof value !== 'boolean') this.add('error', 'config.type', path, `${who}: ${name} must be true or false.`, 'Write true or false without quotes.');
        return;
      case 'select': {
        if (value === undefined) return;
        const options = field.options.map((option) => option.value);
        if (typeof value !== 'string' || !options.includes(value)) {
          const hint = (typeof value === 'string' && didYouMean(value, options)) || `One of: ${options.map((option) => `"${option}"`).join(', ')}.`;
          this.add('error', 'config.enum', path, `${who}: ${name} cannot be ${JSON.stringify(value)}.`, hint);
        }
        return;
      }
      case 'rows':
        this.rows(field, value, merged, path, who);
        return;
      default: {
        // text, url, selector, locator, workflow: strings.
        if (value !== undefined && typeof value !== 'string') {
          this.add('error', 'config.type', path, `${who}: ${name} must be text.`, typeof value === 'number' || typeof value === 'boolean' ? `Write it in quotes: "${String(value)}".` : undefined);
          return;
        }
        const text = typeof merged === 'string' ? merged.trim() : '';
        if (!text) {
          if (field.required) this.add('error', 'config.required', path, `${who}: ${name} is required.`);
          return;
        }
        if (value === undefined) return; // the default, not the author's
        this.text(field, text, path, who, name);
      }
    }
  }

  /** URL, locator and template checks on a non-empty string the author wrote. */
  private text(field: FieldSpec & { templated?: boolean }, text: string, path: string, who: string, name: string, locator = field.kind === 'locator' || field.kind === 'selector'): void {
    const templated = Boolean(field.templated);
    if (templated) {
      for (const problem of templateProblems(text)) this.add('error', 'config.template.invalid', path, `${who}: ${name}: ${problem}.`);
    } else if (hasTemplate(text)) {
      this.add(
        'warning',
        'config.template.unsupported',
        path,
        `${who}: ${name} does not fill in {{…}}; the braces are used as typed.`,
        field.kind === 'text' && /list|expression|value/i.test(field.key) ? 'This setting is an expression: write it without braces, e.g. items.' : undefined,
      );
    }
    if (templated && hasTemplate(text)) return; // checked once rendered, at run time
    if (field.kind === 'url' && !normalizeHttpUrl(text)) {
      this.add('error', 'config.url.invalid', path, `${who}: ${name} "${text}" is not a valid http(s) URL.`, 'Write a full address like https://example.com/page, or a {{template}}.');
    }
    if (locator) {
      const problem = locatorProblem(text);
      if (problem) this.add('error', 'config.locator.invalid', path, `${who}: ${problem.message}.`, problem.hint);
    }
  }

  private rows(field: RowsField, value: unknown, merged: unknown, path: string, who: string): void {
    const name = `"${field.key}" (${field.label})`;
    if (value !== undefined && !Array.isArray(value)) {
      this.add('error', 'config.type', path, `${who}: ${name} must be a list of rows like {${field.columns.map((column) => `"${column.key}": "…"`).join(', ')}}.`);
      return;
    }
    const rows = Array.isArray(merged) ? merged : [];
    const columns = field.columns.map((column) => column.key);
    const [first] = field.columns;
    let filled = 0;
    rows.forEach((row: unknown, index) => {
      const rowPath = `${path}${pointer(index)}`;
      if (!isObject(row)) {
        this.add('error', 'config.type', rowPath, `${who}: row ${index + 1} of ${name} must be an object like {${columns.map((key) => `"${key}": "…"`).join(', ')}}.`);
        return;
      }
      for (const key of Object.keys(row)) {
        if (!columns.includes(key)) this.add('error', 'config.key.unknown', `${rowPath}${pointer(key)}`, `${who}: rows of ${name} have no column "${key}".`, keyHint(key, columns));
      }
      const isFilled = field.columns.some((column) => String(row[column.key] ?? '').trim() !== '');
      if (!isFilled) return;
      filled += 1;
      if (first && String(row[first.key] ?? '').trim() === '') {
        this.add('error', 'config.required', `${rowPath}${pointer(first.key)}`, `${who}: row ${index + 1} of ${name} has no ${first.label} ("${first.key}").`);
      }
      if (value === undefined) return; // default rows
      for (const column of field.columns) {
        const cell = row[column.key];
        const cellPath = `${rowPath}${pointer(column.key)}`;
        if (cell === undefined) continue;
        if (typeof cell !== 'string' && typeof cell !== 'number' && typeof cell !== 'boolean') {
          this.add('error', 'config.type', cellPath, `${who}: "${column.key}" in row ${index + 1} of ${name} must be text.`);
          continue;
        }
        const text = String(cell).trim();
        if (!text) continue;
        const spec = { key: column.key, label: column.label, kind: 'text' as const, templated: column.templated };
        this.text(spec, text, cellPath, who, `"${column.key}" in row ${index + 1}`, Boolean(column.locator));
      }
    });
    if (field.required && filled === 0) this.add('error', 'config.required', path, `${who}: ${name} needs at least one row.`);
  }

  /** `{{secret.name}}` anywhere in a block's settings, against the known secret names. */
  private secrets(value: unknown, path: string, who: string): void {
    const known = this.options.secrets;
    if (!known) return;
    if (typeof value === 'string') {
      for (const [, token] of value.matchAll(/\{\{([^{}]*)\}\}/g)) {
        for (const [, secret] of (token ?? '').matchAll(/\bsecret\.([\w$-]+)/g)) {
          if (secret && !known.has(secret)) {
            this.add('warning', 'secret.unknown', path, `${who} uses the secret "${secret}", which does not exist yet.`, didYouMean(secret, known) ?? `Create a secret named "${secret}" in the Secrets tab before running.`);
          }
        }
      }
    } else if (Array.isArray(value)) value.forEach((item, index) => this.secrets(item, `${path}${pointer(index)}`, who));
    else if (isObject(value)) for (const [key, item] of Object.entries(value)) this.secrets(item, `${path}${pointer(key)}`, who);
  }

  /** Edges, then the graph as a whole: start blocks, reachability, loops, tabs. */
  private graph(list: unknown[], base: string, nodes: Map<string, CheckedNode>, isCallee: boolean): void {
    const ids = [...nodes.keys()];
    const edges: CheckedEdge[] = [];
    const seen = new Set<string>();
    list.forEach((raw, index) => {
      const path = `${base}${pointer('edges', index)}`;
      if (!isObject(raw)) {
        this.add('error', 'file.shape', path, 'A connection must be an object like {"source": "a", "target": "b"}.');
        return;
      }
      for (const key of Object.keys(raw)) {
        if (!EDGE_KEYS.includes(key)) this.add('warning', 'file.key.unknown', `${path}${pointer(key)}`, `Unknown key "${key}" on a connection; it is ignored.`, keyHint(key, EDGE_KEYS));
      }
      let broken = false;
      for (const end of ['source', 'target'] as const) {
        const id = raw[end];
        if (typeof id !== 'string') {
          this.add('error', 'file.shape', `${path}${pointer(end)}`, `A connection needs "${end}": the id of a block.`);
          broken = true;
        } else if (!nodes.has(id)) {
          this.add('error', 'edge.endpoint.missing', `${path}${pointer(end)}`, `A connection's ${end} "${id}" is not a block id.`, didYouMean(id, ids) ?? `Block ids: ${ids.join(', ')}.`);
          broken = true;
        }
      }
      if (raw.sourcePort !== undefined && typeof raw.sourcePort !== 'string') {
        this.add('error', 'file.shape', `${path}${pointer('sourcePort')}`, '"sourcePort" must be the name of an output, e.g. "true".');
        broken = true;
      }
      if (broken) return;
      const source = nodes.get(raw.source as string) as CheckedNode;
      const target = nodes.get(raw.target as string) as CheckedNode;
      const port = typeof raw.sourcePort === 'string' && raw.sourcePort ? raw.sourcePort : undefined;
      if (source.def) {
        const ports = nodePorts(source.def, { step: source.step });
        if (port !== undefined && !ports.includes(port)) {
          if (port === ERROR_PORT) {
            this.add('error', 'edge.port.unknown', `${path}${pointer('sourcePort')}`, `Block "${raw.source}" has no "error" output, so this connection never runs.`, 'Set "step": {"onError": "port"} on the source block.');
          } else {
            this.add(
              'error',
              'edge.port.unknown',
              `${path}${pointer('sourcePort')}`,
              `Block "${raw.source}" (${source.def.type}) has no output "${port}".`,
              didYouMean(port, ports) ?? `Its outputs: ${ports.map((name) => `"${name}"`).join(', ')}.`,
            );
          }
          return;
        }
      }
      if (raw.source === raw.target) {
        this.add('error', 'graph.cycle', path, `Block "${raw.source}" is connected to itself.`, 'Remove this connection. For loops use Repeat, For Each or Paginate.');
        return;
      }
      if (target.def && !target.def.run) {
        this.add('error', 'edge.target.no-input', `${path}${pointer('target')}`, `Block "${raw.target}" (${target.def.type}) starts a workflow and cannot take input from another block.`, 'Remove this connection, or use a different block.');
        return;
      }
      const key = `${raw.source}\0${port ?? DEFAULT_PORT}\0${raw.target}`;
      if (seen.has(key)) this.add('warning', 'edge.duplicate', path, `The connection ${raw.source} → ${raw.target} is listed twice.`);
      seen.add(key);
      edges.push({ index, source: raw.source as string, target: raw.target as string, port: port ?? (source.def ? nodePorts(source.def, { step: source.step })[0] ?? DEFAULT_PORT : DEFAULT_PORT) });
    });

    if (nodes.size === 0) {
      this.add('warning', 'graph.no-start', `${base}${pointer('nodes')}`, 'This workflow has no blocks.');
      return;
    }
    const incoming = new Set(edges.map((edge) => edge.target));
    const roots = ids.filter((id) => !incoming.has(id));
    if (roots.length === 0) {
      this.add('error', 'graph.no-start', `${base}${pointer('edges')}`, 'Nothing can start this workflow: every block has an incoming connection.', 'Remove the connection into the first block.');
      return;
    }
    const reachable = new Set(roots);
    const queue = [...roots];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const edge of edges) {
        if (edge.source === current && !reachable.has(edge.target)) {
          reachable.add(edge.target);
          queue.push(edge.target);
        }
      }
    }
    for (const [id, node] of nodes) {
      if (!reachable.has(id)) this.add('warning', 'graph.unreachable', node.path, `Block "${id}" can never run: no start block leads to it.`, 'Connect it after another block, or remove it.');
    }
    const back = findBackEdge(ids, edges);
    if (back) {
      this.add(
        'warning',
        'graph.cycle',
        `${base}${pointer('edges', back.index)}`,
        `The connection ${back.source} → ${back.target} closes a loop; a run stops after 1000 blocks.`,
        'For loops use Repeat, For Each or Paginate (their "each" output), not a connection back.',
      );
    }
    if (!isCallee) this.tabs(nodes, edges, roots);
  }

  /**
   * page.no-tab: a page block needs its tab (by name) on every path that reaches it. Forward
   * "must" analysis: the tabs certainly open after a block = the tabs open on every incoming path,
   * plus the one it opens. Skipped for workflows called by Run Workflow (the caller's tabs come along).
   */
  private tabs(nodes: Map<string, CheckedNode>, edges: CheckedEdge[], roots: string[]): void {
    // Tabs certainly open when a block starts / after it ran. Missing = not reached yet ("every tab").
    const before = new Map<string, Set<string>>(roots.map((id) => [id, new Set<string>()]));
    const after = new Map<string, Set<string>>();
    const opened = (id: string): string | null => {
      const node = nodes.get(id);
      if (!node?.def || node.step.disabled === true) return null;
      return TAB_PROVIDERS[node.def.type]?.(node.config) ?? null;
    };
    const same = (a: Set<string> | undefined, b: Set<string>): boolean => a !== undefined && a.size === b.size && [...b].every((tab) => a.has(tab));
    for (let round = 0, changed = true; changed && round <= nodes.size + 1; round += 1) {
      changed = false;
      for (const id of nodes.keys()) {
        let tabs: Set<string> | undefined = roots.includes(id) ? new Set() : undefined;
        for (const edge of edges) {
          if (edge.target !== id) continue;
          // The error output carries the input of a block that failed: what it opened does not count.
          const from = edge.port === ERROR_PORT ? before.get(edge.source) : after.get(edge.source);
          if (!from) continue;
          tabs = tabs === undefined ? new Set(from) : new Set([...tabs].filter((tab) => from.has(tab)));
        }
        if (!tabs) continue;
        if (!same(before.get(id), tabs)) {
          before.set(id, tabs);
          changed = true;
        }
        const tab = opened(id);
        const out = tab ? new Set([...tabs, tab]) : tabs;
        if (!same(after.get(id), out)) {
          after.set(id, out);
          changed = true;
        }
      }
    }
    for (const [id, node] of nodes) {
      if (!node.def || node.step.disabled === true) continue;
      const tab = neededTab(node.def, node.config);
      const tabs = before.get(id);
      if (!tab || !tabs || tabs.has(tab)) continue;
      const open = [...tabs];
      this.add(
        'warning',
        'page.no-tab',
        node.path,
        `Block "${id}" (${node.def.type}) acts on the tab "${tab}", but not every path to it opens that tab.`,
        open.length > 0 && !open.includes(tab)
          ? `Tabs open here: ${open.map((name) => `"${name}"`).join(', ')}. Set "tab" to one of them, or add an Open Tab block (tab "${tab}") earlier on every path.`
          : `Put an Open Tab block (type "open-url", tab "${tab}") before it on every path.`,
      );
    }
  }
}

/** A node that passed the shape checks. `def` is undefined for unknown types. */
interface CheckedNode {
  index: number;
  path: string;
  def: AnyBlockDefinition | undefined;
  config: Record<string, unknown>;
  step: Record<string, unknown>;
}

/** A connection between two existing blocks, from a known output. */
interface CheckedEdge {
  index: number;
  source: string;
  target: string;
  port: string;
}

/** An edge that closes a cycle (depth-first search), or undefined. */
function findBackEdge(ids: string[], edges: CheckedEdge[]): CheckedEdge | undefined {
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): CheckedEdge | undefined => {
    state.set(id, 'visiting');
    for (const edge of edges) {
      if (edge.source !== id) continue;
      const next = state.get(edge.target);
      if (next === 'visiting') return edge;
      if (next === undefined) {
        const found = visit(edge.target);
        if (found) return found;
      }
    }
    state.set(id, 'done');
    return undefined;
  };
  for (const id of ids) {
    if (state.has(id)) continue;
    const found = visit(id);
    if (found) return found;
  }
  return undefined;
}

/**
 * Every problem in a parsed workflow file (see the module comment). Run Workflow targets must be in
 * the file or in `options.workflowIds`.
 */
export function checkFile(raw: unknown, registry: BlockRegistry, options: CheckOptions = {}): Issue[] {
  const checker = new Checker(registry, {
    workflowIds: new Set(options.workflowIds ?? []),
    secrets: options.secrets ? new Set(options.secrets) : null,
  });
  checker.file(raw);
  return checker.issues;
}

/** JSON.parse with the failure as a `json.invalid` issue (the parser's message names the position). */
export function parseJson(text: string): { ok: true; data: unknown } | { ok: false; issues: Issue[] } {
  try {
    return { ok: true, data: JSON.parse(text) as unknown };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      issues: [{ level: 'error', code: 'json.invalid', path: '', message: `This file is not valid JSON: ${detail}`, hint: 'Check for a missing comma or quote, or a trailing comma, near that position.' }],
    };
  }
}
