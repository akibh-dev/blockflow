import { describe, expect, it } from 'vitest';
import type { RunRecord, StepRecord } from '../../src/core/runs';
import { runFromInput } from '../../src/entrypoints/editor/runFrom';

const step = (nodeId: string, input: StepRecord['input']): StepRecord => ({ nodeId, blockType: 'log', status: 'passed', startedAt: '', attempts: 1, ...(input ? { input } : {}) });
const run = (id: string, steps: StepRecord[], over: Partial<RunRecord> = {}): RunRecord => ({
  id,
  workflowId: 'wf',
  workflowName: 'W',
  trigger: 'manual',
  status: 'passed',
  startedAt: `2026-11-10T10:00:0${id.length}.000Z`,
  steps,
  ...over,
});

describe('Run from here input (M5.5)', () => {
  it('uses the newest finished run that reached the block, its last visit', () => {
    const runs = [
      run('r1', [step('a', {}), step('b', { n: 1 })]),
      run('r2', [step('a', {}), step('b', { n: 2 }), step('b', { n: 3 })]),
      run('r3', [step('a', {})]), // did not reach b
      run('other', [step('b', { n: 9 })], { workflowId: 'else' }),
      run('live', [step('b', { n: 4 })], { status: 'running' }),
    ];
    expect(runFromInput(runs, 'wf', 'b')).toEqual({ ok: true, input: { n: 3 }, runId: 'r2', startedAt: runs[1]!.startedAt });
  });

  it('a failed run counts too', () => {
    expect(runFromInput([run('r', [step('b', { x: 1 })], { status: 'failed' })], 'wf', 'b')).toMatchObject({ ok: true, input: { x: 1 } });
  });

  it('no run reached it: disabled with a hint', () => {
    const found = runFromInput([run('r', [step('a', {})])], 'wf', 'b');
    expect(found.ok).toBe(false);
    expect(!found.ok && found.hint).toMatch(/Run the workflow once first/);
  });

  it('never replays a shortened ($preview) or masked input', () => {
    const big = runFromInput([run('r', [step('b', { $preview: '{"html":"…', $size: 99_999 })])], 'wf', 'b');
    expect(big.ok).toBe(false);
    expect(!big.ok && big.hint).toMatch(/too big/);
    const masked = runFromInput([run('r', [step('b', { token: '•••' })])], 'wf', 'b');
    expect(masked.ok).toBe(false);
    expect(!masked.ok && masked.hint).toMatch(/secret/);
  });
});
