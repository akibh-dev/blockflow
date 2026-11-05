import type { BlockDefinition, LogLevel } from '../types';

/** Log settings: the (templated) message and its log level. */
export interface LogConfig {
  message: string;
  level: LogLevel;
}

/** Log: writes one line to the run log at the chosen level and passes its input on unchanged. */
export const logBlock: BlockDefinition<LogConfig> = {
  type: 'log',
  label: 'Log',
  description: 'Write a line to the run log, e.g. a value you want to see.',
  icon: '📝',
  accent: '#475569',
  defaultConfig: { message: '{{value}}', level: 'info' },
  fields: [
    { key: 'message', label: 'Message', kind: 'text', templated: true, required: true },
    {
      key: 'level',
      label: 'Level',
      kind: 'select',
      options: [
        { value: 'info', label: 'info' },
        { value: 'warn', label: 'warning' },
        { value: 'error', label: 'error' },
        { value: 'debug', label: 'debug' },
      ],
    },
  ],
  summary: (config) => config.message,
  outputs: [{ key: '(same data)', description: 'The input, passed on.' }],

  async run(ctx, input) {
    ctx.log(ctx.config.level, ctx.config.message);
    return input;
  },
};
