import { nextOccurrence, parseDays, parseTime } from '../schedule';
import type { ScheduleSpec } from '../schedule';
import type { BlockContext, BlockDefinition } from '../types';

/** Schedule settings. Which fields matter depends on `every` (day: at + days, hour: minute, minutes: minutes). */
export interface ScheduleConfig {
  every: 'day' | 'hour' | 'minutes';
  at: string;
  days: string;
  minute: number;
  minutes: number;
}

/** Maps the flat editor config onto schedule.ts's ScheduleSpec. */
function spec(config: ScheduleConfig): ScheduleSpec {
  if (config.every === 'hour') return { every: 'hour', minute: config.minute };
  if (config.every === 'minutes') return { every: 'minutes', minutes: config.minutes };
  return { every: 'day', at: config.at, days: parseDays(config.days) };
}

/** Sets the one-shot `next` timer for the next occurrence (at least 1s away), carrying `scheduledFor`. */
async function planNext(ctx: BlockContext<ScheduleConfig>): Promise<Date> {
  const now = ctx.host.now();
  const next = nextOccurrence(now, spec(ctx.config));
  await ctx.timers.set('next', { delayMs: Math.max(1_000, next.getTime() - now.getTime()) }, { scheduledFor: next.toISOString() });
  return next;
}

/** Schedule — starts the flow at set times: every day at 09:00, weekdays, every hour at :15, every 10 minutes. */
export const scheduleBlock: BlockDefinition<ScheduleConfig> = {
  type: 'schedule',
  label: 'Schedule',
  description: 'Start the flow at set times: daily at 09:00, on weekdays, every hour, every N minutes.',
  icon: '📅',
  accent: '#f59e0b',
  defaultConfig: { every: 'day', at: '09:00', days: 'weekdays', minute: 0, minutes: 15 },
  fields: [
    {
      key: 'every',
      label: 'Every',
      kind: 'select',
      options: [
        { value: 'day', label: 'day at a time' },
        { value: 'hour', label: 'hour at a minute' },
        { value: 'minutes', label: 'N minutes' },
      ],
    },
    { key: 'at', label: 'At (HH:MM)', kind: 'text', placeholder: '09:00', help: 'For "day". Local time of this computer.' },
    { key: 'days', label: 'Days', kind: 'text', placeholder: 'weekdays', help: 'For "day": every day, weekdays, weekends, or names: mon, wed, fri.' },
    { key: 'minute', label: 'Minute', kind: 'number', min: 0, max: 59, step: 1, help: 'For "hour": minutes past the hour.' },
    { key: 'minutes', label: 'Minutes', kind: 'number', min: 1, max: 1440, step: 1, help: 'For "N minutes". Runs on the clock (:00, :15, :30…).' },
  ],
  summary: (config) =>
    config.every === 'day' ? `${config.days || 'every day'} at ${config.at}` : config.every === 'hour' ? `hourly at :${String(config.minute).padStart(2, '0')}` : `every ${config.minutes} min`,
  outputs: [
    { key: 'firedAt', description: 'When it fired.' },
    { key: 'scheduledFor', description: 'The time it was planned for.' },
  ],

  async start(ctx) {
    if (ctx.config.every === 'day' && !parseTime(ctx.config.at)) throw new Error(`"${ctx.config.at}" is not a time like 09:30`);
    const next = await planNext(ctx);
    ctx.log('info', `Next run: ${next.toLocaleString()}`);
  },

  async trigger(ctx) {
    return { firedAt: ctx.host.now().toISOString(), scheduledFor: null };
  },

  async onTimer(ctx, name, data) {
    if (name !== 'next') return;
    // Plan the next one first, so a failing run does not stop the schedule.
    await planNext(ctx);
    await ctx.emit({ firedAt: ctx.host.now().toISOString(), scheduledFor: data?.scheduledFor ?? null });
  },
};
