import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../src/core/blocks';
import { textToBase64 } from '../../src/core/blocks/uploadFile';
import { FakeHost, flow, harness } from '../helpers/fakeHost';

type Node = { id: string; type: string; config?: Record<string, unknown>; step?: Record<string, unknown> };
const chain = (...nodes: Node[]) => {
  const all: Node[] = [{ id: 'open', type: 'open-url', config: { url: 'https://shop.test/' } }, ...nodes];
  return flow(all, all.slice(1).map((node, index) => [all[index]!.id, node.id] as [string, string]));
};

describe('Upload File', () => {
  it('sends text as a UTF-8 file, or a file from a URL', async () => {
    const h = harness(
      chain(
        { id: 'u1', type: 'upload-file', config: { locator: '#cv', content: 'naïve,café', filename: 'a.csv', mime: 'text/csv' } },
        { id: 'u2', type: 'upload-file', config: { locator: '#photo', source: 'url', url: 'https://cdn.test/me.png', filename: '' } },
      ),
    );
    expect((await h.runner.runOnce()).status).toBe('passed');
    expect(h.host.actions.map((action) => action.request)).toEqual([
      { op: 'upload', locator: '#cv', files: [{ name: 'a.csv', type: 'text/csv', base64: textToBase64('naïve,café') }] },
      { op: 'upload', locator: '#photo', files: [{ name: 'me.png', type: 'image/png', base64: btoa('file at https://cdn.test/me.png') }] },
    ]);
    expect(new TextDecoder().decode(Uint8Array.from(atob(textToBase64('naïve')), (c) => c.charCodeAt(0)))).toBe('naïve');
  });
});

describe('Wait for Popup, Dialogs, Run Script, Wait For response', () => {
  it('names the popup tab for the next blocks', async () => {
    const host = new FakeHost();
    host.popups.push({ openerTabId: 100, tabId: 555, url: 'https://auth.test/login' });
    const h = harness(
      chain(
        { id: 'c', type: 'click', config: { locator: 'text=Sign in with Auth' } },
        { id: 'p', type: 'wait-for-popup', config: { name: 'auth' } },
        { id: 'f', type: 'fill', config: { locator: 'label=Email', value: 'x', tab: 'auth' } },
      ),
      host,
    );
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(run.steps.find((s) => s.nodeId === 'p')?.output).toMatchObject({ popupUrl: 'https://auth.test/login', popupTabId: 555 });
    expect(host.actions.at(-1)?.tabId).toBe(555);
  });

  it('sets dialog answers and reads them back', async () => {
    const host = new FakeHost();
    host.shownDialogs = [{ type: 'confirm', message: 'Delete it?' }];
    const h = harness(chain({ id: 'd', type: 'dialogs', config: { action: 'dismiss' } }, { id: 'r', type: 'dialogs', config: { action: 'read' } }), host);
    const run = await h.runner.runOnce();
    expect(host.dialogSettings.map((setting) => setting.options)).toEqual([{ mode: 'dismiss', text: '' }, { read: true }]);
    expect(run.steps.find((s) => s.nodeId === 'r')?.output).toMatchObject({ lastDialog: 'Delete it?' });
  });

  it('runs a script with the data and saves its result', async () => {
    const host = new FakeHost();
    host.scriptResult = 42;
    const h = harness(chain({ id: 's', type: 'run-script', config: { code: 'return 6 * 7', into: 'answer' } }), host);
    const run = await h.runner.runOnce();
    expect(run.steps.at(-1)?.output).toMatchObject({ answer: 42 });
    expect(host.scripts[0]).toMatchObject({ tabId: 100, code: 'return 6 * 7', data: { url: 'https://shop.test/' } });
  });

  it('waits for an API response by URL and status', async () => {
    const host = new FakeHost();
    host.responses.push({ tabId: 100, url: 'https://shop.test/api/cart', status: 201 });
    const h = harness(chain({ id: 'w', type: 'wait-for', config: { mode: 'response', url: '/api/cart', status: '201' } }), host);
    const run = await h.runner.runOnce();
    expect(run.error).toBeUndefined();
    expect(run.steps.at(-1)?.output).toMatchObject({ response: { url: 'https://shop.test/api/cart', status: 201 } });
  });

  it('passes the real-input step setting to page actions', async () => {
    const h = harness(chain({ id: 'c', type: 'click', config: { locator: '#a' }, step: { realInput: true } }, { id: 'd', type: 'click', config: { locator: '#b' } }));
    await h.runner.runOnce();
    expect(h.host.realInputs).toEqual([true, false]);
  });

  it('only blocks that send actions to the page offer the real-input setting', () => {
    const offered = createDefaultRegistry()
      .list()
      .filter((def) => def.realInput)
      .map((def) => def.type)
      .sort();
    expect(offered).toEqual(['check', 'click', 'drag', 'fill', 'fill-form', 'paginate', 'press-key', 'select-option']);
  });
});
