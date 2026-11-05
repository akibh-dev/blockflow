import type { BlockDefinition, Row } from '../types';

/** Start settings: `inputs` rows are `{name, value}` (value templated). */
export interface ManualStartConfig {
  inputs: Row[];
}

/**
 * Start — a plain starting point with named values: for tests run with the Run button, and as the
 * "parameters" of a workflow called by Run Workflow (values passed in by the caller win).
 */
export const manualStartBlock: BlockDefinition<ManualStartConfig> = {
  type: 'start',
  label: 'Start',
  description: 'Start here when you press Run, with some starting values (also defaults for Run Workflow).',
  icon: '▶️',
  accent: '#f59e0b',
  defaultConfig: { inputs: [] },
  fields: [
    {
      key: 'inputs',
      label: 'Starting values',
      kind: 'rows',
      columns: [
        { key: 'name', label: 'Name', placeholder: 'email' },
        { key: 'value', label: 'Value', placeholder: 'me@example.com', templated: true },
      ],
    },
  ],
  summary: (config) => (config.inputs ?? []).map((row) => row.name).filter(Boolean).join(', ') || 'Run button',
  outputs: [{ key: '(your names)', description: 'One key per starting value.' }],

  async run(ctx, input) {
    const values = Object.fromEntries((ctx.config.inputs ?? []).filter((row) => (row.name ?? '').trim()).map((row) => [(row.name ?? '').trim(), row.value ?? '']));
    // Values given by a calling workflow win over these defaults.
    return { ...values, ...input };
  },
};
