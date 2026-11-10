import { describe, expect, it } from 'vitest';
import { FakeHost, flow, harness } from '../helpers/fakeHost';
import type { DebugPause, TraceStepInfo } from '../../src/core/types';

// M5 engine hooks: debug pauses (breakpoints, Step, pause on error), trace hooks, Run from here.
const three = () =>
  flow(
    [
      { id: 'a', type: 'log', config: { message: 'a {{n}}' } },
      { id: 'b', type: 'log', config: { message: 'b' }, step: { pause: true } },
      { id: 'c', type: 'log', config: { message: 'c' } },
    ],
    [['a', 'b'], ['b', 'c']],
  );

function withDebug(answers: ('continue' | 'step' | 'stop')[]) {
  const host = new FakeHost();
  const pauses: DebugPause[] = [];
  host.debug = { pause: async (info) => { pauses.push(info); return answers.shift() ?? 'continue'; } };
  return { host, pauses };
}

describe('debug runs (M5.2)', () => {
  it('pauses only at breakpoints, and only in a debug run', async () => {
    const { host, pauses } = withDebug([]);
    const h = harness(three(), host);
    expect((await h.runner.runOnce()).status).toBe('passed');
    expect(pauses).toHaveLength(0);
    const record = await h.runner.runOnce({ debug: {} });
    expect(record.status).toBe('passed');
    expect(record.mode).toEqual({ debug: true });
    expect(pauses.map((p) => [p.nodeId, p.reason])).toEqual([['b', 'breakpoint']]);
    expect(pauses[0]!.runId).toBe(record.id);
  });

  it('Step pauses before the next step too; Continue stops stepping', async () => {
    const { host, pauses } = withDebug(['step', 'continue']);
    const wf = flow(
      [
        { id: 'a', type: 'log', config: { message: 'a' }, step: { pause: true } },
        { id: 'b', type: 'log', config: { message: 'b' } },
        { id: 'c', type: 'log', config: { message: 'c' } },
      ],
      [['a', 'b'], ['b', 'c']],
    );
    await harness(wf, host).runner.runOnce({ debug: {} });
    expect(pauses.map((p) => [p.nodeId, p.reason])).toEqual([['a', 'breakpoint'], ['b', 'step']]);
  });

  it('Stop cancels the run before the paused step runs', async () => {
    const { host } = withDebug(['stop']);
    const h = harness(three(), host);
    const record = await h.runner.runOnce({ debug: {} });
    expect(record.status).toBe('cancelled');
    expect(record.steps.map((s) => [s.nodeId, s.status])).toEqual([['a', 'passed'], ['b', 'skipped']]);
  });

  it('pause on error pauses before the failure is handled, with the error', async () => {
    const { host, pauses } = withDebug(['continue']);
    const wf = flow([{ id: 'x', type: 'assert', config: { subject: 'value', value: 'no', operator: 'equals', expected: 'yes' } }], []);
    const record = await harness(wf, host).runner.runOnce({ debug: { pauseOnError: true } });
    expect(record.status).toBe('failed');
    expect(pauses[0]).toMatchObject({ nodeId: 'x', reason: 'error' });
    expect(pauses[0]!.error).toMatch(/Expected/);
  });

  it('masks secrets in the paused input', async () => {
    const { host, pauses } = withDebug([]);
    host.secretValues = { token: 'supersecret' };
    const wf = flow(
      [
        { id: 'a', type: 'set-variable', config: { name: 'auth', value: '{{secret.token}}' } },
        { id: 'b', type: 'log', config: { message: 'b' }, step: { pause: true } },
      ],
      [['a', 'b']],
    );
    await harness(wf, host).runner.runOnce({ debug: {} });
    expect(JSON.stringify(pauses[0]!.input)).not.toContain('supersecret');
  });
});

describe('trace hooks (M5.1)', () => {
  it('calls before/after for every step of a traced run and stores the trace', async () => {
    const host = new FakeHost();
    const calls: string[] = [];
    host.trace = {
      before: async (info: TraceStepInfo) => { calls.push(`before ${info.nodeId}`); return { before: `shot-${info.nodeId}` }; },
      after: async (info) => { calls.push(`after ${info.nodeId} ${info.status} ${info.before}`); return { url: 'https://x.test/' }; },
    };
    const record = await harness(three(), host).runner.runOnce({ trace: true });
    expect(calls).toEqual(['before a', 'after a passed shot-a', 'before b', 'after b passed shot-b', 'before c', 'after c passed shot-c']);
    expect(record.steps[0]!.trace).toEqual({ before: 'shot-a', url: 'https://x.test/' });
    expect(record.mode).toEqual({ trace: true });
  });

  it('traces single steps with step.trace, and a failing hook never fails the step', async () => {
    const host = new FakeHost();
    host.trace = { before: async () => { throw new Error('no tab'); }, after: async () => ({ url: 'u' }) };
    const wf = flow(
      [
        { id: 'a', type: 'log', config: { message: 'a' } },
        { id: 'b', type: 'log', config: { message: 'b' }, step: { trace: true } },
      ],
      [['a', 'b']],
    );
    const h = harness(wf, host);
    const record = await h.runner.runOnce();
    expect(record.status).toBe('passed');
    expect(record.steps[0]!.trace).toBeUndefined();
    expect(record.steps[1]!.trace).toEqual({ url: 'u' });
    expect(h.logs.some((entry) => /Trace: no tab/.test(entry.message))).toBe(true);
  });

  it('records the failed status for a failing step', async () => {
    const host = new FakeHost();
    const statuses: string[] = [];
    host.trace = { before: async () => undefined, after: async (info) => { statuses.push(info.status); return undefined; } };
    const wf = flow([{ id: 'x', type: 'assert', config: { subject: 'value', value: 'no', operator: 'equals', expected: 'yes' } }], []);
    await harness(wf, host).runner.runOnce({ trace: true });
    expect(statuses).toEqual(['failed']);
  });
});

describe('trace info (M5.1)', () => {
  it('renders a templated locator with the step input, and takes an Open Tab step\'s tab from its output', async () => {
    const host = new FakeHost();
    const seen: TraceStepInfo[] = [];
    host.trace = { before: async () => undefined, after: async (info) => { seen.push(info); return undefined; } };
    const wf = flow(
      [
        { id: 'o', type: 'open-url', config: { url: 'https://shop.example.com/' } },
        { id: 'v', type: 'set-variable', config: { name: 'which', value: 'buy' } },
        { id: 'c', type: 'click', config: { locator: '#{{which}}' } },
      ],
      [['o', 'v'], ['v', 'c']],
    );
    await harness(wf, host).runner.runOnce({ trace: true });
    expect(seen[0]!.nodeId).toBe('o');
    expect(typeof seen[0]!.tabId).toBe('number');
    expect(seen.find((info) => info.nodeId === 'c')?.locator).toBe('#buy');
  });
});

describe('Run from here (M5.5)', () => {
  it('starts at the given block with the given input and continues downstream', async () => {
    const h = harness(three());
    const record = await h.runner.runOnce({ startAt: { nodeId: 'b', input: { n: 7 } } });
    expect(record.status).toBe('passed');
    expect(record.mode).toEqual({ startedAt: 'b' });
    expect(record.steps.map((s) => s.nodeId)).toEqual(['b', 'c']);
    expect(record.steps[0]!.input).toEqual({ n: 7 });
  });

  it('fails clearly when the block no longer exists', async () => {
    const record = await harness(three()).runner.runOnce({ startAt: { nodeId: 'gone', input: {} } });
    expect(record.status).toBe('failed');
    expect(record.error).toMatch(/no block "gone"/);
  });
});
