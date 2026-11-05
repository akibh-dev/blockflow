import { uid } from '../id';
import type { BlockDefinition, Payload } from '../types';

/** Timer settings: the interval or delay in seconds, and whether a root Timer repeats. */
export interface TimerConfig {
  seconds: number;
  repeat: boolean;
}

/**
 * Timer-name prefix for delays (one timer per incoming payload, `delay:<uid>`), so `onTimer` can
 * tell them from the root schedule's single `tick` timer.
 */
const DELAY_PREFIX = 'delay:';

/**
 * Delays up to this long wait inside the run (the run stays one run, and Stop works mid-wait); the
 * background worker is kept awake for live runs. Longer delays use a durable timer that survives a
 * browser restart, and the flow continues as a new run (trigger "timer").
 */
export const MAX_INLINE_DELAY_SECONDS = 600;

/** Slice for in-run waits, so Stop and timeouts take effect within a second. */
const WAIT_SLICE_MS = 1000;

/**
 * Timer — two jobs depending on where you put it:
 *
 * - Nothing connected to its input: it STARTS the flow. Emits every `seconds` (or once if
 *   "repeat" is off).
 * - Something connected to its input: it DELAYS the flow. When a payload arrives it waits
 *   `seconds`, then passes the same payload on (plus `firedAt`). Up to MAX_INLINE_DELAY_SECONDS
 *   the wait happens inside the run; longer waits continue as a new run.
 */
export const timerBlock: BlockDefinition<TimerConfig> = {
  type: 'timer',
  label: 'Timer',
  description: 'Start the flow on a schedule, or delay it when placed after another block.',
  icon: '⏱',
  accent: '#f59e0b',
  defaultConfig: { seconds: 60, repeat: true },
  // As a delay it waits inside the step, so the step needs room for the longest in-run delay.
  timeoutSeconds: MAX_INLINE_DELAY_SECONDS + 60,
  fields: [
    {
      key: 'seconds',
      label: 'Seconds',
      kind: 'number',
      min: 1,
      step: 1,
      help: 'Under 30 seconds the extension keeps its background worker awake to fire on time (Chromium). 30 seconds or more uses browser alarms. After another block: waits up to 600 s inside the run; longer delays continue as a new run.',
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
    if (ctx.config.seconds <= MAX_INLINE_DELAY_SECONDS) {
      ctx.log('debug', `Waiting ${ctx.config.seconds}s`);
      for (let left = ctx.config.seconds * 1000; left > 0; left -= WAIT_SLICE_MS) {
        if (ctx.aborted()) return null;
        await ctx.host.sleep(Math.min(WAIT_SLICE_MS, left));
      }
      if (ctx.aborted()) return null;
      return { ...input, firedAt: ctx.host.now().toISOString() };
    }
    const name = `${DELAY_PREFIX}${uid()}`;
    await ctx.timers.set(name, { delayMs: ctx.config.seconds * 1000 }, input);
    ctx.log('info', `Waiting ${ctx.config.seconds}s; the flow continues as a new run`);
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
