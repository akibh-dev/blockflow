/**
 * Generates the block reference for docs/guide from the block registry, so the docs can never
 * describe settings that do not exist. Run: npm run guide:sync   (guide:check verifies, used by npm run check)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createDefaultRegistry } from '../src/core/blocks';
import { DEFAULT_TIMEOUT_SECONDS } from '../src/core/engine';
import { nodePorts } from '../src/core/ports';
import type { AnyBlockDefinition, FieldSpec } from '../src/core/types';

const out = path.resolve(import.meta.dirname ?? __dirname, '../docs/guide');
const registry = createDefaultRegistry();
const blocks = registry.list();

function fieldJson(field: FieldSpec) {
  return {
    key: field.key,
    label: field.label,
    kind: field.kind,
    ...(field.required ? { required: true } : {}),
    ...('templated' in field && field.templated ? { templated: true } : {}),
    ...(field.kind === 'select' ? { options: field.options.map((option) => option.value) } : {}),
    ...(field.kind === 'number' ? { min: field.min, max: field.max } : {}),
    ...(field.kind === 'rows' ? { columns: field.columns.map((column) => ({ key: column.key, label: column.label, ...(column.templated ? { templated: true } : {}) })) } : {}),
    ...(field.help ? { help: field.help } : {}),
  };
}

function blockJson(def: AnyBlockDefinition) {
  return {
    type: def.type,
    label: def.label,
    description: def.description,
    canStart: Boolean(def.start || def.trigger || def.run),
    canTakeInput: Boolean(def.run),
    ports: nodePorts(def, {}),
    timeoutSeconds: def.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    defaultConfig: def.defaultConfig,
    fields: def.fields.map(fieldJson),
    outputs: def.outputs,
  };
}

function kindText(field: FieldSpec): string {
  switch (field.kind) {
    case 'select':
      return `one of ${field.options.map((option) => `\`${option.value}\``).join(', ')}`;
    case 'rows':
      return `list of rows {${field.columns.map((column) => column.key).join(', ')}}`;
    case 'locator':
      return 'locator';
    case 'workflow':
      return 'workflow id';
    default:
      return field.kind;
  }
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function blockMarkdown(def: AnyBlockDefinition): string {
  const ports = nodePorts(def, {});
  const lines = [
    `## ${def.icon} ${def.label} — \`${def.type}\``,
    '',
    def.description,
    '',
    `- Outputs (ports): ${ports.map((port) => `\`${port}\``).join(', ')}${ports.includes('error') ? '' : ' (plus `error` when step.onError is "port")'}`,
    `- Default timeout: ${def.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS}s`,
    `- Can start a workflow: ${def.start || def.trigger ? 'yes (has its own schedule/trigger)' : def.run ? 'yes (runs once with empty data)' : 'no'}`,
    '',
    '| Setting (`config` key) | Type | Default | Notes |',
    '| --- | --- | --- | --- |',
    ...def.fields.map((field) => {
      const flags = [field.required ? 'required' : '', 'templated' in field && field.templated ? 'supports `{{…}}`' : ''].filter(Boolean).join(', ');
      const value = (def.defaultConfig as Record<string, unknown>)[field.key];
      return `| \`${field.key}\` (${cell(field.label)}) | ${cell(kindText(field))} | \`${cell(JSON.stringify(value ?? null))}\` | ${cell([flags, field.help ?? ''].filter(Boolean).join('. '))} |`;
    }),
    '',
    'Adds to the data: ' + (def.outputs.length ? def.outputs.map((output) => `\`${output.key}\` (${output.description})`).join('; ') : 'nothing'),
    '',
  ];
  return lines.join('\n');
}

/** JSON Schema for a workflow export file, with every block's config spelled out. */
function schema() {
  const nodeSchemas = blocks.map((def) => ({
    type: 'object',
    required: ['id', 'type', 'position', 'config'],
    properties: {
      id: { type: 'string' },
      type: { const: def.type },
      position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
      config: {
        type: 'object',
        description: def.description,
        properties: Object.fromEntries(
          def.fields.map((field) => {
            const base: Record<string, unknown> = { description: field.help ?? field.label };
            if (field.kind === 'number') Object.assign(base, { type: 'number', minimum: field.min, maximum: field.max });
            else if (field.kind === 'boolean') base.type = 'boolean';
            else if (field.kind === 'select') base.enum = field.options.map((option) => option.value);
            else if (field.kind === 'rows') {
              Object.assign(base, {
                type: 'array',
                items: { type: 'object', properties: Object.fromEntries(field.columns.map((column) => [column.key, { type: 'string', description: column.label }])) },
              });
            } else base.type = 'string';
            return [field.key, base];
          }),
        ),
        required: def.fields.filter((field) => field.required).map((field) => field.key),
      },
      step: { $ref: '#/$defs/step' },
    },
  }));
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/akib35/blockflow/docs/guide/workflow.schema.json',
    title: 'BlockFlow workflow export file',
    description: 'What Import accepts: {format, version, workflows[]} or a single workflow object. Generated by scripts/guide.ts.',
    oneOf: [
      {
        type: 'object',
        required: ['workflows'],
        properties: {
          format: { const: 'blockflow-workflows' },
          version: { const: 1 },
          workflows: { type: 'array', items: { $ref: '#/$defs/workflow' } },
        },
      },
      { $ref: '#/$defs/workflow' },
    ],
    $defs: {
      workflow: {
        type: 'object',
        required: ['name', 'nodes', 'edges'],
        properties: {
          schemaVersion: { const: 1 },
          id: { type: 'string', description: 'Replaced on import.' },
          name: { type: 'string' },
          enabled: { type: 'boolean', description: 'Ignored on import: imported workflows are always off.' },
          nodes: { type: 'array', items: { oneOf: nodeSchemas } },
          edges: {
            type: 'array',
            items: {
              type: 'object',
              required: ['source', 'target'],
              properties: {
                id: { type: 'string' },
                source: { type: 'string', description: 'Node id the data comes from.' },
                target: { type: 'string', description: 'Node id the data goes to.' },
                sourcePort: { type: 'string', description: 'Output of the source: out (default), true/false (If), error, each/done (loops)…' },
              },
            },
          },
        },
      },
      step: {
        type: 'object',
        properties: {
          timeoutSeconds: { type: 'number', minimum: 1 },
          retries: { type: 'integer', minimum: 0, maximum: 5 },
          onError: { enum: ['stop', 'continue', 'port'] },
          disabled: { type: 'boolean' },
          note: { type: 'string' },
          screenshot: { enum: ['error', 'always', 'never'] },
        },
      },
    },
  };
}

const files: Record<string, string> = {
  'blocks.md': [
    '# Block reference',
    '',
    '<!-- Generated by scripts/guide.ts from src/core/blocks. Do not edit by hand: run `npm run guide:sync`. -->',
    '',
    `${blocks.length} blocks. Every block also accepts the common \`step\` settings (see README.md in this folder).`,
    '',
    ...blocks.map((def) => `- [${def.label}](#${def.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}--${def.type.replace(/[^a-z0-9]+/g, '-')}) \`${def.type}\``),
    '',
    ...blocks.map(blockMarkdown),
  ].join('\n'),
  'blocks.json': `${JSON.stringify({ generatedBy: 'scripts/guide.ts', blocks: blocks.map(blockJson) }, null, 2)}\n`,
  'workflow.schema.json': `${JSON.stringify(schema(), null, 2)}\n`,
};

const check = process.argv.includes('--check');
let stale = 0;
for (const [name, content] of Object.entries(files)) {
  const file = path.join(out, name);
  let current = '';
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    // missing
  }
  if (current === content) continue;
  if (check) {
    stale += 1;
    console.error(`docs/guide/${name} is out of date. Run: npm run guide:sync`);
  } else {
    writeFileSync(file, content);
    console.log(`wrote docs/guide/${name}`);
  }
}
if (check && stale > 0) process.exit(1);
if (check) console.log(`docs/guide reference matches the ${blocks.length} blocks`);
