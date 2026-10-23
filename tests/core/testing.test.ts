import { describe, expect, it } from 'vitest';
import { FakeHost, flow, harness } from '../helpers/fakeHost';
import type { Workflow } from '../../src/core/types';

type Node = { id: string; type: string; config?: Record<string, unknown>; step?: Record<string, unknown> };
const chain = (...nodes: Node[]) => {
  const all: Node[] = [{ id: 'open', type: 'open-url', config: { url: 'https://shop.test/' } }, ...nodes];
  return flow(all, all.slice(1).map((node, index) => [all[index]!.id, node.id] as [string, string]));
};

describe('Assert', () => {
  it('checks data values at once', async () => {
    const h = harness(
      flow(
        [
          { id: 't', type: 'timer', config: { seconds: 5 } },
          { id: 'a', type: 'assert', config: { subject: 'value', value: '{{tick}}', operator: 'equals', expected: '0' } },
          { id: 'b', type: 'assert', config: { subject: 'value', value: '{{tick}}', operator: 'greater', expected: '5' } },
        ],
        [['t', 'a'], ['a', 'b']],
      ),
    );
    const run = await h.runner.runOnce();
    expect(run.steps.find((s) => s.nodeId === 'a')?.status).toBe('passed');
    expect(run.status).toBe('failed');
    expect(run.error).toBe('Assert: Expected value is greater than (numbers) "5", got "0"');
  });

  it('retries page checks until they pass', async () => {
    const host = new FakeHost();
    let reads = 0;
    host.agent = async () => {
      reads += 1;
      return { text: reads < 3 ? 'Loading…' : '  Welcome,\n Akib ', count: 1 };
    };
    const h = harness(chain({ id: 'a', type: 'assert', config: { subject: 'text', locator: 'h1', operator: 'equals', expected: 'Welcome, Akib' } }), host);
    const run = await h.runner.runOnce();
    expect(run.error).toBeUndefined();
    expect(reads).toBe(3);
    expect(run.steps.at(-1)?.output).toMatchObject({ actual: 'Welcome, Akib' });
  });

  it('yes/no checks read visible/checked/enabled', async () => {
    const host = new FakeHost();
    host.agent = async (_tab, request) => ({ text: request.op === 'read' && request.kind === 'checked' ? 'true' : 'false' });
    const h = harness(
      chain(
        { id: 'c', type: 'assert', config: { subject: 'checked', locator: '#tos' } },
        { id: 'h', type: 'assert', config: { subject: 'hidden', locator: '#spinner' } },
      ),
      host,
    );
    expect((await h.runner.runOnce()).status).toBe('passed');
    expect(host.actions.map((a) => a.request)).toEqual([
      { op: 'read', locator: '#tos', kind: 'checked', name: '' },
      { op: 'read', locator: '#spinner', kind: 'visible', name: '' },
    ]);
  });

  it('URL and title come from the tab', async () => {
    const h = harness(chain({ id: 'u', type: 'assert', config: { subject: 'url', operator: 'starts-with', expected: 'https://shop.test' } }));
    expect((await h.runner.runOnce()).status).toBe('passed');
  });

  it('a missing element says so; a custom message wins', async () => {
    const host = new FakeHost();
    host.agent = async () => {
      throw new Error('Timed out after 0s: waiting for h1');
    };
    const h = harness(chain({ id: 'a', type: 'assert', config: { subject: 'text', locator: 'h1', operator: 'contains', expected: 'Hi' }, step: { timeoutSeconds: 1 } }), host);
    expect((await h.runner.runOnce()).error).toBe('Assert: Expected text of h1 contains "Hi", got no matching element');
    const h2 = harness(chain({ id: 'a', type: 'assert', config: { subject: 'value', value: 'a', operator: 'equals', expected: 'b', message: 'Greeting broken' } }));
    expect((await h2.runner.runOnce()).error).toBe('Assert: Greeting broken');
  });

  it('soft: the step and run fail, but the flow goes on', async () => {
    const h = harness(
      chain(
        { id: 'a', type: 'assert', config: { subject: 'value', value: 'x', operator: 'equals', expected: 'y', soft: true } },
        { id: 'next', type: 'log', config: { message: 'still running' } },
      ),
    );
    const run = await h.runner.runOnce();
    expect(run.status).toBe('failed');
    expect(run.steps.find((s) => s.nodeId === 'a')?.status).toBe('failed');
    expect(run.steps.find((s) => s.nodeId === 'next')?.status).toBe('passed');
    expect(h.messages('info')).toContain('still running');
  });
});

describe('Screenshots', () => {
  it('on error by default, of the step\'s tab', async () => {
    const h = harness(chain({ id: 'a', type: 'assert', config: { subject: 'value', value: 'a', operator: 'equals', expected: 'b' } }));
    const run = await h.runner.runOnce();
    expect(h.host.screenshotsTaken).toEqual([{ tabId: 100, runId: run.id }]);
    expect(run.steps.at(-1)?.screenshot).toBe('shot-1');
  });

  it('"always" and "never"; nothing without a tab', async () => {
    const h = harness(
      chain(
        { id: 'l', type: 'log', config: { message: 'x' }, step: { screenshot: 'always' } },
        { id: 'a', type: 'assert', config: { subject: 'value', value: 'a', operator: 'equals', expected: 'b' }, step: { screenshot: 'never' } },
      ),
    );
    await h.runner.runOnce();
    expect(h.host.screenshotsTaken).toHaveLength(1);
    const noTab = harness(flow([{ id: 't', type: 'timer', config: { seconds: 5 } }, { id: 's', type: 'stop', config: { outcome: 'fail' } }], [['t', 's']]));
    await noTab.runner.runOnce();
    expect(noTab.host.screenshotsTaken).toHaveLength(0);
  });
});

describe('Run Workflow', () => {
  const login: Workflow = flow(
    [
      { id: 'f', type: 'fill', config: { locator: 'label=Email', value: '{{email}}' } },
      { id: 'v', type: 'set-variable', config: { name: 'loggedIn', value: 'yes' } },
    ],
    [['f', 'v']],
  );

  it('runs the other workflow in the same tab and returns its data', async () => {
    const host = new FakeHost();
    host.savedWorkflows.set(login.id, login);
    const h = harness(
      chain(
        { id: 'e', type: 'set-variable', config: { name: 'email', value: 'a@b.co' } },
        { id: 'call', type: 'run-workflow', config: { workflow: login.id } },
        { id: 'check', type: 'assert', config: { subject: 'value', value: '{{loggedIn}}', operator: 'equals', expected: 'yes' } },
      ),
      host,
    );
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(host.actions[0]).toMatchObject({ tabId: 100, request: { op: 'fill', value: 'a@b.co' } });
    const child = [...h.runs.values()].find((r) => r.trigger === 'call');
    expect(child?.parentRunId).toBe(run.id);
    expect(run.steps.find((s) => s.nodeId === 'call')?.childRunId).toBe(child?.id);
  });

  it('fails when the called workflow fails, or calls itself forever', async () => {
    const host = new FakeHost();
    host.savedWorkflows.set(login.id, login);
    const h = harness(flow([{ id: 'call', type: 'run-workflow', config: { workflow: login.id } }], []), host);
    expect((await h.runner.runOnce()).error).toContain(`"${login.name}" failed: Fill: No tab named "main"`);

    const self = flow([{ id: 'call', type: 'run-workflow', config: { workflow: 'loop' } }], []);
    self.id = 'loop';
    host.savedWorkflows.set('loop', self);
    const h2 = harness(self, host);
    expect((await h2.runner.runOnce()).error).toContain('nested more than 8 levels deep');
  });
});

describe('Secrets', () => {
  it('fill templates but are masked in logs, step data and errors', async () => {
    const host = new FakeHost();
    host.secretValues = { password: 'hunter22' };
    const h = harness(
      chain(
        { id: 'f', type: 'fill', config: { locator: 'label=Password', value: '{{secret.password}}' } },
        { id: 'v', type: 'set-variable', config: { name: 'leak', value: 'pw={{secret.password}}' } },
        { id: 'l', type: 'log', config: { message: 'the password is {{secret.password}}' } },
        { id: 'a', type: 'assert', config: { subject: 'value', value: '{{secret.password}}', operator: 'equals', expected: 'nope' } },
      ),
      host,
    );
    const run = await h.runner.runOnce();
    expect(host.actions[0]?.request).toMatchObject({ value: 'hunter22' });
    const everything = JSON.stringify([run, h.logs]);
    expect(everything).not.toContain('hunter22');
    expect(h.messages('info')).toContain('the password is •••');
    expect(run.steps.find((s) => s.nodeId === 'v')?.output).toMatchObject({ leak: 'pw=•••' });
    expect(run.error).toContain('got "•••"');
  });
});

describe('Manual Step, Stop, Log', () => {
  it('waits for the user, continues or fails', async () => {
    const h = harness(chain({ id: 'm', type: 'manual-step', config: { message: 'Solve the CAPTCHA' } }, { id: 'l', type: 'log', config: { message: 'after' } }));
    expect((await h.runner.runOnce()).status).toBe('passed');
    expect(h.host.prompts).toEqual(['Solve the CAPTCHA']);
    h.host.promptAnswer = false;
    expect((await h.runner.runOnce()).error).toBe('Manual Step: Failed by the user at a manual step');
  });

  it('Stop ends a path as passed or failed', async () => {
    const pass = harness(chain({ id: 's', type: 'stop', config: { outcome: 'pass', message: 'done early' } }, { id: 'l', type: 'log' }));
    const run = await pass.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(run.steps.map((s) => s.nodeId)).toEqual(['open', 's']);
    const fail = harness(chain({ id: 's', type: 'stop', config: { outcome: 'fail', message: 'Price {{url}} too high' } }));
    expect((await fail.runner.runOnce()).error).toBe('Stop: Price https://shop.test/ too high');
  });
});
