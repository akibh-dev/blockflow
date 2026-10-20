import { describe, expect, it } from 'vitest';
import { FakeHost, flow, harness } from '../helpers/fakeHost';

const SITE = 'https://shop.example.com/item';

describe('Timer as a start block', () => {
  it('schedules a repeating timer on start', async () => {
    const h = harness(flow([{ id: 't', type: 'timer', config: { seconds: 10, repeat: true } }], []));
    await h.runner.start();
    const [key] = h.host.scheduler.keysNamed('tick');
    expect(key).toBeDefined();
    expect(h.host.scheduler.timers.get(key!)).toEqual({ delayMs: 10_000, periodMs: 10_000 });
  });

  it('schedules a one-shot timer when repeat is off, and only fires once', async () => {
    const wf = flow(
      [
        { id: 't', type: 'timer', config: { seconds: 5, repeat: false } },
        { id: 'o', type: 'open-url', config: { url: 'https://example.com' } },
      ],
      [['t', 'o']],
    );
    const h = harness(wf);
    await h.runner.start();
    const [key] = h.host.scheduler.keysNamed('tick');
    expect(h.host.scheduler.timers.get(key!)).toEqual({ delayMs: 5_000 });

    await h.runner.handleTimer(key!);
    await h.runner.handleTimer(key!); // stale: the one-shot record is gone
    expect(h.host.opened).toHaveLength(1);
  });

  it('opens the URL on every tick of a repeating timer, with a rising tick count', async () => {
    const wf = flow(
      [
        { id: 't', type: 'timer', config: { seconds: 10, repeat: true } },
        { id: 'o', type: 'open-url', config: { url: 'https://example.com/{{tick}}' } },
      ],
      [['t', 'o']],
    );
    const h = harness(wf);
    await h.runner.start();
    await h.fire('tick');
    await h.fire('tick');
    await h.fire('tick');
    expect(h.host.opened.map((tab) => tab.url)).toEqual([
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3',
    ]);
  });
});

describe('Open URL', () => {
  it('opens its URL once when it is the only block', async () => {
    const h = harness(flow([{ id: 'o', type: 'open-url', config: { url: 'example.com', active: false } }], []));
    await h.runner.start();
    expect(h.host.opened).toEqual([{ url: 'https://example.com/', newTab: true, active: false }]);
  });

  it('logs an error and does not open anything for an invalid URL', async () => {
    const h = harness(flow([{ id: 'o', type: 'open-url', config: { url: 'javascript:alert(1)' } }], []));
    await h.runner.start();
    expect(h.host.opened).toHaveLength(0);
    expect(h.messages('error')).toEqual(['Open URL: URL must be a valid http(s) URL']);
  });

  it('passes the incoming data on, adding url and tabId', async () => {
    const wf = flow(
      [
        { id: 'o1', type: 'open-url', config: { url: 'https://one.example.com' } },
        { id: 'o2', type: 'open-url', config: { url: '{{url}}?from={{tabId}}' } },
      ],
      [['o1', 'o2']],
    );
    const h = harness(wf);
    await h.runner.start();
    expect(h.host.opened.map((tab) => tab.url)).toEqual([
      'https://one.example.com/',
      'https://one.example.com/?from=100',
    ]);
  });
});

describe('Watch Element as a start block', () => {
  const watchFlow = (extra: Record<string, unknown> = {}) =>
    flow(
      [
        {
          id: 'w',
          type: 'watch-element',
          config: { url: SITE, selector: '.price', intervalSeconds: 30, ...extra },
        },
        { id: 'o', type: 'open-url', config: { url: '{{url}}#changed' } },
      ],
      [['w', 'o']],
    );

  it('reads once on start to record a baseline, without firing, and schedules polling', async () => {
    const host = new FakeHost();
    host.pageTexts('$10');
    const h = harness(watchFlow(), host);
    await h.runner.start();
    expect(host.reads).toEqual([{ url: SITE, selector: '.price', reload: true }]);
    expect(host.opened).toHaveLength(0);
    const [key] = host.scheduler.keysNamed('poll');
    expect(host.scheduler.timers.get(key!)).toEqual({ delayMs: 30_000, periodMs: 30_000 });
  });

  it('fires the next block only when the text changes', async () => {
    const host = new FakeHost();
    host.pageTexts('$10', '$10', '$8', '$8');
    const h = harness(watchFlow(), host);
    await h.runner.start(); // baseline $10
    await h.fire('poll'); // $10: no change
    expect(host.opened).toHaveLength(0);
    await h.fire('poll'); // $8: change
    expect(host.opened).toEqual([{ url: `${SITE}#changed`, newTab: true, active: true }]);
    await h.fire('poll'); // $8: no change
    expect(host.opened).toHaveLength(1);
    expect(h.messages('info')).toContain('Changed: "$10" → "$8"');
  });

  it('ignores whitespace-only changes', async () => {
    const host = new FakeHost();
    host.pageTexts('Price:   $10', ' Price: $10 \n');
    const h = harness(watchFlow(), host);
    await h.runner.start();
    await h.fire('poll');
    expect(host.opened).toHaveLength(0);
  });

  it('puts value and previous into the payload', async () => {
    const wf = flow(
      [
        { id: 'w', type: 'watch-element', config: { url: SITE, selector: '.price' } },
        { id: 'o', type: 'open-url', config: { url: 'https://example.com/?now={{value}}&was={{previous}}' } },
      ],
      [['w', 'o']],
    );
    const host = new FakeHost();
    host.pageTexts('10', '8');
    const h = harness(wf, host);
    await h.runner.start();
    await h.fire('poll');
    expect(host.opened[0]!.url).toBe('https://example.com/?now=8&was=10');
  });

  it('can fire on the first read when asked to', async () => {
    const host = new FakeHost();
    host.pageTexts('$10');
    const h = harness(watchFlow({ emitOnFirstRead: true }), host);
    await h.runner.start();
    expect(host.opened).toHaveLength(1);
  });

  it('warns and does not fire when the element is missing', async () => {
    const host = new FakeHost();
    host.pageReader = async () => ({ found: false, text: '' });
    const h = harness(watchFlow(), host);
    await h.runner.start();
    await h.fire('poll');
    expect(host.opened).toHaveLength(0);
    expect(h.messages('warn')).toEqual([
      'Element not found on the page: .price',
      'Element not found on the page: .price',
    ]);
  });

  it('reports read errors such as an invalid selector', async () => {
    const host = new FakeHost();
    host.pageReader = async () => ({ found: false, text: '', error: 'Invalid selector' });
    const h = harness(watchFlow(), host);
    await h.runner.start();
    expect(h.messages('error')).toEqual(['Watch Element: Invalid selector']);
  });

  it('starts over when the selector changes instead of reporting a false change', async () => {
    const host = new FakeHost();
    host.pageTexts('A', 'B');
    const first = harness(watchFlow(), host);
    await first.runner.start(); // baseline "A" for .price

    const edited = watchFlow({ selector: '.title' });
    const second = harness({ ...edited, id: first.runner.workflowId }, host);
    await second.runner.start(); // different selector, text "B": new baseline
    expect(host.opened).toHaveLength(0);
  });

  it('skips a check while the previous one is still running', async () => {
    const host = new FakeHost();
    host.pageTexts('x');
    const h = harness(watchFlow(), host);
    await h.runner.start();
    const [key] = host.scheduler.keysNamed('poll');

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.pageReader = async () => {
      await gate;
      return { found: true, text: 'x' };
    };
    const readsBefore = host.reads.length;
    const slow = h.runner.handleTimer(key!);
    const overlapping = h.runner.handleTimer(key!);
    await Promise.resolve();
    release();
    await Promise.all([slow, overlapping]);
    expect(host.reads.length - readsBefore).toBe(1);
    expect(h.messages('warn')).toContain('Skipped: the previous check is still running');
  });
});

describe('Composing blocks in any order', () => {
  it('Timer → Watch Element: the timer decides when to check', async () => {
    const wf = flow(
      [
        { id: 't', type: 'timer', config: { seconds: 60, repeat: true } },
        { id: 'w', type: 'watch-element', config: { url: SITE, selector: '.price', intervalSeconds: 9999 } },
        { id: 'o', type: 'open-url', config: { url: '{{url}}#changed' } },
      ],
      [
        ['t', 'w'],
        ['w', 'o'],
      ],
    );
    const host = new FakeHost();
    host.pageTexts('1', '1', '2');
    const h = harness(wf, host);
    await h.runner.start();
    // Only the timer is scheduled: the watcher has no timer of its own.
    expect(host.scheduler.keysNamed('tick')).toHaveLength(1);
    expect(host.scheduler.keysNamed('poll')).toHaveLength(0);
    expect(host.reads).toHaveLength(0);

    await h.fire('tick'); // baseline
    await h.fire('tick'); // same
    expect(host.opened).toHaveLength(0);
    await h.fire('tick'); // changed
    expect(host.opened).toHaveLength(1);
  });

  it('Watch Element → Timer (delay) → Open URL: waits before opening', async () => {
    const wf = flow(
      [
        { id: 'w', type: 'watch-element', config: { url: SITE, selector: '.price' } },
        { id: 'd', type: 'timer', config: { seconds: 20 } },
        { id: 'o', type: 'open-url', config: { url: '{{url}}#after-delay' } },
      ],
      [
        ['w', 'd'],
        ['d', 'o'],
      ],
    );
    const host = new FakeHost();
    host.pageTexts('a', 'b');
    const h = harness(wf, host);
    await h.runner.start();
    await h.fire('poll'); // change detected, but the delay holds the flow
    expect(host.opened).toHaveLength(0);
    const [delayKey] = host.scheduler.keysNamed('delay:');
    expect(host.scheduler.timers.get(delayKey!)!.delayMs).toBe(20_000);

    await h.runner.handleTimer(delayKey!);
    expect(host.opened.map((tab) => tab.url)).toEqual([`${SITE}#after-delay`]);
    expect(host.scheduler.keysNamed('delay:')).toHaveLength(0);
  });

  it('fans out: one block feeds several', async () => {
    const wf = flow(
      [
        { id: 't', type: 'timer', config: { seconds: 5 } },
        { id: 'a', type: 'open-url', config: { url: 'https://a.example.com' } },
        { id: 'b', type: 'open-url', config: { url: 'https://b.example.com' } },
      ],
      [
        ['t', 'a'],
        ['t', 'b'],
      ],
    );
    const h = harness(wf);
    await h.runner.start();
    await h.fire('tick');
    expect(h.host.opened.map((tab) => tab.url)).toEqual(['https://a.example.com/', 'https://b.example.com/']);
  });

  it('starts several root blocks independently', async () => {
    const wf = flow(
      [
        { id: 't1', type: 'timer', config: { seconds: 5 } },
        { id: 't2', type: 'timer', config: { seconds: 7 } },
      ],
      [],
    );
    const h = harness(wf);
    await h.runner.start();
    expect(h.host.scheduler.keysNamed('tick')).toHaveLength(2);
  });

  it('an error in one branch does not stop the other branch', async () => {
    const wf = flow(
      [
        { id: 't', type: 'timer', config: { seconds: 5 } },
        { id: 'bad', type: 'open-url', config: { url: 'javascript:alert(1)' } },
        { id: 'good', type: 'open-url', config: { url: 'https://ok.example.com' } },
      ],
      [
        ['t', 'bad'],
        ['t', 'good'],
      ],
    );
    const h = harness(wf);
    await h.runner.start();
    await h.fire('tick');
    expect(h.host.opened.map((tab) => tab.url)).toEqual(['https://ok.example.com/']);
    expect(h.messages('error')).toHaveLength(1);
  });

  it('stops a loop after maxDepth blocks instead of running forever', async () => {
    const wf = flow(
      [
        { id: 't', type: 'timer', config: { seconds: 5 } },
        { id: 'a', type: 'open-url', config: { url: 'https://a.example.com' } },
        { id: 'b', type: 'open-url', config: { url: 'https://b.example.com' } },
      ],
      [
        ['t', 'a'],
        ['a', 'b'],
        ['b', 'a'],
      ],
    );
    const h = harness(wf, new FakeHost(), 6);
    await h.runner.start();
    await h.fire('tick');
    expect(h.host.opened.length).toBe(6);
    expect(h.messages('error')[0]).toContain('more than 6 blocks in a row');
  });
});

describe('Lifecycle', () => {
  it('stop() clears timers and makes later timer events do nothing', async () => {
    const wf = flow(
      [
        { id: 't', type: 'timer', config: { seconds: 5 } },
        { id: 'o', type: 'open-url', config: { url: 'https://example.com' } },
      ],
      [['t', 'o']],
    );
    const h = harness(wf);
    await h.runner.start();
    const [key] = h.host.scheduler.keysNamed('tick');
    await h.runner.stop();
    expect(h.host.scheduler.timers.size).toBe(0);
    await h.runner.handleTimer(key!);
    expect(h.host.opened).toHaveLength(0);
  });

  it('start() again replaces old timers instead of duplicating them', async () => {
    const h = harness(flow([{ id: 't', type: 'timer', config: { seconds: 5 } }], []));
    await h.runner.start();
    await h.runner.start();
    expect(h.host.scheduler.keysNamed('tick')).toHaveLength(1);
  });

  it('a brand-new runner can continue the flow after the background worker restarted', async () => {
    const wf = flow(
      [
        { id: 'w', type: 'watch-element', config: { url: SITE, selector: '.price' } },
        { id: 'o', type: 'open-url', config: { url: '{{url}}#changed' } },
      ],
      [['w', 'o']],
    );
    const host = new FakeHost();
    host.pageTexts('old', 'new');
    const before = harness(wf, host);
    await before.runner.start(); // baseline "old", saved in host state

    const revived = before.restart(); // fresh instance, never started
    const [key] = host.scheduler.keysNamed('poll');
    await revived.handleTimer(key!);
    expect(host.opened).toHaveLength(1);
  });

  it('ignores timers that belong to another workflow', async () => {
    const a = harness(flow([{ id: 't', type: 'timer', config: { seconds: 5 } }], []));
    await a.runner.start();
    const b = harness(flow([{ id: 't', type: 'timer', config: { seconds: 5 } }], []), a.host);
    const [key] = a.host.scheduler.keysNamed('tick');
    await b.runner.handleTimer(key!);
    expect(b.logs).toEqual([]);
  });

  it('warns when there is nothing to start', async () => {
    const wf = flow(
      [
        { id: 'a', type: 'open-url', config: { url: 'https://a.example.com' } },
        { id: 'b', type: 'open-url', config: { url: 'https://b.example.com' } },
      ],
      [
        ['a', 'b'],
        ['b', 'a'],
      ],
    );
    const h = harness(wf);
    await h.runner.start();
    expect(h.messages('warn')).toEqual(['Nothing to start: every block has an input.']);
    expect(h.host.opened).toHaveLength(0);
  });

  it('logs an error for an unknown block type', async () => {
    const h = harness(flow([{ id: 'x', type: 'mystery' }], []));
    await h.runner.start();
    expect(h.messages('error')).toEqual(['Unknown block type "mystery"']);
  });
});
