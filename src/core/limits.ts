/** Limits the user can change in Settings → Limits. Pure: no browser APIs (the settings are read elsewhere). */

export interface Limits {
  /** Finished runs kept in the run history (`bf:runs`). */
  runHistory: number;
  /** Lines kept in the run log (`bf:logs`). */
  logEntries: number;
  /** Failure/step screenshots kept (trace pictures have their own bounds, see blobStore.ts). */
  screenshots: number;
  /** Blocks one run may go through before it is stopped as a probable loop. */
  maxStepsPerRun: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({ runHistory: 40, logEntries: 300, screenshots: 150, maxStepsPerRun: 1000 });

/** Allowed range of each limit (inclusive); values outside are clamped. */
export const LIMIT_RANGES: Readonly<Record<keyof Limits, { min: number; max: number }>> = Object.freeze({
  runHistory: { min: 10, max: 500 },
  logEntries: { min: 100, max: 5000 },
  screenshots: { min: 20, max: 1000 },
  maxStepsPerRun: { min: 100, max: 100_000 },
});

/** Settings fields that hold limits (`bf:settings` also holds other settings). */
export type LimitSettings = Partial<Record<keyof Limits, unknown>>;

/** The limits to use: stored values clamped into range, anything missing or not a finite number defaults. */
export function resolveLimits(settings?: LimitSettings | null): Limits {
  const out = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(LIMIT_RANGES) as (keyof Limits)[]) {
    const value = settings?.[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const { min, max } = LIMIT_RANGES[key];
    out[key] = Math.min(max, Math.max(min, Math.round(value)));
  }
  return out;
}
