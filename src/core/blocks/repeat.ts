import { OPERATOR_OPTIONS, describeClause, testClause } from '../condition';
import { routeTo } from '../ports';
import { render } from '../template';
import { DATA_ACCENT, evalEnv } from './dataCommon';
import type { BlockDefinition, ConfigProblem, Payload } from '../types';

/** How Repeat decides when to stop. */
export type RepeatMode = 'times' | 'until' | 'while';

/**
 * Repeat settings. `mode` "times" (the default, and what workflows from before `mode` existed get)
 * runs `times` iterations. "until" and "while" test a condition (`left` `operator` `right`, like If),
 * rendered for each check against the data at the end of the last iteration, with `{{iteration}}`
 * = iterations run so far; `max` caps them, and `failAtMax` says whether reaching it fails the step.
 */
export interface RepeatConfig {
  mode: RepeatMode;
  times: number;
  left: string;
  operator: string;
  right: string;
  max: number;
  failAtMax: boolean;
}

/**
 * Repeat: emits `{...input, iteration}` on "each" (each emit awaits the whole downstream subtree),
 * then routes to "done": `{...input, iterations}` for times; for until / while the data the last
 * check saw (what the last round ended with, or the input when none ran) plus `iterations`.
 * - times: `times` iterations.
 * - until: run, then check; stop once the condition is true (at least one iteration).
 * - while: check, then run; stop once the condition is false (maybe zero iterations).
 */
export const repeatBlock: BlockDefinition<RepeatConfig> = {
  type: 'repeat',
  label: 'Repeat',
  description: 'Run the blocks on "each" a number of times, or until / while a condition holds, then continue from "done".',
  icon: '🔂',
  accent: DATA_ACCENT,
  ports: ['each', 'done'],
  defaultConfig: { mode: 'times', times: 3, left: '{{iteration}}', operator: 'equals', right: '', max: 100, failAtMax: true },
  timeoutSeconds: 3600,
  fields: [
    {
      key: 'mode',
      label: 'Repeat',
      kind: 'select',
      options: [
        { value: 'times', label: 'a number of times' },
        { value: 'until', label: 'until a condition is true (checked after each time)' },
        { value: 'while', label: 'while a condition is true (checked before each time)' },
      ],
    },
    { key: 'times', label: 'Times', kind: 'number', min: 1, max: 1000, step: 1, help: 'For "a number of times".' },
    {
      key: 'left',
      label: 'Value',
      kind: 'text',
      templated: true,
      perItem: true,
      placeholder: '{{count}}',
      help: 'Until / while: rendered at every check against the data the last time ended with ({{iteration}} = times run so far).',
    },
    { key: 'operator', label: 'Condition', kind: 'select', options: OPERATOR_OPTIONS },
    { key: 'right', label: 'Compare to', kind: 'text', templated: true, perItem: true, placeholder: '50' },
    { key: 'max', label: 'At most (times)', kind: 'number', min: 1, max: 10000, step: 1, help: 'Until / while: a safety limit.' },
    { key: 'failAtMax', label: 'Fail when the limit is reached', kind: 'boolean', help: 'Off: continue from "done" instead.' },
  ],
  summary: (config) => {
    const clause = describeClause({ left: config.left, operator: config.operator, right: config.right });
    if (config.mode === 'until') return `until ${clause} (max ${config.max})`;
    if (config.mode === 'while') return `while ${clause} (max ${config.max})`;
    return `${config.times} times`;
  },
  outputs: [
    { key: 'iteration', description: 'On "each": 1, 2, 3…' },
    { key: 'iterations', description: 'On "done": how many times it ran. Until / while: "done" also carries the data the last round ended with.' },
  ],

  validate(config) {
    const problems: ConfigProblem[] = [];
    if (!['times', 'until', 'while'].includes(config.mode)) problems.push({ key: 'mode', code: 'config.value', message: 'Repeat must be "times", "until" or "while"' });
    return problems;
  },

  async run(ctx, input) {
    const { mode, times } = ctx.config;
    if (mode !== 'until' && mode !== 'while') {
      for (let iteration = 1; iteration <= times; iteration += 1) {
        await ctx.emit({ ...input, iteration }, 'each');
      }
      return routeTo('done', { ...input, iterations: times });
    }

    const env = evalEnv(ctx);
    const max = Math.max(1, Math.floor(ctx.config.max));
    const holds = (scope: Payload): boolean => {
      const clause = { left: render(ctx.config.left, scope, env), operator: ctx.config.operator, right: render(ctx.config.right, scope, env) };
      return testClause(clause);
    };
    // The data the next check sees: what the last iteration ended with (its input if nothing ran).
    let latest: Payload = { ...input, iteration: 0 };
    let iteration = 0;
    for (;;) {
      if (mode === 'while' && !holds(latest)) break;
      if (iteration >= max) {
        const message = `the condition ${mode === 'until' ? 'was still false' : 'still held'} after ${max} time${max === 1 ? '' : 's'}`;
        if (ctx.config.failAtMax) throw new Error(`Repeat ${mode}: ${message}`);
        ctx.log('warn', `Stopped: ${message}`);
        break;
      }
      iteration += 1;
      const payload = { ...input, iteration };
      const reached = await ctx.emit(payload, 'each');
      if (ctx.aborted()) break;
      latest = { ...(reached ?? payload), iteration };
      if (mode === 'until' && holds(latest)) break;
    }
    ctx.log('info', `Ran ${iteration} time${iteration === 1 ? '' : 's'}`);
    // "done" carries what the last check saw (e.g. the status that finally was 200).
    return routeTo('done', { ...latest, iterations: iteration });
  },
};
