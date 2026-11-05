import { routeTo } from '../ports';
import { DATA_ACCENT } from './dataCommon';
import type { BlockDefinition } from '../types';

/** Repeat settings: how many iterations. */
export interface RepeatConfig {
  times: number;
}

/**
 * Repeat: emits `{...input, iteration}` on "each" `times` times (each emit awaits the whole downstream
 * subtree), then routes the unchanged input to "done".
 */
export const repeatBlock: BlockDefinition<RepeatConfig> = {
  type: 'repeat',
  label: 'Repeat',
  description: 'Run the blocks on "each" a number of times, then continue from "done".',
  icon: '🔂',
  accent: DATA_ACCENT,
  ports: ['each', 'done'],
  defaultConfig: { times: 3 },
  timeoutSeconds: 3600,
  fields: [{ key: 'times', label: 'Times', kind: 'number', min: 1, max: 1000, step: 1 }],
  summary: (config) => `${config.times} times`,
  outputs: [{ key: 'iteration', description: 'On "each": 1, 2, 3…' }],

  async run(ctx, input) {
    for (let iteration = 1; iteration <= ctx.config.times; iteration += 1) {
      await ctx.emit({ ...input, iteration }, 'each');
    }
    return routeTo('done', input);
  },
};
