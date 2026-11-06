/**
 * JSON Schema of the script format (src/core/script.ts), generated from the block registry so it lists
 * every block, alias, shorthand and branch key. Written to docs/guide/script.schema.json by
 * scripts/guide.ts (npm run guide:sync; guide:check verifies it).
 */
import { ERROR_BRANCH, SCRIPT_ALIASES, SCRIPT_FORMAT, SCRIPT_SHORTHAND, SCRIPT_VERSION, continuePort } from '../src/core/script';
import { ERROR_PORT, hasDynamicPorts, nodePorts } from '../src/core/ports';
import type { BlockRegistry } from '../src/core/registry';
import type { AnyBlockDefinition, FieldSpec } from '../src/core/types';

/** Schema of one config field. */
function fieldSchema(field: FieldSpec): Record<string, unknown> {
  const base: Record<string, unknown> = { description: field.help ?? field.label };
  switch (field.kind) {
    case 'number':
      return { ...base, type: 'number', ...(field.min !== undefined ? { minimum: field.min } : {}), ...(field.max !== undefined ? { maximum: field.max } : {}) };
    case 'boolean':
      return { ...base, type: 'boolean' };
    case 'select':
      return { ...base, enum: field.options.map((option) => option.value) };
    case 'rows':
      return {
        ...base,
        type: 'array',
        items: {
          type: 'object',
          properties: Object.fromEntries(
            field.columns.map((column) => [column.key, column.options ? { enum: column.options.map((option) => option.value), description: column.label } : { type: 'string', description: column.label }]),
          ),
          additionalProperties: false,
        },
      };
    default:
      return { ...base, type: 'string' };
  }
}

/** Schema of a block's settings object (defaults are filled in, so nothing is required here). */
function configSchema(def: AnyBlockDefinition): Record<string, unknown> {
  return {
    type: 'object',
    description: `${def.label}: ${def.description}`,
    properties: Object.fromEntries(def.fields.map((field) => [field.key, fieldSchema(field)])),
    additionalProperties: false,
  };
}

/** One `oneOf` entry of a step: the block under `key` (its type or an alias) plus id, step and branches. */
function stepSchema(def: AnyBlockDefinition, key: string): Record<string, unknown> {
  const ports = nodePorts(def, {});
  const next = continuePort(ports);
  // Dynamic outputs: name only the ones the block always has (its settings' lists left empty).
  const fixed = hasDynamicPorts(def) ? nodePorts(def, { config: Object.fromEntries(def.fields.filter((field) => field.kind === 'rows').map((field) => [field.key, []])) }) : ports;
  const shorthand = SCRIPT_SHORTHAND[def.type];
  const shortField = shorthand ? def.fields.find((field) => field.key === shorthand) : undefined;
  const config = { $ref: `#/$defs/config/${def.type}` };
  const branches = fixed.filter((port) => port !== next && port !== ERROR_PORT);
  return {
    type: 'object',
    title: key === def.type ? def.label : `${def.label} (alias "${key}")`,
    required: [key],
    properties: {
      id: { type: 'string', description: 'Optional step id (kept as the node id; shown in run reports). Default s<N> for the Nth step.' },
      [key]: shortField ? { oneOf: [config, { ...fieldSchema(shortField), description: `Shorthand for { "${shorthand}": … }` }] } : config,
      step: { $ref: '#/$defs/stepSettings' },
      ...Object.fromEntries(
        branches.map((port) => [
          port,
          { $ref: '#/$defs/steps', description: next ? `Steps on "${port}"; they do not continue to the next step.` : `Steps on "${port}"; their end continues to the next step.` },
        ]),
      ),
      [ERROR_BRANCH]: { $ref: '#/$defs/steps', description: 'Steps on the error output (sets step.onError to "port").' },
    },
    // Outputs named by the settings (Switch: one per case): any other key is a branch list.
    additionalProperties: hasDynamicPorts(def)
      ? { $ref: '#/$defs/steps', description: `Steps on the output of that name (a case's "port"); their end continues to the next step.` }
      : false,
  };
}

/** The whole schema. */
export function scriptSchema(registry: BlockRegistry): Record<string, unknown> {
  const blocks = registry.list();
  const entries: Record<string, unknown>[] = [];
  for (const def of blocks) {
    entries.push(stepSchema(def, def.type));
    for (const [alias, type] of Object.entries(SCRIPT_ALIASES)) if (type === def.type) entries.push(stepSchema(def, alias));
  }
  const script = {
    type: 'object',
    required: ['steps'],
    properties: {
      format: { const: SCRIPT_FORMAT },
      version: { const: SCRIPT_VERSION },
      id: { type: 'string', description: 'In a file of several scripts: lets Run Workflow name this script.' },
      name: { type: 'string' },
      steps: { $ref: '#/$defs/steps' },
    },
    additionalProperties: false,
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/akib35/blockflow/docs/guide/script.schema.json',
    title: 'BlockFlow script file',
    description:
      'A workflow as a list of steps (the recommended format to write by hand or with an LLM). A step continues to the next one from "out" (loops: "done"); after an If, the next step follows the end of each branch. Generated by scripts/scriptSchema.ts.',
    oneOf: [
      { $ref: '#/$defs/script' },
      {
        type: 'object',
        required: ['format', 'scripts'],
        properties: { format: { const: SCRIPT_FORMAT }, version: { const: SCRIPT_VERSION }, scripts: { type: 'array', items: { $ref: '#/$defs/script' } } },
        additionalProperties: false,
      },
    ],
    $defs: {
      script,
      steps: { type: 'array', items: { $ref: '#/$defs/step' } },
      step: { oneOf: entries },
      stepSettings: {
        type: 'object',
        properties: {
          timeoutSeconds: { type: 'number', minimum: 1 },
          retries: { type: 'integer', minimum: 0, maximum: 5 },
          onError: { enum: ['stop', 'continue', 'port'] },
          disabled: { type: 'boolean' },
          note: { type: 'string' },
          screenshot: { enum: ['error', 'always', 'never'] },
          realInput: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      config: Object.fromEntries(blocks.map((def) => [def.type, configSchema(def)])),
    },
  };
}
