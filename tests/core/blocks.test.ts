import { describe, expect, it } from 'vitest';
import { FakeHost, flow, harness } from '../helpers/fakeHost';

describe('Set Variable → If → Notify', () => {
  const wf = (right: string) =>
    flow(
      [
        { id: 't', type: 'timer', config: { seconds: 1, repeat: false } },
        { id: 's', type: 'set-variable', config: { name: 'price', value: '1,250' } },
        { id: 'i', type: 'if', config: { left: '{{price}}', operator: 'greater', right } },
        { id: 'n', type: 'notify', config: { title: 'Price', message: 'now {{price}}' } },
      ],
      [['t', 's'], ['s', 'i'], ['i', 'n']],
    );

  it('continues when the condition is true', async () => {
    const h = harness(wf('1000'));
    await h.runner.start();
    await h.fire('tick');
    expect(h.host.notifications).toEqual([{ title: 'Price', message: 'now 1,250' }]);
  });

  it('stops when the condition is false', async () => {
    const h = harness(wf('2000'));
    await h.runner.start();
    await h.fire('tick');
    expect(h.host.notifications).toEqual([]);
  });
});

describe('HTTP Request', () => {
  const wf = (config: Record<string, unknown>) =>
    flow(
      [
        { id: 't', type: 'timer', config: { seconds: 1, repeat: false } },
        { id: 'h', type: 'http-request', config },
        { id: 'o', type: 'open-url', config: { url: '{{data.next}}' } },
      ],
      [['t', 'h'], ['h', 'o']],
    );

  it('sends headers and body, and exposes parsed JSON', async () => {
    const host = new FakeHost();
    host.httpHandler = async () => ({ status: 200, ok: true, body: '{"next":"https://a.test/x"}' });
    const h = harness(
      wf({ url: 'https://api.test/q', method: 'POST', headers: 'X-Key: abc\nbad line', body: '{"a":1}' }),
      host,
    );
    await h.runner.start();
    await h.fire('tick');
    expect(host.requests).toEqual([
      { url: 'https://api.test/q', method: 'POST', headers: { 'X-Key': 'abc' }, body: '{"a":1}' },
    ]);
    expect(host.opened[0]?.url).toBe('https://a.test/x');
  });

  it('does not send a body with GET', async () => {
    const host = new FakeHost();
    const h = harness(wf({ url: 'https://api.test/q', method: 'GET', body: 'x' }), host);
    await h.runner.start();
    await h.fire('tick');
    expect(host.requests[0]).not.toHaveProperty('body');
  });

  it('fails the step on an HTTP error by default (run failed, error output usable), continues when told to', async () => {
    const host = new FakeHost();
    host.httpHandler = async () => ({ status: 500, ok: false, body: 'oops' });
    const failing = harness(wf({ url: 'https://api.test/q' }), host);
    await failing.runner.start();
    await failing.fire('tick');
    expect(failing.lastRun()?.status).toBe('failed');
    expect(failing.lastRun()?.error).toBe('HTTP Request: GET https://api.test/q answered 500: oops');

    const handled = flow(
      [
        { id: 'h', type: 'http-request', config: { url: 'https://api.test/q' }, step: { onError: 'port' } },
        { id: 'n', type: 'notify', config: { title: 'down', message: '{{error}}' } },
      ],
      [['h', 'n', 'error']],
    );
    const h2 = harness(handled, host);
    expect((await h2.runner.runOnce()).status).toBe('passed');
    expect(host.notifications.map((n) => n.message)).toEqual(['GET https://api.test/q answered 500: oops']);

    const lenient = harness(wf({ url: 'https://api.test/q', failOnError: false }), host);
    await lenient.runner.start();
    await lenient.fire('tick');
    // The response goes on (status 500, ok false); Open URL then has no URL from it and fails.
    expect(host.opened).toHaveLength(0);
    expect(lenient.lastRun()?.steps.find((s) => s.nodeId === 'h')?.status).toBe('passed');
  });
});

describe('Read Element → If → Notify (state tracking)', () => {
  const wf = (read: Record<string, unknown>, ifConfig: Record<string, unknown>) =>
    flow(
      [
        { id: 't', type: 'timer', config: { seconds: 1, repeat: true } },
        { id: 'r', type: 'read-element', config: { url: 'https://akibh.dev', selector: 'html', ...read } },
        { id: 'i', type: 'if', config: ifConfig },
        { id: 'n', type: 'notify', config: { title: 'Site', message: '{{previous}} → {{value}}' } },
      ],
      [['t', 'r'], ['r', 'i'], ['i', 'n']],
    );

  const readsText = (host: FakeHost, ...values: string[]) => {
    let index = 0;
    host.pageReader = async () => {
      const text = values[Math.min(index++, values.length - 1)] ?? '';
      return { found: true, text, count: Number(text) || 0 };
    };
  };

  it('passes the read kind and attribute name to the page', async () => {
    const host = new FakeHost();
    readsText(host, 'true');
    const h = harness(wf({ read: 'has-class', name: 'dark' }, { left: '{{value}}', operator: 'equals', right: 'true' }), host);
    await h.runner.start();
    await h.fire('tick');
    expect(host.reads[0]?.read).toEqual({ kind: 'has-class', name: 'dark' });
    expect(host.notifications).toHaveLength(1);
  });

  it('notifies only when the count goes up', async () => {
    const host = new FakeHost();
    readsText(host, '3', '3', '4');
    const h = harness(
      wf({ read: 'count', selector: 'a.post' }, { left: '{{value}}', operator: 'greater', right: '{{previous}}' }),
      host,
    );
    await h.runner.start();
    await h.fire('tick'); // first read: no previous, stays quiet
    await h.fire('tick'); // 3 → 3
    expect(host.notifications).toEqual([]);
    await h.fire('tick'); // 3 → 4
    expect(host.notifications).toEqual([{ title: 'Site', message: '3 → 4' }]);
  });

  it('flags a change in an attribute', async () => {
    const host = new FakeHost();
    readsText(host, 'true', 'false');
    const h = harness(
      wf({ read: 'attribute', name: 'aria-pressed' }, { left: '{{changed}}', operator: 'equals', right: 'true' }),
      host,
    );
    await h.runner.start();
    await h.fire('tick');
    await h.fire('tick');
    expect(host.notifications).toEqual([{ title: 'Site', message: 'true → false' }]);
  });

  it('requires a name for attribute and class reads', async () => {
    const h = harness(wf({ read: 'attribute', name: '' }, { left: 'a', operator: 'equals', right: 'a' }));
    await h.runner.start();
    await h.fire('tick');
    expect(h.messages('error').join()).toContain('name is required');
  });
});
