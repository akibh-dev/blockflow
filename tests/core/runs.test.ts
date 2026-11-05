import { describe, expect, it } from 'vitest';
import { testClause, testCondition, parseNumber } from '../../src/core/condition';
import { compactPayload, markInterrupted } from '../../src/core/runs';
import type { RunRecord } from '../../src/core/runs';
import type { BlockDefinition } from '../../src/core/types';
import { WorkflowRunner } from '../../src/core/engine';
import { createDefaultRegistry } from '../../src/core/blocks';
import { routeTo } from '../../src/core/ports';
import { FakeHost, flow, harness } from '../helpers/fakeHost';

const timer = { id: 't', type: 'timer', config: { seconds: 5, repeat: false } };

describe('If with true/false outputs', () => {
  const wf = (right: string) =>
    flow(
      [
        timer,
        { id: 'i', type: 'if', config: { left: '{{tick}}', operator: 'equals', right } },
        { id: 'yes', type: 'open-url', config: { url: 'https://yes.test' } },
        { id: 'no', type: 'open-url', config: { url: 'https://no.test' } },
      ],
      [['t', 'i'], ['i', 'yes', 'true'], ['i', 'no', 'false']],
    );

  it('takes the true branch', async () => {
    const h = harness(wf('1'));
    await h.runner.start();
    await h.fire('tick');
    expect(h.host.opened.map((tab) => tab.url)).toEqual(['https://yes.test/']);
    expect(h.lastRun()?.steps.find((s) => s.nodeId === 'i')?.port).toBe('true');
  });

  it('takes the false branch', async () => {
    const h = harness(wf('2'));
    await h.runner.start();
    await h.fire('tick');
    expect(h.host.opened.map((tab) => tab.url)).toEqual(['https://no.test/']);
  });

  it('treats an old connection without a port as the "true" output', async () => {
    const old = flow(
      [timer, { id: 'i', type: 'if', config: { left: '1', operator: 'equals', right: '1' } }, { id: 'o', type: 'open-url', config: { url: 'https://old.test' } }],
      [['t', 'i'], ['i', 'o']],
    );
    const h = harness(old);
    await h.runner.start();
    await h.fire('tick');
    expect(h.host.opened).toHaveLength(1);
  });
});

describe('Run button (runOnce)', () => {
  it('fires a Timer start block once, now, and schedules nothing', async () => {
    const h = harness(flow([timer, { id: 'o', type: 'open-url', config: { url: 'https://now.test' } }], [['t', 'o']]));
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(run.trigger).toBe('manual');
    expect(h.host.opened).toHaveLength(1);
    expect(h.host.scheduler.timers.size).toBe(0);
    expect(run.steps.map((s) => [s.nodeId, s.status])).toEqual([['t', 'passed'], ['o', 'passed']]);
    expect(run.steps[1]?.input).toMatchObject({ tick: 0 });
    expect(run.steps[1]?.output).toMatchObject({ url: 'https://now.test/', tabId: 100 });
  });

  it('reads a Watch Element start block once and passes the value on', async () => {
    const host = new FakeHost();
    host.pageTexts('42');
    const h = harness(
      flow(
        [
          { id: 'w', type: 'watch-element', config: { url: 'https://a.test', selector: '#x' } },
          { id: 's', type: 'set-variable', config: { name: 'got', value: '{{value}}' } },
        ],
        [['w', 's']],
      ),
      host,
    );
    const run = await h.runner.runOnce();
    expect(run.steps[1]?.output).toMatchObject({ got: '42' });
  });

  it('fails a run whose step fails, and says why', async () => {
    const h = harness(flow([timer, { id: 'o', type: 'open-url', config: { url: '{{nope}}' } }], [['t', 'o']]));
    const run = await h.runner.runOnce();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('Open Tab');
    expect(run.steps[1]?.status).toBe('failed');
  });

  it('can be cancelled between steps', async () => {
    const cancelled = new Set<string>();
    let runId = '';
    const host = new FakeHost();
    const runner = new WorkflowRunner({
      workflow: flow(
        [timer, { id: 'a', type: 'open-url', config: { url: 'https://a.test' } }, { id: 'b', type: 'open-url', config: { url: 'https://b.test' } }],
        [['t', 'a'], ['a', 'b']],
      ),
      registry: createDefaultRegistry(),
      host,
      onRun: (run) => {
        runId = run.id;
        // Press Stop as soon as block a has finished.
        if (run.steps.some((s) => s.nodeId === 'a' && s.status === 'passed')) cancelled.add(runId);
      },
      isCancelled: (id) => cancelled.has(id),
    });
    const run = await runner.runOnce();
    expect(run.status).toBe('cancelled');
    expect(host.opened.map((tab) => tab.url)).toEqual(['https://a.test/']);
  });
});

describe('Step settings', () => {
  const failing = (step: Record<string, unknown>) =>
    flow(
      [
        timer,
        { id: 'h', type: 'http-request', config: { url: 'https://api.test' }, step },
        { id: 'ok', type: 'set-variable', config: { name: 'next', value: 'ran' } },
        { id: 'err', type: 'set-variable', config: { name: 'handled', value: '{{error}}' } },
      ],
      [['t', 'h'], ['h', 'ok'], ['h', 'err', 'error']],
    );

  const down = () => {
    const host = new FakeHost();
    host.httpHandler = async () => {
      throw new Error('network down');
    };
    return host;
  };

  it('stop (default): the path stops and the run fails', async () => {
    const h = harness(failing({}), down());
    const run = await h.runner.runOnce();
    expect(run.status).toBe('failed');
    expect(run.steps.map((s) => s.nodeId)).toEqual(['t', 'h']);
  });

  it('continue: passes the input on and the run passes', async () => {
    const h = harness(failing({ onError: 'continue' }), down());
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(run.steps.find((s) => s.nodeId === 'h')?.status).toBe('handled');
    expect(run.steps.find((s) => s.nodeId === 'ok')?.output).toMatchObject({ next: 'ran' });
  });

  it('port: sends the error out of the error output only', async () => {
    const h = harness(failing({ onError: 'port' }), down());
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(run.steps.map((s) => s.nodeId)).toEqual(['t', 'h', 'err']);
    expect(run.steps[2]?.output).toMatchObject({ handled: 'network down' });
  });

  it('retries with backoff, then succeeds', async () => {
    const host = new FakeHost();
    let calls = 0;
    host.httpHandler = async () => {
      calls += 1;
      if (calls < 3) throw new Error('flaky');
      return { status: 200, ok: true, body: '' };
    };
    const h = harness(failing({ retries: 3 }), host);
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(run.steps.find((s) => s.nodeId === 'h')?.attempts).toBe(3);
    expect(host.sleeps).toEqual(expect.arrayContaining([1000, 2000]));
    expect(h.messages('warn').join('\n')).toContain('Retrying in 1s (attempt 2 of 4)');
  });

  it('times out a step that never finishes', async () => {
    const host = new FakeHost();
    host.httpHandler = () => new Promise(() => {});
    const h = harness(failing({ timeoutSeconds: 2 }), host);
    const run = await h.runner.runOnce();
    expect(run.status).toBe('failed');
    expect(run.error).toBe('HTTP Request: Timed out after 2s');
    expect(host.sleeps).toContain(2000);
  });

  it('a timed-out step is fenced off: no more outputs, no overlap with the retry, nothing after the run ends', async () => {
    const host = new FakeHost();
    // Each item's request takes 5 s; For Each may only take 2 s in all.
    host.httpHandler = async () => {
      await host.sleep(5000);
      return { status: 200, ok: true, headers: {}, body: 'ok' };
    };
    const h = harness(
      flow(
        [
          { id: 'loop', type: 'for-each', config: { list: '[1, 2, 3]', as: 'item' }, step: { timeoutSeconds: 2 } },
          { id: 'get', type: 'http-request', config: { url: 'https://a.test/{{item}}' } },
          { id: 'after', type: 'log', config: { message: 'after {{item}}' } },
        ],
        [
          ['loop', 'get', 'each'],
          ['get', 'after'],
        ],
      ),
      host,
    );
    const run = await h.runner.runOnce();
    expect(run.status).toBe('failed');
    expect(run.error).toBe('For Each: Timed out after 2s');
    // Let the first item's request finish after the timeout.
    await host.sleep(10_000);
    expect(host.requests.map((r) => r.url)).toEqual(['https://a.test/1']);
    expect(h.messages().some((m) => m.startsWith('after'))).toBe(false);
    expect(h.lastRun()?.steps.map((s) => s.nodeId)).toEqual(['loop', 'get']);
  });

  it('disabled: skips the block and passes the input on', async () => {
    const h = harness(failing({ disabled: true }), down());
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(h.host.requests).toHaveLength(0);
    expect(run.steps.find((s) => s.nodeId === 'h')?.status).toBe('skipped');
  });
});

describe('Runs from schedules', () => {
  it('each timer firing is its own run, with the timer as the first step', async () => {
    const h = harness(
      flow([{ id: 't', type: 'timer', config: { seconds: 5, repeat: true } }, { id: 'o', type: 'open-url', config: { url: 'https://a.test' } }], [['t', 'o']]),
    );
    await h.runner.start();
    await h.fire('tick');
    await h.fire('tick');
    const runs = [...h.runs.values()];
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.trigger === 'timer' && run.status === 'passed')).toBe(true);
    expect(runs[1]?.steps[0]).toMatchObject({ nodeId: 't', output: { tick: 2 } });
  });

  it('an unknown output is a failure, not silence', async () => {
    const registry = createDefaultRegistry().register({
      type: 'bad-router',
      label: 'Bad',
      description: '',
      icon: '',
      accent: '',
      defaultConfig: {},
      fields: [],
      outputs: [],
      run: async (_ctx, input) => routeTo('nowhere', input),
    } satisfies BlockDefinition);
    const runner = new WorkflowRunner({
      workflow: flow([timer, { id: 'b', type: 'bad-router' }], [['t', 'b']]),
      registry,
      host: new FakeHost(),
    });
    const run = await runner.runOnce();
    expect(run.error).toContain('"nowhere"');
  });
});

describe('Conditions', () => {
  it('compares numbers written like prices', () => {
    expect(parseNumber('$1,250.50')).toBe(1250.5);
    expect(parseNumber('abc')).toBeNull();
    expect(testClause({ left: '1,250', operator: 'greater-equal', right: '1250' })).toBe(true);
    expect(testClause({ left: '', operator: 'less', right: '5' })).toBe(false);
  });

  it('supports patterns, starts/ends with, and truthiness', () => {
    expect(testClause({ left: 'Order #123 placed', operator: 'matches', right: '/order #\\d+/i' })).toBe(true);
    expect(testClause({ left: 'abc', operator: 'starts-with', right: 'ab' })).toBe(true);
    expect(testClause({ left: 'Yes', operator: 'true', right: '' })).toBe(true);
    expect(testClause({ left: '0', operator: 'false', right: '' })).toBe(true);
    expect(() => testClause({ left: 'a', operator: 'matches', right: '(' })).toThrow('Invalid pattern');
    expect(() => testClause({ left: 'a', operator: 'nope', right: '' })).toThrow('Unknown condition');
  });

  it('joins clauses with all / any', () => {
    const clauses = [
      { left: 'a', operator: 'equals', right: 'a' },
      { left: 'a', operator: 'equals', right: 'b' },
    ];
    expect(testCondition({ match: 'all', clauses })).toBe(false);
    expect(testCondition({ match: 'any', clauses })).toBe(true);
  });
});

describe('Run records', () => {
  it('replaces large payloads with a preview', () => {
    const big = { text: 'x'.repeat(10_000) };
    const compact = compactPayload(big);
    expect(compact?.$size).toBeGreaterThan(10_000);
    expect(String(compact?.$preview).length).toBeLessThan(3_100);
    expect(compactPayload({ a: 1 })).toEqual({ a: 1 });
  });

  it('marks runs left "running" by a dead worker as interrupted, but not live ones', () => {
    const base: RunRecord = {
      id: 'dead',
      workflowId: 'w',
      workflowName: 'W',
      trigger: 'manual',
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      steps: [{ nodeId: 'a', blockType: 'timer', status: 'running', startedAt: '', attempts: 1 }],
    };
    const [dead, live] = markInterrupted([base, { ...base, id: 'live' }], new Set(['live']), 'now');
    expect(dead?.status).toBe('interrupted');
    expect(dead?.steps[0]?.status).toBe('failed');
    expect(live?.status).toBe('running');
  });
});
