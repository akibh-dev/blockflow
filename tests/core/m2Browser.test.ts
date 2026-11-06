import { describe, expect, it } from 'vitest';
import { cookiesStorageBlock, screenshotBlock, waitForBlock, waitForDownloadBlock } from '../../src/core/blocks';
import { withDefaults } from '../../src/core/config';
import { FakeHost, flow, harness } from '../helpers/fakeHost';

type Node = { id: string; type: string; config?: Record<string, unknown>; step?: Record<string, unknown> };

/** Open Tab "main" on https://shop.test/account, then the given blocks in a line. */
const chain = (...nodes: Node[]) => {
  const all: Node[] = [{ id: 'open', type: 'open-url', config: { url: 'https://shop.test/account' } }, ...nodes];
  return flow(all, all.slice(1).map((node, index) => [all[index]!.id, node.id] as [string, string]));
};
const stepOf = (run: { steps: { nodeId: string }[] }, id: string) => run.steps.find((step) => step.nodeId === id) as Record<string, unknown> | undefined;

describe('Wait for Download', () => {
  const csv = { downloadId: 7, url: 'https://shop.test/export.csv', filename: 'export.csv', path: '/dl/export.csv', size: 20, mime: 'text/csv' };

  it('reports the download', async () => {
    const host = new FakeHost();
    host.pageDownloads.push({ ...csv, url: 'https://cdn.test/x.pdf', filename: 'x.pdf', downloadId: 6 }, csv);
    const h = harness(chain({ id: 'c', type: 'click', config: { locator: 'text=Export' } }, { id: 'w', type: 'wait-for-download', config: { url: 'export.csv' } }), host);
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(stepOf(run, 'w')?.output).toMatchObject({ download: csv });
    expect(host.downloadReads).toEqual([]);
  });

  it('reads CSV into rows and saves them to a dataset; JSON and text too', async () => {
    const host = new FakeHost();
    host.pageDownloads.push({ ...csv, content: 'name,qty\nmug,2\ncup,3\n' });
    const h = harness(chain({ id: 'w', type: 'wait-for-download', config: { read: 'csv', dataset: 'exports' } }), host);
    const run = await h.runner.runOnce();
    expect(stepOf(run, 'w')?.output).toMatchObject({ rows: [{ name: 'mug', qty: '2' }, { name: 'cup', qty: '3' }], datasetSize: 2 });
    expect(host.datasetRows.get('exports')).toHaveLength(2);
    expect(host.downloadReads).toEqual([{ downloadId: 7, tabId: 100 }]);

    host.pageDownloads.push({ ...csv, downloadId: 8, filename: 'a.json', content: '{"ok":true}' }, { ...csv, downloadId: 9, filename: 'b.txt', content: 'hello' });
    const h2 = harness(chain({ id: 'j', type: 'wait-for-download', config: { url: 'a.json', read: 'json' } }, { id: 't', type: 'wait-for-download', config: { read: 'text' } }), host);
    const run2 = await h2.runner.runOnce();
    expect(stepOf(run2, 'j')?.output).toMatchObject({ data: { ok: true } });
    expect(stepOf(run2, 't')?.output).toMatchObject({ content: 'hello' });
  });

  it('bad JSON is a download.failed error; no download times out', async () => {
    const host = new FakeHost();
    host.pageDownloads.push({ ...csv, content: 'not json' });
    const run = await harness(chain({ id: 'j', type: 'wait-for-download', config: { read: 'json' } }), host).runner.runOnce();
    expect(stepOf(run, 'j')).toMatchObject({ status: 'failed', code: 'download.failed' });
    const none = await harness(chain({ id: 'w', type: 'wait-for-download', config: {} })).runner.runOnce();
    expect(none.status).toBe('failed');
  });

  it('a dataset needs CSV or JSON reading', () => {
    expect(waitForDownloadBlock.validate?.(withDefaults(waitForDownloadBlock, { dataset: 'x' }) as never)).toEqual([expect.objectContaining({ key: 'dataset' })]);
    expect(waitForDownloadBlock.validate?.(withDefaults(waitForDownloadBlock, { dataset: 'x', read: 'csv' }) as never)).toEqual([]);
  });
});

describe('Screenshot', () => {
  it('takes the area asked for and shows it on the step', async () => {
    const host = new FakeHost();
    const h = harness(
      chain(
        { id: 'v', type: 'screenshot', config: {} },
        { id: 'f', type: 'screenshot', config: { area: 'full', format: 'jpeg', quality: 50 } },
        { id: 'e', type: 'screenshot', config: { area: 'element', locator: '#card' } },
        { id: 'l', type: 'log', config: { message: 'done' } },
      ),
      host,
    );
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(host.screenshotRequests.map(({ options }) => [options.area, options.format, options.locator])).toEqual([
      ['visible', 'png', undefined],
      ['full', 'jpeg', undefined],
      ['element', 'png', '#card'],
    ]);
    expect(host.screenshotRequests[1]?.options.quality).toBe(50);
    expect(stepOf(run, 'f')).toMatchObject({ screenshot: 'block-shot-2', output: { screenshotId: 'block-shot-2', screenshot: { width: 800, height: 2400, area: 'full' } } });
    // A later block passes the id on but does not claim the picture.
    expect(stepOf(run, 'l')?.screenshot).toBeUndefined();
    // The step setting does not take a second picture of a Screenshot step.
    expect(host.screenshotsTaken).toEqual([]);
  });

  it('an element screenshot needs the element; full and element ask for the debugger permission', () => {
    expect(screenshotBlock.validate?.(withDefaults(screenshotBlock, { area: 'element' }) as never)).toEqual([expect.objectContaining({ key: 'locator' })]);
    const permissions = screenshotBlock.permissions as (config: object) => string[];
    expect(permissions(withDefaults(screenshotBlock, {}))).toEqual([]);
    expect(permissions(withDefaults(screenshotBlock, { area: 'full' }))).toEqual(['debugger']);
  });
});

describe('Cookies & Storage', () => {
  it('sets, gets, deletes and clears cookies of the tab\'s site', async () => {
    const host = new FakeHost();
    const h = harness(
      chain(
        { id: 's1', type: 'cookies-storage', config: { action: 'set', name: 'session', value: 'abc', maxAgeSeconds: 60, httpOnly: true, sameSite: 'Lax' } },
        { id: 's2', type: 'cookies-storage', config: { action: 'set', name: 'theme', value: '{{ "dark" }}' } },
        { id: 'g1', type: 'cookies-storage', config: { action: 'get', name: 'session' } },
        { id: 'g2', type: 'cookies-storage', config: {} },
        { id: 'd', type: 'cookies-storage', config: { action: 'delete', name: 'theme' } },
        { id: 'c', type: 'cookies-storage', config: { action: 'clear' } },
        { id: 'g3', type: 'cookies-storage', config: { url: 'https://shop.test/' } },
      ),
      host,
    );
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(stepOf(run, 's1')?.output).toMatchObject({ value: 'abc', cookies: [{ name: 'session', httpOnly: true, sameSite: 'Lax', expires: Date.parse('2026-01-01T00:00:00Z') / 1000 + 60 }] });
    expect(stepOf(run, 'g1')?.output).toMatchObject({ value: 'abc' });
    expect(stepOf(run, 'g2')?.output).toMatchObject({ value: { session: 'abc', theme: 'dark' } });
    expect(stepOf(run, 'd')?.output).toMatchObject({ deleted: 1 });
    expect(stepOf(run, 'c')?.output).toMatchObject({ deleted: 1 });
    expect(stepOf(run, 'g3')?.output).toMatchObject({ value: {} });
  });

  it('local and session storage go through the page agent', async () => {
    const host = new FakeHost();
    host.agent = async (_tab, request) => (request.op === 'storage' && request.action === 'clear' ? { cleared: 3 } : { value: 'v', deleted: 1 });
    const h = harness(
      chain(
        { id: 'a', type: 'cookies-storage', config: { area: 'local', action: 'set', name: 'k', value: 'v' } },
        { id: 'b', type: 'cookies-storage', config: { area: 'session', action: 'clear' } },
        { id: 'c', type: 'cookies-storage', config: { area: 'local', action: 'delete', name: 'k' } },
      ),
      host,
    );
    const run = await h.runner.runOnce();
    expect(host.actions.map((action) => action.request)).toEqual([
      { op: 'storage', area: 'local', action: 'set', key: 'k', value: 'v' },
      { op: 'storage', area: 'session', action: 'clear' },
      { op: 'storage', area: 'local', action: 'delete', key: 'k' },
    ]);
    expect(stepOf(run, 'b')?.output).toMatchObject({ deleted: 3 });
    expect(stepOf(run, 'c')?.output).toMatchObject({ deleted: 1 });
  });

  it('set and delete need a name; only cookies ask for the cookies permission', () => {
    expect(cookiesStorageBlock.validate?.(withDefaults(cookiesStorageBlock, { action: 'set' }) as never)).toEqual([expect.objectContaining({ key: 'name' })]);
    const permissions = cookiesStorageBlock.permissions as (config: object) => string[];
    expect(permissions(withDefaults(cookiesStorageBlock, {}))).toEqual(['cookies']);
    expect(permissions(withDefaults(cookiesStorageBlock, { area: 'local' }))).toEqual([]);
  });
});

describe('Wait For request, and response with method and body', () => {
  it('waits for a request by method and URL', async () => {
    const host = new FakeHost();
    host.sentRequests.push({ tabId: 100, url: 'https://shop.test/api/save', method: 'GET' }, { tabId: 100, url: 'https://shop.test/api/save', method: 'POST', postData: '{"a":1}' });
    const run = await harness(chain({ id: 'w', type: 'wait-for', config: { mode: 'request', url: '/api/save', method: 'post' } }), host).runner.runOnce();
    expect(stepOf(run, 'w')?.output).toMatchObject({ request: { url: 'https://shop.test/api/save', method: 'POST', postData: '{"a":1}' } });
  });

  it('passes method and captureBody to the host', async () => {
    const host = new FakeHost();
    host.responses.push({ tabId: 100, url: 'https://shop.test/api/slow', status: 200, method: 'GET', body: '{"order":1}' });
    const run = await harness(chain({ id: 'w', type: 'wait-for', config: { mode: 'response', url: '/api/slow', method: 'GET', captureBody: true } }), host).runner.runOnce();
    expect(host.responseOptions).toEqual([{ method: 'GET', captureBody: true }]);
    expect(stepOf(run, 'w')?.output).toMatchObject({ response: { status: 200, body: '{"order":1}' } });
  });

  it('request mode needs a URL; captureBody asks for the debugger', () => {
    expect(waitForBlock.validate?.(withDefaults(waitForBlock, { mode: 'request' }) as never)).toEqual([expect.objectContaining({ key: 'url' })]);
    const permissions = waitForBlock.permissions as (config: object) => string[];
    expect(permissions(withDefaults(waitForBlock, { mode: 'response', captureBody: true }))).toEqual(['debugger']);
    expect(permissions(withDefaults(waitForBlock, { mode: 'response' }))).toEqual([]);
  });
});
