import { OPERATOR_OPTIONS, describeClause, testClause } from '../condition';
import { routeTo } from '../ports';
import type { BlockDefinition } from '../types';

export interface IfConfig {
  left: string;
  operator: string;
  right: string;
}

/** If — sends the data out of "true" or "false", depending on a condition. */
export const ifBlock: BlockDefinition<IfConfig> = {
  type: 'if',
  label: 'If',
  description: 'Go one way when a condition is true, another when it is false.',
  icon: '🔀',
  accent: '#64748b',
  ports: ['true', 'false'],
  defaultConfig: { left: '{{value}}', operator: 'equals', right: '' },
  fields: [
    { key: 'left', label: 'Value', kind: 'text', templated: true, placeholder: '{{value}}' },
    { key: 'operator', label: 'Condition', kind: 'select', options: OPERATOR_OPTIONS },
    {
      key: 'right',
      label: 'Compare to',
      kind: 'text',
      templated: true,
      help: 'Ignored by "is empty", "is true" and similar. For a pattern, write /text/i.',
    },
  ],
  summary: (config) => describeClause(config),
  outputs: [{ key: '(same data)', description: 'The input, unchanged, out of "true" or "false".' }],

  async run(ctx, input) {
    const passed = testClause(ctx.config);
    ctx.log('info', `Condition ${passed ? 'true' : 'false'}: ${describeClause(ctx.config)}`);
    return routeTo(passed ? 'true' : 'false', input);
  },
};
