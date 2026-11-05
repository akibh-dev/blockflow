import type { BlockDefinition } from '../types';

/** Set Variable settings: the key, and its (templated, so always string) value. */
export interface SetVariableConfig {
  name: string;
  value: string;
}

/** Set Variable — adds (or overwrites) one value in the data, so later blocks can use `{{name}}`. */
export const setVariableBlock: BlockDefinition<SetVariableConfig> = {
  type: 'set-variable',
  label: 'Set Variable',
  description: 'Add a value to the data flowing through.',
  icon: '🏷️',
  accent: '#8b5cf6',
  defaultConfig: { name: '', value: '' },
  fields: [
    { key: 'name', label: 'Name', kind: 'text', required: true, placeholder: 'price' },
    {
      key: 'value',
      label: 'Value',
      kind: 'text',
      templated: true,
      placeholder: '{{value}} USD',
    },
  ],
  summary: (config) => (config.name ? `${config.name} = ${config.value}` : 'No name yet'),
  outputs: [{ key: 'name', description: 'Whatever you named it.' }],

  async run(ctx, input) {
    const name = ctx.config.name.trim();
    if (!name) throw new Error('Name is required');
    return { ...input, [name]: ctx.config.value };
  },
};
