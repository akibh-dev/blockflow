import { describe, expect, it } from 'vitest';
import { validateConfig, withDefaults } from '../../src/core/config';
import { fillFormBlock } from '../../src/core/blocks';
import { urlMatches } from '../../src/core/urlPattern';
import { FakeHost, flow, harness } from '../helpers/fakeHost';

type Node = { id: string; type: string; config?: Record<string, unknown>; step?: Record<string, unknown> };

/** Open Tab "main" on https://shop.test, then the given blocks in a line. */
const chain = (...nodes: Node[]) => {
  const all: Node[] = [{ id: 'open', type: 'open-url', config: { url: 'https://shop.test/login' } }, ...nodes];
  return flow(all, all.slice(1).map((node, index) => [all[index]!.id, node.id] as [string, string]));
};

describe('Open Tab and the run\'s tabs', () => {
  it('remembers the tab by name for later blocks, and waits for load by default', async () => {
    const h = harness(chain({ id: 'c', type: 'click', config: { locator: 'text=Sign in' } }));
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(h.host.loads).toEqual([{ tabId: 100, until: 'load' }]);
    expect(run.steps[0]?.output).toMatchObject({ tabId: 100, $session: { tabs: { main: 100 } } });
    expect(h.host.actions).toEqual([
      { tabId: 100, request: { op: 'click', locator: 'text=Sign in', action: 'click', force: false }, timeoutMs: 29_500 },
    ]);
  });

  it('a second named tab is separate', async () => {
    const h = harness(
      chain(
        { id: 'o2', type: 'open-url', config: { url: 'https://admin.test', tab: 'admin' } },
        { id: 'c', type: 'click', config: { locator: '#a', tab: 'admin' } },
        { id: 'c2', type: 'click', config: { locator: '#m' } },
      ),
    );
    await h.runner.runOnce();
    expect(h.host.actions.map((action) => action.tabId)).toEqual([101, 100]);
  });

  it('page blocks without an Open Tab before them explain what is missing', async () => {
    const h = harness(flow([{ id: 't', type: 'timer', config: { seconds: 5 } }, { id: 'c', type: 'click', config: { locator: '#x' } }], [['t', 'c']]));
    const run = await h.runner.runOnce();
    expect(run.error).toContain('No tab named "main" in this run. Put an Open Tab block');
  });

  it('"this workflow\'s own tab" is reused by the next run', async () => {
    const h = harness(flow([{ id: 'o', type: 'open-url', config: { url: 'https://a.test', where: 'workflow' } }], []));
    await h.runner.runOnce();
    await h.runner.runOnce();
    expect(h.host.opened.map((open) => open.reuseTabId)).toEqual([undefined, 100]);
    expect(h.host.tabUrls.size).toBe(1);
  });

  it('old "open in current tab" settings still mean the current tab', async () => {
    const h = harness(flow([{ id: 'o', type: 'open-url', config: { url: 'https://a.test', newTab: false } }], []));
    await h.runner.runOnce();
    expect(h.host.opened[0]).toMatchObject({ newTab: false });
  });

  it('a step timeout setting shortens the page wait', async () => {
    const h = harness(chain({ id: 'c', type: 'click', config: { locator: '#x' }, step: { timeoutSeconds: 5 } }));
    await h.runner.runOnce();
    expect(h.host.actions[0]?.timeoutMs).toBe(4_500);
  });
});

describe('page actions send the right requests', () => {
  it('Fill, Select (with |), Check, Press Key, with templates', async () => {
    const h = harness(
      chain(
        { id: 'v', type: 'set-variable', config: { name: 'email', value: 'a@b.co' } },
        { id: 'f', type: 'fill', config: { locator: 'label=Email', value: '{{email}}', mode: 'type' } },
        { id: 's', type: 'select-option', config: { locator: '#tags', value: 'red | blue' } },
        { id: 'k', type: 'check', config: { locator: 'label=Agree', state: 'uncheck' } },
        { id: 'p', type: 'press-key', config: { key: 'Enter' } },
      ),
    );
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(h.host.actions.map((action) => action.request)).toEqual([
      { op: 'fill', locator: 'label=Email', value: 'a@b.co', mode: 'type' },
      { op: 'select', locator: '#tags', values: ['red', 'blue'] },
      { op: 'check', locator: 'label=Agree', checked: false },
      { op: 'press', key: 'Enter' },
    ]);
  });

  it('Fill Form skips empty values, then clicks submit', async () => {
    const h = harness(
      chain({
        id: 'ff',
        type: 'fill-form',
        config: {
          fields: [
            { locator: 'label=Name', value: 'Akib' },
            { locator: 'label=Nickname', value: '' },
            { locator: '#country', value: 'Bangladesh' },
          ],
          submit: 'role=button[name="Send"]',
        },
      }),
    );
    await h.runner.runOnce();
    expect(h.host.actions.map((action) => action.request)).toEqual([
      { op: 'set-field', locator: 'label=Name', value: 'Akib' },
      { op: 'set-field', locator: '#country', value: 'Bangladesh' },
      { op: 'click', locator: 'role=button[name="Send"]', action: 'click' },
    ]);
  });

  it('Fill Form names the field that failed', async () => {
    const host = new FakeHost();
    host.agent = async (_tab, request) => {
      if (request.op === 'set-field' && request.locator === '#bad') throw new Error('Timed out after 30s: waiting for #bad: no element matches');
      return {};
    };
    const h = harness(chain({ id: 'ff', type: 'fill-form', config: { fields: [{ locator: '#ok', value: '1' }, { locator: '#bad', value: '2' }] } }), host);
    const run = await h.runner.runOnce();
    expect(run.error).toBe('Fill Form: #bad: Timed out after 30s: waiting for #bad: no element matches');
  });

  it('Fill Form rows: validation and templating', () => {
    const config = (fields: unknown) => withDefaults(fillFormBlock, { fields });
    expect(validateConfig(fillFormBlock, config([]))).toEqual(['Fields needs at least one row']);
    expect(validateConfig(fillFormBlock, config([{ locator: '', value: 'x' }]))).toEqual(['Fields: row 1 has no Field']);
    expect(validateConfig(fillFormBlock, config([{ locator: '#a', value: '' }, { locator: '', value: '' }]))).toEqual([]);
  });
});

describe('Wait For', () => {
  it('URL mode returns the URL; element mode asks the page agent', async () => {
    const h = harness(
      chain(
        { id: 'w1', type: 'wait-for', config: { mode: 'url', url: '/login' } },
        { id: 'w2', type: 'wait-for', config: { mode: 'visible', locator: 'text=Welcome' } },
        { id: 'w3', type: 'wait-for', config: { mode: 'text', text: 'Saved' } },
        { id: 'w4', type: 'wait-for', config: { mode: 'networkidle' } },
      ),
    );
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(run.steps.find((step) => step.nodeId === 'w1')?.output).toMatchObject({ url: 'https://shop.test/login' });
    expect(h.host.actions.map((action) => action.request)).toEqual([
      { op: 'wait', state: 'visible', locator: 'text=Welcome' },
      { op: 'wait', state: 'text', text: 'Saved' },
    ]);
    expect(h.host.loads.at(-1)).toEqual({ tabId: 100, until: 'networkidle' });
  });

  it('fails clearly when the URL never matches, or a needed setting is missing', async () => {
    const h = harness(chain({ id: 'w', type: 'wait-for', config: { mode: 'url', url: '/welcome' } }));
    expect((await h.runner.runOnce()).error).toContain('waiting for the URL to match /welcome');
    const h2 = harness(chain({ id: 'w', type: 'wait-for', config: { mode: 'visible' } }));
    expect((await h2.runner.runOnce()).error).toBe('Wait For: Element is required for "visible"');
  });
});

describe('Read Element on the run\'s tab, Navigate, Close Tab', () => {
  it('reads from the tab without reloading, and passes the value on', async () => {
    const host = new FakeHost();
    host.agent = async () => ({ text: '  Order #42 placed  ', count: 1 });
    const h = harness(
      chain(
        { id: 'r', type: 'read-element', config: { selector: '.status', url: '' } },
        { id: 'i', type: 'if', config: { left: '{{value}}', operator: 'matches', right: '/order #\\d+/i' } },
      ),
      host,
    );
    const run = await h.runner.runOnce();
    expect(host.reads).toHaveLength(0);
    expect(host.actions[0]?.request).toEqual({ op: 'read', locator: '.status', kind: 'text', name: '' });
    expect(run.steps.find((step) => step.nodeId === 'r')?.output).toMatchObject({ value: 'Order #42 placed', url: 'https://shop.test/login' });
    expect(run.steps.find((step) => step.nodeId === 'i')?.port).toBe('true');
  });

  it('navigates and closes', async () => {
    const h = harness(
      chain(
        { id: 'n', type: 'navigate', config: { action: 'goto', url: 'https://shop.test/cart' } },
        { id: 'x', type: 'close-tab' },
        { id: 'c', type: 'click', config: { locator: '#gone' } },
      ),
    );
    const run = await h.runner.runOnce();
    expect(run.steps.find((step) => step.nodeId === 'n')?.output).toMatchObject({ url: 'https://shop.test/cart' });
    expect(h.host.tabUrls.size).toBe(0);
    expect(run.error).toContain('No tab named "main"');
  });
});

describe('urlMatches', () => {
  it('substring, glob, regex', () => {
    expect(urlMatches('https://a.test/welcome?x=1', '/welcome')).toBe(true);
    expect(urlMatches('https://a.test/order/42', 'https://a.test/order/*')).toBe(true);
    expect(urlMatches('https://a.test/order/42/items', 'https://a.test/order/*')).toBe(false);
    expect(urlMatches('https://a.test/order/42/items', 'https://a.test/**')).toBe(true);
    expect(urlMatches('https://a.test/order/42', '/\\/order\\/\\d+$/')).toBe(true);
    expect(() => urlMatches('x', '/(/')).toThrow('Invalid URL pattern');
  });
});

describe('regex or plain text', () => {
  it('only real regex flags make /…/ a regex', () => {
    expect(urlMatches('https://shop.test/api/cart?x', '/api/cart')).toBe(true);
    expect(urlMatches('https://shop.test/WELCOME', '/welcome/i')).toBe(true);
  });
});
