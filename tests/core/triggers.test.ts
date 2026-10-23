import { describe, expect, it } from 'vitest';
import { FakeHost, flow, harness } from '../helpers/fakeHost';
import type { Workflow } from '../../src/core/types';

describe('Schedule', () => {
  it('plans the next time, fires, and plans again', async () => {
    const host = new FakeHost(); // clock: 2026-01-01T00:00:00Z
    const h = harness(flow([{ id: 's', type: 'schedule', config: { every: 'minutes', minutes: 30 } }, { id: 'l', type: 'log', config: { message: 'fired' } }], [['s', 'l']]), host);
    await h.runner.start();
    const [key] = host.scheduler.keysNamed('next');
    const timer = host.scheduler.timers.get(key as string);
    expect(timer?.delayMs).toBe(30 * 60 * 1000);
    await h.fire('next');
    expect(h.messages('info')).toContain('fired');
    expect(host.scheduler.keysNamed('next')).toHaveLength(1);
  });

  it('rejects a bad time when switched on', async () => {
    const h = harness(flow([{ id: 's', type: 'schedule', config: { every: 'day', at: '9am' } }], []));
    await h.runner.start();
    expect(h.messages('error').join()).toContain('"9am" is not a time');
  });
});

describe('Start block', () => {
  it('gives its starting values on Run, and lets a caller override them', async () => {
    const callee: Workflow = flow(
      [
        { id: 'st', type: 'start', config: { inputs: [{ name: 'email', value: 'default@x.co' }, { name: 'plan', value: 'free' }] } },
        { id: 'l', type: 'log', config: { message: '{{email}}/{{plan}}' } },
      ],
      [['st', 'l']],
    );
    const own = harness(callee);
    await own.runner.runOnce();
    expect(own.messages('info')).toContain('default@x.co/free');

    const host = new FakeHost();
    host.savedWorkflows.set(callee.id, callee);
    const caller = harness(
      flow([{ id: 'v', type: 'set-variable', config: { name: 'email', value: 'given@x.co' } }, { id: 'c', type: 'run-workflow', config: { workflow: callee.id } }], [['v', 'c']]),
      host,
    );
    await caller.runner.runOnce();
    expect(caller.messages('info')).toContain('given@x.co/free');
  });
});

describe('Page Visited / Context Menu', () => {
  const wf = (type: string) => flow([{ id: 'p', type, config: { url: '/checkout', title: 'Go' } }, { id: 'c', type: 'click', config: { locator: '#buy' } }], [['p', 'c']]);

  it('an outside event starts a run on that tab', async () => {
    const h = harness(wf('page-visited'));
    h.host.tabUrls.set(7, 'https://shop.test/checkout');
    const run = await h.runner.handleEvent('p', { url: 'https://shop.test/checkout', $session: { tabs: { main: 7 } } });
    expect(run?.trigger).toBe('event');
    expect(h.host.actions[0]?.tabId).toBe(7);
  });

  it('the Run button uses the tab you are on, or explains there is none', async () => {
    const h = harness(wf('context-menu'));
    h.host.tabUrls.set(9, 'https://shop.test/');
    h.host.currentTab = { tabId: 9, url: 'https://shop.test/' };
    await h.runner.runOnce();
    expect(h.host.actions[0]?.tabId).toBe(9);

    const none = harness(wf('page-visited'));
    const run = await none.runner.runOnce();
    expect(run.steps.map((s) => s.nodeId)).toEqual(['p']);
    expect(none.messages('warn')).toContain('No web page tab to use. Open one and try again.');
  });
});
