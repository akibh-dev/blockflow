/**
 * When a Schedule block fires next, in the browser's local time. Pure, so it is easy to test.
 *   { every: 'day', at: '09:30', days: [1,2,3,4,5] }   weekdays at 09:30 (0 = Sunday)
 *   { every: 'hour', minute: 15 }                        at :15 every hour
 *   { every: 'minutes', minutes: 10 }                    every 10 minutes, on the clock (00, 10, 20…)
 */
export type ScheduleSpec =
  | { every: 'day'; at: string; days: number[] }
  | { every: 'hour'; minute: number }
  | { every: 'minutes'; minutes: number };

export function parseTime(text: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : null;
}

export function nextOccurrence(now: Date, spec: ScheduleSpec): Date {
  const next = new Date(now.getTime());
  next.setSeconds(0, 0);
  if (spec.every === 'minutes') {
    const step = Math.max(1, Math.floor(spec.minutes));
    const minutesToday = next.getHours() * 60 + next.getMinutes();
    const target = (Math.floor(minutesToday / step) + 1) * step;
    next.setHours(0, target, 0, 0);
    return next;
  }
  if (spec.every === 'hour') {
    next.setMinutes(spec.minute);
    if (next <= now) next.setHours(next.getHours() + 1);
    return next;
  }
  const time = parseTime(spec.at);
  if (!time) throw new Error(`"${spec.at}" is not a time like 09:30`);
  const days = spec.days.length > 0 ? spec.days : [0, 1, 2, 3, 4, 5, 6];
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(now.getTime());
    candidate.setDate(now.getDate() + offset);
    candidate.setHours(time.hour, time.minute, 0, 0);
    if (candidate > now && days.includes(candidate.getDay())) return candidate;
  }
  throw new Error('No day selected');
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "mon,wed,fri", "weekdays", "weekends", "every day" or "" → day numbers. */
export function parseDays(text: string): number[] {
  const value = text.trim().toLowerCase();
  if (!value || value === 'every day' || value === 'daily') return [0, 1, 2, 3, 4, 5, 6];
  if (value === 'weekdays') return [1, 2, 3, 4, 5];
  if (value === 'weekends') return [0, 6];
  return value
    .split(/[\s,]+/)
    .map((name) => DAY_NAMES.indexOf(name.slice(0, 3)))
    .filter((day) => day >= 0);
}
