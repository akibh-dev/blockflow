import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, LIMIT_RANGES, resolveLimits } from '../../src/core/limits';

describe('resolveLimits', () => {
  it('defaults when nothing is stored', () => {
    expect(resolveLimits()).toEqual(DEFAULT_LIMITS);
    expect(resolveLimits(null)).toEqual(DEFAULT_LIMITS);
    expect(resolveLimits({})).toEqual(DEFAULT_LIMITS);
    expect(DEFAULT_LIMITS).toEqual({ runHistory: 40, logEntries: 300, screenshots: 150, maxStepsPerRun: 1000 });
  });

  it('uses stored values inside the range, rounding fractions', () => {
    expect(resolveLimits({ runHistory: 100, logEntries: 1000.4, screenshots: 20, maxStepsPerRun: 5000 })).toEqual({ runHistory: 100, logEntries: 1000, screenshots: 20, maxStepsPerRun: 5000 });
  });

  it('clamps values outside the range', () => {
    expect(resolveLimits({ runHistory: 1, logEntries: 99_999, screenshots: -5, maxStepsPerRun: 1e9 })).toEqual({
      runHistory: LIMIT_RANGES.runHistory.min,
      logEntries: LIMIT_RANGES.logEntries.max,
      screenshots: LIMIT_RANGES.screenshots.min,
      maxStepsPerRun: LIMIT_RANGES.maxStepsPerRun.max,
    });
  });

  it('ignores anything that is not a finite number', () => {
    expect(resolveLimits({ runHistory: '100', logEntries: NaN, screenshots: Infinity, maxStepsPerRun: null })).toEqual(DEFAULT_LIMITS);
  });

  it('ignores unrelated settings keys', () => {
    expect(resolveLimits({ outsideControl: true, runHistory: 60 } as never)).toEqual({ ...DEFAULT_LIMITS, runHistory: 60 });
  });
});
