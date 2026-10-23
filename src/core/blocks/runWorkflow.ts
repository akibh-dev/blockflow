import type { BlockDefinition } from '../types';

export interface RunWorkflowConfig {
  workflow: string;
}

/**
 * Run Workflow — reuse a workflow like a function: "Log in" once, used by many tests. The called
 * workflow gets this block's input (including the run's tabs, so it can work in the same tab) and
 * its last block's data comes back out. If it fails, this step fails.
 */
export const runWorkflowBlock: BlockDefinition<RunWorkflowConfig> = {
  type: 'run-workflow',
  label: 'Run Workflow',
  description: 'Run another workflow with this data, and continue with what it returns.',
  icon: '🧩',
  accent: '#0891b2',
  defaultConfig: { workflow: '' },
  timeoutSeconds: 300,
  fields: [
    {
      key: 'workflow',
      label: 'Workflow',
      kind: 'workflow',
      required: true,
      help: 'Its start blocks receive this data. It does not need to be On.',
    },
  ],
  summary: () => 'calls another workflow',
  outputs: [{ key: '(its data)', description: 'Whatever the called workflow\'s last block produced.' }],

  async run(ctx, input) {
    const output = await ctx.callWorkflow(ctx.config.workflow, input);
    ctx.log('info', 'Called workflow finished');
    return output;
  },
};
