import type { BlockDefinition } from '../types';

export interface StopConfig {
  outcome: 'pass' | 'fail';
  message: string;
}

/** Stop — ends this path here, as passed or failed (with a message for the report). */
export const stopBlock: BlockDefinition<StopConfig> = {
  type: 'stop',
  label: 'Stop',
  description: 'End this path here: as passed, or as failed with a message.',
  icon: '⏹',
  accent: '#475569',
  defaultConfig: { outcome: 'fail', message: '' },
  fields: [
    {
      key: 'outcome',
      label: 'End as',
      kind: 'select',
      options: [
        { value: 'fail', label: 'failed' },
        { value: 'pass', label: 'passed' },
      ],
    },
    { key: 'message', label: 'Message', kind: 'text', templated: true, placeholder: 'Price is {{value}}, above the limit' },
  ],
  summary: (config) => `${config.outcome === 'fail' ? 'Fail' : 'Pass'}${config.message ? `: ${config.message}` : ''}`,
  outputs: [],

  async run(ctx) {
    if (ctx.config.outcome === 'fail') throw new Error(ctx.config.message || 'Stopped as failed');
    ctx.log('info', ctx.config.message || 'Stopped as passed');
    return null;
  },
};
