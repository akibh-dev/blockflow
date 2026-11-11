import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ store: {} as Record<string, unknown>, gets: 0 }));
vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: vi.fn(async (key: string) => {
          fake.gets += 1;
          return key in fake.store ? { [key]: fake.store[key] } : {};
        }),
        set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(fake.store, items)),
        remove: vi.fn(async () => {}),
      },
    },
  },
}));

import { getLimits, resetLimitsCache } from '../../src/browser/limits';
import { appendLog, updateRuns } from '../../src/browser/stores';
import type { RunRecord } from '../../src/core/runs';

const run = (n: number) => ({ id: `r${n}`, workflowId: 'w', workflowName: 'w', trigger: 'manual', status: 'passed', startedAt: '2026-01-01T00:00:00Z', steps: [] }) as RunRecord;

beforeEach(() => {
  fake.store = {};
  fake.gets = 0;
  resetLimitsCache();
});

describe('getLimits', () => {
  it('defaults without settings, reads Settings → Limits, and caches for a moment', async () => {
    expect(await getLimits(0)).toEqual({ runHistory: 40, logEntries: 300, screenshots: 150, maxStepsPerRun: 1000 });
    fake.store['bf:settings'] = { outsideControl: false, runHistory: 100, screenshots: 5 };
    expect((await getLimits(500)).runHistory).toBe(40); // still cached
    expect(fake.gets).toBe(1);
    resetLimitsCache();
    expect(await getLimits(500)).toEqual({ runHistory: 100, logEntries: 300, screenshots: 20, maxStepsPerRun: 1000 }); // 5 clamps to 20
  });

  it('falls back to the defaults when storage fails', async () => {
    const { browser } = await import('wxt/browser');
    vi.mocked(browser.storage.local.get).mockRejectedValueOnce(new Error('boom'));
    expect((await getLimits(0)).runHistory).toBe(40);
  });
});

describe('the stores use the limits', () => {
  it('keeps the newest `runHistory` runs', async () => {
    fake.store['bf:settings'] = { outsideControl: false, runHistory: 10 };
    await updateRuns(() => Array.from({ length: 25 }, (_, i) => run(i)));
    const kept = fake.store['bf:runs'] as RunRecord[];
    expect(kept).toHaveLength(10);
    expect(kept.at(-1)!.id).toBe('r24');
    expect(kept[0]!.id).toBe('r15');
  });

  it('keeps the newest `logEntries` log lines', async () => {
    fake.store['bf:settings'] = { outsideControl: false, logEntries: 100 };
    fake.store['bf:logs'] = Array.from({ length: 100 }, (_, i) => ({ ts: 't', level: 'info', message: `old ${i}` }));
    await appendLog({ ts: 't', level: 'info', message: 'new' } as never);
    const logs = fake.store['bf:logs'] as { message: string }[];
    expect(logs).toHaveLength(100);
    expect(logs.at(-1)!.message).toBe('new');
    expect(logs[0]!.message).toBe('old 1');
  });

  it('default limits when no setting is stored', async () => {
    await updateRuns(() => Array.from({ length: 60 }, (_, i) => run(i)));
    expect(fake.store['bf:runs']).toHaveLength(40);
  });
});
