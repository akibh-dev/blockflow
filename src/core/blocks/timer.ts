import { uid } from '../id';
import type { BlockDefinition, Payload } from '../types';

export interface TimerConfig {
  seconds: number;
  repeat: boolean;
}

const DELAY_PREFIX = 'delay:';

/**
 * Timer — two jobs depending on where you put it:
 *
 * - Nothing connected to its input: it STARTS the flow. Emits every `seconds` (or once if
 *   "repeat" is off).
 * - Something connected to its input: it DELAYS the flow. When a payload arrives it waits
 *   `seconds`, then passes the same payload on.
 */
export const timerBlock: BlockDefinition<TimerConfig> = {
  type: 'timer',
  label: 'Timer',
  description: 'Start the flow on a schedule, or delay it when placed after another block.',
  icon: '⏱',
  accent: '#f59e0b',
  defaultConfig: { seconds: 60, repeat: true },
  fields: [
    {
      key: 'seconds',
      label: 'Seconds',
      kind: 'number',
      min: 1,
      step: 1,
      help: 'Under 30 seconds the extension keeps its background worker awake to fire on time (Chromium). 30 seconds or more uses browser alarms.',
    },
    {
      key: 'repeat',
      label: 'Repeat',
      kind: 'boolean',
      help: 'Only used when this block starts the flow. After another block it always fires once.',
    },
  ],
  summary: (config) => (config.repeat ? `Every ${config.seconds}s` : `Once after ${config.seconds}s`),
  outputs: [
    { key: 'tick', description: 'How many times the timer has fired (when it starts the flow).' },
    { key: 'firedAt', description: 'ISO time the timer fired.' },
  ],

  async start(ctx) {
    const ms = ctx.config.seconds * 1000;
    await ctx.state.set('count', 0);
    await ctx.timers.set('tick', {
      delayMs: ms,
      ...(ctx.config.repeat ? { periodMs: ms } : {}),
    });
    ctx.log(
      'info',
      ctx.config.repeat
        ? `Timer started: every ${ctx.config.seconds}s`
        : `Timer started: once after ${ctx.config.seconds}s`,
    );
  },

  // Run button: fire once now instead of starting the schedule.
  async trigger(ctx) {
    return { tick: 0, firedAt: ctx.host.now().toISOString() };
  },

  async run(ctx, input) {
    const name = `${DELAY_PREFIX}${uid()}`;
    await ctx.timers.set(name, { delayMs: ctx.config.seconds * 1000 }, input);
    ctx.log('debug', `Waiting ${ctx.config.seconds}s before continuing`);
    // The flow continues from onTimer, not from here.
    return null;
  },

  async onTimer(ctx, name, data) {
    const firedAt = ctx.host.now().toISOString();
    if (name.startsWith(DELAY_PREFIX)) {
      const payload: Payload = { ...(data ?? {}), firedAt };
      await ctx.emit(payload);
      return;
    }
    const count = ((await ctx.state.get<number>('count')) ?? 0) + 1;
    await ctx.state.set('count', count);
    ctx.log('debug', `Timer tick #${count}`);
    await ctx.emit({ tick: count, firedAt });
  },
};
