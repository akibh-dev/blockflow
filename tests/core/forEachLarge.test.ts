import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_STEPS } from '../../src/core/engine';
import { MAX_STEPS_KEPT } from '../../src/core/runs';
import { FakeHost, flow, harness } from '../helpers/fakeHost';

// M6.5: a long For Each must not grow a run record without bound, and the loop guard is the documented limit.
const bigList = (n: number) => `n\n${Array.from({ length: n }, (_, i) => i + 1).join('\n')}`;
const workflow = (n: number) =>
  flow(
    [
      { id: 'd', type: 'data-table', config: { text: bigList(n) } },
      { id: 'each', type: 'for-each', config: { list: 'rows', as: 'row' } },
      { id: 'log', type: 'log', config: { message: 'row {{row.n}}' } },
      { id: 'end', type: 'log', config: { message: 'done {{count}}' } },
    ],
    [['d', 'each'], ['each', 'log', 'each'], ['each', 'end', 'done']],
  );

describe('For Each over a big list', () => {
  // Each step publishes a copy of the (bounded) run record, so thousands of steps take seconds: give it room.
  it('with a raised block limit it passes and the stored record stays bounded', { timeout: 60_000 }, async () => {
    const h = harness(workflow(2000), new FakeHost(), 5000);
    const record = await h.runner.runOnce();
    expect(record.status).toBe('passed');
    expect(record.steps.length).toBeLessThanOrEqual(MAX_STEPS_KEPT);
    expect(record.droppedSteps).toBeGreaterThan(0);
    // Every step was counted: data table + for each + 2000 logs + the "done" log.
    expect(record.steps.length + (record.droppedSteps ?? 0)).toBe(2003);
    expect(h.messages('info').filter((m) => m === 'done 2000')).toHaveLength(1);
  });

  it('with the default limit (1000 blocks) the run stops with the loop-guard message', async () => {
    expect(DEFAULT_MAX_STEPS).toBe(1000);
    const h = harness(workflow(5000));
    const record = await h.runner.runOnce();
    expect(record.status).toBe('failed');
    expect(record.error).toMatch(/more than 1000 blocks/);
  });

  it('a list that fits the default limit just works', async () => {
    const h = harness(workflow(500));
    const record = await h.runner.runOnce();
    expect(record.status).toBe('passed');
    expect(record.steps.length).toBeLessThanOrEqual(MAX_STEPS_KEPT);
  });
});
