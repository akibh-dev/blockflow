import { describe, expect, it } from 'vitest';
import { FakeHost, flow, harness } from '../helpers/fakeHost';

type Node = { id: string; type: string; config?: Record<string, unknown>; step?: Record<string, unknown> };
const line = (...nodes: Node[]) => flow(nodes, nodes.slice(1).map((node, index) => [nodes[index]!.id, node.id] as [string, string]));
const products = [
  { title: 'Kettle', price: '$25' },
  { title: 'Toaster', price: '$40' },
  { title: 'Mug', price: '$5' },
];
/** What the page agent sends back for `products`. */
const scraped = { columns: ['title', 'price'], values: products.map((p) => [p.title, p.price]), count: 3 };

describe('Extract List / Table', () => {
  it('from the run\'s tab: sends fields, names the list', async () => {
    const host = new FakeHost();
    host.agent = async () => scraped;
    const h = harness(
      line(
        { id: 'open', type: 'open-url', config: { url: 'https://shop.test' } },
        { id: 'x', type: 'extract-list', config: { locator: '.card', fields: [{ name: 'title', locator: 'h2', attribute: '' }, { name: '', locator: '', attribute: '' }], into: 'products', limit: 2 } },
      ),
      host,
    );
    const run = await h.runner.runOnce();
    expect(host.actions[0]?.request).toEqual({ op: 'extract', locator: '.card', fields: [{ name: 'title', locator: 'h2', attribute: '' }], limit: 2 });
    expect(run.steps[1]?.output).toMatchObject({ products, count: 3 });
  });

  it('from HTML in the data, no tab needed', async () => {
    const host = new FakeHost();
    host.httpHandler = async () => ({ status: 200, ok: true, body: '<table>…</table>' });
    host.htmlAgent = async (html, base, request) => ({ columns: ['html', 'base', 'op'], values: [[html, base, request.op]] });
    const h = harness(
      line(
        { id: 'h', type: 'http-request', config: { url: 'https://shop.test/list' } },
        { id: 't', type: 'extract-table', config: { source: 'html', baseUrl: '{{url}}' } },
      ),
      host,
    );
    const run = await h.runner.runOnce();
    expect(run.steps[1]?.output).toMatchObject({ rows: [{ html: '<table>…</table>', base: 'https://shop.test/list', op: 'table' }], count: 1 });
  });
});

describe('For Each, Repeat, Filter, Transform, Data Table', () => {
  it('For Each runs "each" per item, then "done"', async () => {
    const h = harness(
      flow(
        [
          { id: 'd', type: 'data-table', config: { text: 'email\na@x.co\nb@x.co' } },
          { id: 'each', type: 'for-each', config: { list: 'rows', as: 'user' } },
          { id: 'log', type: 'log', config: { message: '{{index}}:{{user.email}}/{{total}}' } },
          { id: 'end', type: 'log', config: { message: 'done {{count}}' } },
        ],
        [['d', 'each'], ['each', 'log', 'each'], ['each', 'end', 'done']],
      ),
    );
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(h.messages('info').filter((m) => /^\d:|^done/.test(m))).toEqual(['0:a@x.co/2', '1:b@x.co/2', 'done 2']);
  });

  it('For Each explains a missing or wrong list', async () => {
    const h = harness(flow([{ id: 'e', type: 'for-each', config: { list: 'nope' } }], []));
    expect((await h.runner.runOnce()).error).toBe('For Each: List: "nope" is not in the data');
  });

  it('Repeat', async () => {
    const h = harness(flow([{ id: 'r', type: 'repeat', config: { times: 3 } }, { id: 'l', type: 'log', config: { message: '#{{iteration}}' } }], [['r', 'l', 'each']]));
    await h.runner.runOnce();
    expect(h.messages('info').filter((m) => m.startsWith('#'))).toEqual(['#1', '#2', '#3']);
  });

  it('Filter with per-item templates, Transform with typed expressions', async () => {
    const host = new FakeHost();
    host.agent = async () => scraped;
    const h = harness(
      line(
        { id: 'open', type: 'open-url', config: { url: 'https://shop.test' } },
        { id: 'x', type: 'extract-list', config: { locator: '.card' } },
        { id: 'f', type: 'filter', config: { list: 'items', left: '{{item.price}}', operator: 'less', right: '30', into: 'cheap' } },
        {
          id: 't',
          type: 'transform',
          config: {
            values: [
              { name: 'total', expression: "sum(pluck(cheap, 'price'))" },
              { name: 'label', expression: "join(pluck(cheap, 'title'), ' + ') + ' = $' + total" },
            ],
          },
        },
      ),
      host,
    );
    const run = await h.runner.runOnce();
    expect(run.steps.find((s) => s.nodeId === 'f')?.output).toMatchObject({ cheap: [products[0], products[2]], count: 2 });
    expect(run.steps.find((s) => s.nodeId === 't')?.output).toMatchObject({ total: 30, label: 'Kettle + Mug = $30' });
  });

  it('now() and today() use the host clock in settings, Transform and Filter (per item)', async () => {
    const host = new FakeHost();
    host.advance(36 * 3600 * 1000); // 2026-01-02T12:00:00Z
    const h = harness(
      line(
        { id: 'd', type: 'data-table', config: { text: 'day\n2026-01-01\n2026-01-02\n2026-01-03', into: 'days' } },
        { id: 'f', type: 'filter', config: { list: 'days', left: '{{item.day}}', operator: 'equals', right: '{{ today() }}', into: 'todays' } },
        { id: 't', type: 'transform', config: { values: [{ name: 'stamp', expression: 'now()' }] } },
        { id: 'l', type: 'log', config: { message: 'on {{ today() }}' } },
      ),
      host,
    );
    const run = await h.runner.runOnce();
    expect(run.steps.find((s) => s.nodeId === 'f')?.output).toMatchObject({ todays: [{ day: '2026-01-02' }], count: 1 });
    expect(run.steps.find((s) => s.nodeId === 't')?.output).toMatchObject({ stamp: '2026-01-02T12:00:00.000Z' });
    expect(h.messages('info')).toContain('on 2026-01-02');
  });

  it('Data Table reads JSON too', async () => {
    const h = harness(flow([{ id: 'd', type: 'data-table', config: { text: '[{"a":1},{"a":2}]', into: 'list' } }], []));
    expect((await h.runner.runOnce()).steps[0]?.output).toEqual({ list: [{ a: 1 }, { a: 2 }], count: 2 });
  });
});

describe('Paginate', () => {
  it('runs each page, clicks Next until it is disabled', async () => {
    const host = new FakeHost();
    let page = 1;
    host.agent = async (_tab, request) => {
      if (request.op === 'read') return { text: String(page < 3) };
      if (request.op === 'click') page += 1;
      return {};
    };
    const h = harness(
      flow(
        [
          { id: 'open', type: 'open-url', config: { url: 'https://shop.test' } },
          { id: 'p', type: 'paginate', config: { locator: 'text=Next', maxPages: 10 } },
          { id: 'l', type: 'log', config: { message: 'page {{page}}' } },
          { id: 'end', type: 'log', config: { message: '{{pages}} pages' } },
        ],
        [['open', 'p'], ['p', 'l', 'each'], ['p', 'end', 'done']],
      ),
      host,
    );
    await h.runner.runOnce();
    expect(h.messages('info').filter((m) => /^page \d$|^\d pages$/.test(m))).toEqual(['page 1', 'page 2', 'page 3', '3 pages']);
    expect(host.loads.filter((load) => load.until === 'networkidle')).toHaveLength(2);
  });
});

describe('Datasets and downloads', () => {
  it('appends, replaces, and downloads as CSV / JSON', async () => {
    const host = new FakeHost();
    const save = (mode: string) =>
      line(
        { id: 'd', type: 'data-table', config: { text: 'name,price\nA,1\nB,2' } },
        { id: 's', type: 'save-dataset', config: { dataset: 'prices', value: 'rows', mode } },
      );
    await harness(save('append'), host).runner.runOnce();
    const second = await harness(save('append'), host).runner.runOnce();
    expect(second.steps[1]?.output).toMatchObject({ datasetSize: 4 });
    await harness(save('replace'), host).runner.runOnce();
    expect(host.datasetRows.get('prices')).toHaveLength(2);

    await harness(flow([{ id: 'dl', type: 'download', config: { from: 'dataset', dataset: 'prices', format: 'csv', filename: 'p.csv' } }], []), host).runner.runOnce();
    expect(host.downloaded[0]).toEqual({ filename: 'p.csv', content: 'name,price\nA,1\nB,2\n', mime: 'text/csv' });
  });
});
