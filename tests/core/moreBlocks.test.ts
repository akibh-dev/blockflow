// Unit tests for blocks that had little or no coverage of their main behaviour (IMPLEMENTATION §M0.3):
// Scroll, Page Info, Context Menu, Page Visited, Navigate, Press Key, Stop, Notify, Repeat.
import { describe, expect, it } from 'vitest';
import { MENU_PREFIX, menuClickPayload, menuItemFor, parseMenuItemId } from '../../src/core/blocks/contextMenu';
import type { AgentRequest } from '../../src/core/page';
import { FakeHost, flow, harness } from '../helpers/fakeHost';

type Node = { id: string; type: string; config?: Record<string, unknown>; step?: Record<string, unknown> };

/** Open Tab "main" on https://shop.test, then the given blocks in a line. */
const chain = (...nodes: Node[]) => {
  const all: Node[] = [{ id: 'open', type: 'open-url', config: { url: 'https://shop.test/' } }, ...nodes];
  return flow(all, all.slice(1).map((node, index) => [all[index]!.id, node.id] as [string, string]));
};

const requests = (host: FakeHost): AgentRequest[] => host.actions.map((action) => action.request);

describe('Scroll', () => {
  it('top, bottom and element scroll once', async () => {
    const h = harness(
      chain(
        { id: 'top', type: 'scroll', config: { to: 'top' } },
        { id: 'bottom', type: 'scroll', config: { to: 'bottom' } },
        { id: 'el', type: 'scroll', config: { to: 'element', locator: 'text=Footer' } },
      ),
    );
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(requests(h.host)).toEqual([
      { op: 'scroll', to: 'top' },
      { op: 'scroll', to: 'bottom' },
      { op: 'scroll', to: 'element', locator: 'text=Footer' },
    ]);
    expect(run.steps.find((s) => s.nodeId === 'el')?.output).toMatchObject({ scrolls: 1 });
    expect(h.host.sleeps).not.toContain(1000); // no pause between scrolls (other sleeps are step timeouts)
  });

  it('"end" scrolls until the page height stops changing twice, pausing between scrolls', async () => {
    const host = new FakeHost();
    const heights = [1000, 2000, 3000, 3000, 3000, 9999];
    let index = 0;
    host.agent = async () => ({ height: heights[index++] });
    const h = harness(chain({ id: 's', type: 'scroll', config: { to: 'end', pauseMs: 300 } }), host);
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(requests(host).every((request) => request.op === 'scroll' && request.to === 'bottom')).toBe(true);
    expect(run.steps.find((s) => s.nodeId === 's')?.output).toMatchObject({ scrolls: 5 });
    expect(host.sleeps.filter((ms) => ms === 300)).toHaveLength(5);
    expect(h.messages('info')).toContain('Scrolled 5 times, reached the end');
  });

  it('"end" stops at maxScrolls on a list that never ends', async () => {
    const host = new FakeHost();
    let height = 0;
    host.agent = async () => ({ height: (height += 500) });
    const h = harness(chain({ id: 's', type: 'scroll', config: { to: 'end', maxScrolls: 3, pauseMs: 100 } }), host);
    const run = await h.runner.runOnce();
    expect(run.steps.find((s) => s.nodeId === 's')?.output).toMatchObject({ scrolls: 3 });
    expect(h.messages('info')).toContain('Scrolled 3 times');
  });
});

describe('Page Info', () => {
  it('"page" asks for page-info and outputs it as `page`', async () => {
    const host = new FakeHost();
    const info = { url: 'https://shop.test/', title: 'Shop', meta: { description: 'Things' }, jsonLd: [{ '@type': 'Product' }] };
    host.agent = async (_tab, request) => (request.op === 'page-info' ? info : {});
    const h = harness(chain({ id: 'p', type: 'page-info', config: { area: 'page' } }), host);
    const run = await h.runner.runOnce();
    expect(requests(host)).toEqual([{ op: 'page-info' }]);
    expect(run.steps.find((s) => s.nodeId === 'p')?.output).toMatchObject({ page: info });
  });

  it('local, session and cookies read one key (templated) or all of them as `value`', async () => {
    const host = new FakeHost();
    host.agent = async (_tab, request) => {
      if (request.op !== 'storage') return {};
      return { value: request.key ? `${request.area}:${request.key}` : { all: request.area } };
    };
    const h = harness(
      chain(
        { id: 'v', type: 'set-variable', config: { name: 'which', value: 'theme' } },
        { id: 'local', type: 'page-info', config: { area: 'local', key: '{{which}}' } },
        { id: 'session', type: 'page-info', config: { area: 'session', key: '  ' } },
        { id: 'cookies', type: 'page-info', config: { area: 'cookies', key: 'sid' } },
      ),
      host,
    );
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(requests(host)).toEqual([
      { op: 'storage', area: 'local', key: 'theme' },
      { op: 'storage', area: 'session' },
      { op: 'storage', area: 'cookies', key: 'sid' },
    ]);
    const output = (id: string) => run.steps.find((s) => s.nodeId === id)?.output;
    expect(output('local')).toMatchObject({ value: 'local:theme' });
    expect(output('session')).toMatchObject({ value: { all: 'session' } });
    expect(output('cookies')).toMatchObject({ value: 'cookies:sid' });
  });
});

describe('Page Snapshot', () => {
  it('asks for a snapshot (of a part, capped) and outputs the outline and the elements', async () => {
    const host = new FakeHost();
    const elements = [{ ref: 'e1', role: 'button', name: 'Go', tag: 'button', locator: 'role=button[name="Go"]' }];
    host.agent = async (_tab, request) =>
      request.op === 'snapshot' ? { snapshot: '- button "Go" [ref=e1] locator=role=button[name="Go"]', elements, url: 'https://shop.test/', title: 'Shop', lines: 1, truncated: false } : {};
    const h = harness(
      chain(
        { id: 'all', type: 'page-snapshot', config: {} },
        { id: 'part', type: 'page-snapshot', config: { locator: ' role=main ', maxLines: 20 } },
      ),
      host,
    );
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(requests(host)).toEqual([
      { op: 'snapshot', maxLines: 1500 },
      { op: 'snapshot', locator: 'role=main', maxLines: 20 },
    ]);
    expect(run.steps.find((s) => s.nodeId === 'all')?.output).toMatchObject({ snapshot: expect.stringContaining('- button "Go"'), elements });
  });
});

describe('Context Menu', () => {
  it('config → menu item: id names the workflow and node, title falls back to the workflow name', () => {
    expect(menuItemFor({ id: 'wf1', name: 'Save it' }, 'm', { title: 'Save this product', contexts: 'link' })).toEqual({
      id: `${MENU_PREFIX}wf1::m`,
      title: 'Save this product',
      contexts: ['link'],
    });
    expect(menuItemFor({ id: 'wf1', name: 'Save it' }, 'm', { title: '' })).toMatchObject({ title: 'Save it', contexts: ['all'] });
    expect(menuItemFor({ id: 'wf1', name: 'x' }, 'm', { contexts: 'nonsense' }).contexts).toEqual(['all']);
  });

  it('menu item ids round-trip; other extensions\' items are ignored', () => {
    expect(parseMenuItemId(menuItemFor({ id: 'wf-9', name: '' }, 'node-2', {}).id)).toEqual({ workflowId: 'wf-9', nodeId: 'node-2' });
    expect(parseMenuItemId('something-else')).toBeNull();
    expect(parseMenuItemId(`${MENU_PREFIX}wf-9`)).toBeNull();
  });

  it('click → event payload: page, selection, link, image; the tab becomes "main"', () => {
    const payload = menuClickPayload({ pageUrl: 'https://shop.test/p/1', selectionText: 'Blue mug', linkUrl: 'https://shop.test/p/2' }, 7);
    expect(payload).toMatchObject({ url: 'https://shop.test/p/1', selection: 'Blue mug', link: 'https://shop.test/p/2', src: '', tabId: 7, $session: { tabs: { main: 7 } } });
    expect(menuClickPayload({}, undefined)).toEqual({ url: '', selection: '', link: '', src: '', tabId: null });
  });

  it('a click starts the flow on the right-clicked tab, with the selection available', async () => {
    const h = harness(
      flow(
        [
          { id: 'm', type: 'context-menu', config: { title: 'Save', contexts: 'selection' } },
          { id: 'l', type: 'log', config: { message: 'saving {{selection}}' } },
          { id: 'c', type: 'click', config: { locator: '#save' } },
        ],
        [['m', 'l'], ['l', 'c']],
      ),
    );
    await h.runner.start();
    expect(h.messages('info')).toContain('Right-click menu item “Save” is ready');
    h.host.tabUrls.set(7, 'https://shop.test/p/1');
    const run = await h.runner.handleEvent('m', menuClickPayload({ pageUrl: 'https://shop.test/p/1', selectionText: 'Blue mug' }, 7));
    expect(run?.trigger).toBe('event');
    expect(run?.status).toBe('passed');
    expect(h.messages('info')).toContain('saving Blue mug');
    expect(h.host.actions[0]?.tabId).toBe(7);
  });
});

describe('Page Visited', () => {
  it('says what it waits for when switched on', async () => {
    const h = harness(flow([{ id: 'p', type: 'page-visited', config: { url: '/checkout' } }], []));
    await h.runner.start();
    expect(h.messages('info')).toContain('Waiting for pages matching /checkout');
  });
});

describe('Navigate', () => {
  it('back, forward and reload act on the run\'s tab; goto needs a valid URL', async () => {
    const h = harness(
      chain(
        { id: 'b', type: 'navigate', config: { action: 'back' } },
        { id: 'f', type: 'navigate', config: { action: 'forward' } },
        { id: 'r', type: 'navigate', config: { action: 'reload' } },
        { id: 'g', type: 'navigate', config: { action: 'goto', url: 'not a url' } },
      ),
    );
    const run = await h.runner.runOnce();
    expect(h.host.navigations.map((n) => [n.tabId, n.options.action, n.options.url])).toEqual([
      [100, 'back', undefined],
      [100, 'forward', undefined],
      [100, 'reload', undefined],
    ]);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('"not a url" is not a valid http(s) URL');
  });
});

describe('Press Key', () => {
  it('presses on the focused element, or on a located one', async () => {
    const h = harness(
      chain(
        { id: 'a', type: 'press-key', config: { key: ' Control+A ' } },
        { id: 'e', type: 'press-key', config: { key: 'Enter', locator: 'label=Search' } },
      ),
    );
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(requests(h.host)).toEqual([
      { op: 'press', key: 'Control+A' },
      { op: 'press', key: 'Enter', locator: 'label=Search' },
    ]);
  });
});

describe('Stop', () => {
  it('pass ends the path without failing; nothing after it runs', async () => {
    const h = harness(flow([{ id: 's', type: 'stop', config: { outcome: 'pass' } }, { id: 'l', type: 'log', config: { message: 'after' } }], [['s', 'l']]));
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(h.messages('info')).toContain('Stopped as passed');
    expect(h.messages('info')).not.toContain('after');
  });

  it('fail without a message still explains itself', async () => {
    const h = harness(flow([{ id: 's', type: 'stop', config: { outcome: 'fail', message: '' } }], []));
    const run = await h.runner.runOnce();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('Stopped as failed');
  });
});

describe('Notify', () => {
  it('fills in title and message, notifies once and passes data on with notified: true', async () => {
    const h = harness(
      flow(
        [
          { id: 'v', type: 'set-variable', config: { name: 'price', value: '12' } },
          { id: 'n', type: 'notify', config: { title: 'Price {{price}}', message: '' } },
        ],
        [['v', 'n']],
      ),
    );
    const run = await h.runner.runOnce();
    expect(h.host.notifications).toEqual([{ title: 'Price 12', message: '' }]);
    expect(run.steps.find((s) => s.nodeId === 'n')?.output).toMatchObject({ price: '12', notified: true });
    expect(h.messages('info')).toContain('Notified: Price 12');
  });
});

describe('Repeat', () => {
  it('runs "each" the given number of times, then "done" once', async () => {
    const h = harness(
      flow(
        [
          { id: 'r', type: 'repeat', config: { times: 2 } },
          { id: 'e', type: 'log', config: { message: 'each {{iteration}}' } },
          { id: 'd', type: 'log', config: { message: 'done' } },
        ],
        [['r', 'e', 'each'], ['r', 'd', 'done']],
      ),
    );
    await h.runner.runOnce();
    expect(h.messages('info').filter((m) => m.startsWith('each') || m === 'done')).toEqual(['each 1', 'each 2', 'done']);
  });
});
