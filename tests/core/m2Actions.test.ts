import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../src/core/blocks';
import { clickBlock } from '../../src/core/blocks/click';
import { parseModifiers, parsePosition } from '../../src/core/blocks/pageCommon';
import { decodeFileData, textToBase64 } from '../../src/core/blocks/uploadFile';
import { checkFile } from '../../src/core/check';
import { workflowToPlaywright } from '../../src/core/playwright';
import { FakeHost, flow, harness } from '../helpers/fakeHost';

type Node = { id: string; type: string; config?: Record<string, unknown>; step?: Record<string, unknown> };
const registry = createDefaultRegistry();
const chain = (...nodes: Node[]) => {
  const all: Node[] = [{ id: 'open', type: 'open-url', config: { url: 'https://shop.test/' } }, ...nodes];
  return flow(all, all.slice(1).map((node, index) => [all[index]!.id, node.id] as [string, string]));
};
/** The agent requests a chain of blocks sends. */
async function requests(...nodes: Node[]) {
  const h = harness(chain(...nodes));
  const run = await h.runner.runOnce();
  return { run, requests: h.host.actions.map((action) => action.request), host: h.host };
}
const problems = (node: Node) => checkFile({ name: 'x', nodes: [{ ...node, position: { x: 0, y: 0 } }], edges: [] }, registry).filter((issue) => issue.level === 'error');

describe('Click options', () => {
  it('old configs send the same request as before', async () => {
    const { requests: sent } = await requests(
      { id: 'a', type: 'click', config: { locator: '#a' } },
      { id: 'b', type: 'click', config: { locator: '#b', action: 'double', force: true } },
      { id: 'c', type: 'click', config: { locator: '#c', action: 'right' } },
    );
    expect(sent).toEqual([
      { op: 'click', locator: '#a', action: 'click', force: false },
      { op: 'click', locator: '#b', action: 'double', force: true },
      { op: 'click', locator: '#c', action: 'right', force: false },
    ]);
  });

  it('passes button, modifiers, position and click count', async () => {
    const { requests: sent } = await requests(
      { id: 'a', type: 'click', config: { locator: '#a', button: 'middle', modifiers: 'ctrl + shift', position: '10, 5', clickCount: 3 } },
      { id: 'h', type: 'click', config: { locator: '#h', action: 'hover', button: 'right', clickCount: 2, modifiers: 'Alt' } },
      { id: 'r', type: 'click', config: { locator: '#r', action: 'right', button: 'right' } },
    );
    expect(sent).toEqual([
      { op: 'click', locator: '#a', action: 'click', force: false, button: 'middle', modifiers: ['Control', 'Shift'], position: { x: 10, y: 5 }, clickCount: 3 },
      { op: 'click', locator: '#h', action: 'hover', force: false, modifiers: ['Alt'] },
      { op: 'click', locator: '#r', action: 'right', force: false },
    ]);
  });

  it('validates modifiers, position and conflicting button', () => {
    expect(parseModifiers('Meta+cmd, Option')).toEqual({ modifiers: ['Meta', 'Alt'], unknown: [] });
    expect(parsePosition('3 4')).toEqual({ x: 3, y: 4 });
    expect(parsePosition('top')).toBeNull();
    expect(problems({ id: 'c', type: 'click', config: { locator: '#a', modifiers: 'Hyper', position: 'left' } }).map((issue) => issue.code)).toEqual(['config.value', 'config.value']);
    expect(problems({ id: 'c', type: 'click', config: { locator: '#a', action: 'right', button: 'middle' } })).toMatchObject([{ code: 'config.value', path: '/nodes/0/config/button' }]);
    expect(problems({ id: 'c', type: 'click', config: { locator: '#a', clickCount: 3, button: 'right', modifiers: 'Shift' } })).toEqual([]);
    expect(clickBlock.summary?.({ ...clickBlock.defaultConfig, locator: '#a', modifiers: 'shift', button: 'middle' })).toBe('Shift middle-click: #a');
  });
});

describe('Element Action', () => {
  it('sends focus, blur, clear, scroll and dispatch requests', async () => {
    const { requests: sent, run } = await requests(
      { id: 'f', type: 'element-action', config: { locator: '#a' } },
      { id: 'b', type: 'element-action', config: { locator: '#a', action: 'blur' } },
      { id: 'c', type: 'element-action', config: { locator: '#a', action: 'clear' } },
      { id: 's', type: 'element-action', config: { locator: '#a', action: 'scroll-into-view' } },
      { id: 'd', type: 'element-action', config: { locator: '#a', action: 'dispatch-event', eventType: 'my-event', detail: '{"n": 1}' } },
      { id: 'k', type: 'element-action', config: { locator: '#a', action: 'dispatch-event', eventType: 'keydown' } },
    );
    expect(run.status).toBe('passed');
    expect(sent).toEqual([
      { op: 'focus', locator: '#a' },
      { op: 'blur', locator: '#a' },
      { op: 'clear', locator: '#a' },
      { op: 'scroll', to: 'element', locator: '#a' },
      { op: 'dispatch', locator: '#a', eventType: 'my-event', detail: { n: 1 } },
      { op: 'dispatch', locator: '#a', eventType: 'keydown' },
    ]);
    expect(run.steps.find((step) => step.nodeId === 'd')?.output).toMatchObject({ defaultPrevented: false });
  });

  it('requires an event type and JSON detail', () => {
    expect(problems({ id: 'e', type: 'element-action', config: { locator: '#a', action: 'dispatch-event', detail: '{bad' } }).map((issue) => issue.code)).toEqual([
      'config.required',
      'config.value',
    ]);
    expect(problems({ id: 'e', type: 'element-action', config: { locator: '#a', action: 'dispatch-event', eventType: 'x', detail: '{"v": "{{value}}"}' } })).toEqual([]);
  });
});

describe('Drag', () => {
  it('sends one drag request with positions and modifiers, and reports the mode', async () => {
    const h = harness(chain({ id: 'd', type: 'drag', config: { from: '#card', to: '#done', fromPosition: '5,5', toPosition: '0, 20', modifiers: 'Alt' } }));
    h.host.agent = async () => ({ mode: 'html5', dropped: true });
    const run = await h.runner.runOnce();
    expect(h.host.actions.map((action) => action.request)).toEqual([
      { op: 'drag', locator: '#card', to: '#done', fromPosition: { x: 5, y: 5 }, toPosition: { x: 0, y: 20 }, modifiers: ['Alt'] },
    ]);
    expect(run.steps.at(-1)?.output).toMatchObject({ dragMode: 'html5' });
  });

  it('needs both elements and valid positions', () => {
    expect(problems({ id: 'd', type: 'drag', config: { from: '#a', fromPosition: 'x' } }).map((issue) => [issue.code, issue.path])).toEqual([
      ['config.required', '/nodes/0/config/to'],
      ['config.value', '/nodes/0/config/fromPosition'],
    ]);
  });
});

describe('Upload File: drop zones and data', () => {
  it('drops on a drop zone, and takes base64 or a data: URL', async () => {
    const { requests: sent } = await requests(
      { id: 'z', type: 'upload-file', config: { locator: '#zone', target: 'dropzone', content: 'a,b', filename: 'a.csv', mime: 'text/csv' } },
      { id: 'd', type: 'upload-file', config: { locator: '#cv', source: 'data', data: 'data:image/png;base64,iVBORw0K', filename: 'p.png' } },
      { id: 'b', type: 'upload-file', config: { locator: '#cv', source: 'data', data: ' aGVs\nbG8 ', filename: 'h.txt', mime: 'text/plain' } },
    );
    expect(sent).toEqual([
      { op: 'upload', locator: '#zone', files: [{ name: 'a.csv', type: 'text/csv', base64: textToBase64('a,b') }], dropzone: true },
      { op: 'upload', locator: '#cv', files: [{ name: 'p.png', type: 'image/png', base64: 'iVBORw0K' }] },
      { op: 'upload', locator: '#cv', files: [{ name: 'h.txt', type: 'text/plain', base64: 'aGVsbG8=' }] },
    ]);
  });

  it('decodes data, and refuses what is not base64', () => {
    expect(decodeFileData('data:,a%20b')).toEqual({ base64: textToBase64('a b'), mime: 'text/plain' });
    expect(decodeFileData('aGk_-w')).toEqual({ base64: 'aGk/+w==' });
    expect(() => decodeFileData('not base64!')).toThrow(/not base64/);
    expect(problems({ id: 'u', type: 'upload-file', config: { source: 'data' } })).toMatchObject([{ code: 'config.required', path: '/nodes/0/config/data' }]);
  });

  it('HTTP Request as base64 feeds Upload File', async () => {
    const host = new FakeHost();
    host.httpHandler = async (options) => ({ status: 200, ok: true, body: '', ...(options.responseType === 'base64' ? { base64: 'JVBERg==', mime: 'application/pdf' } : {}) });
    const h = harness(
      chain(
        { id: 'h', type: 'http-request', config: { url: 'https://files.test/a.pdf', responseType: 'base64' } },
        { id: 'u', type: 'upload-file', config: { locator: '#cv', source: 'data', data: '{{body64}}', filename: 'a.pdf', mime: '{{mime}}' } },
      ),
      host,
    );
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(host.requests[0]).toMatchObject({ responseType: 'base64' });
    expect(run.steps.find((step) => step.nodeId === 'h')?.output).toMatchObject({ body: '', body64: 'JVBERg==', mime: 'application/pdf' });
    expect(h.host.actions.at(-1)?.request).toEqual({ op: 'upload', locator: '#cv', files: [{ name: 'a.pdf', type: 'application/pdf', base64: 'JVBERg==' }] });
  });
});

describe('Playwright export', () => {
  const body = (nodes: Node[]) => {
    const spec = workflowToPlaywright(flow(nodes, nodes.slice(1).map((node, index) => [nodes[index]!.id, node.id] as [string, string])), { registry });
    const marker = '  let data: any = {};\n';
    const start = spec.indexOf(marker) + marker.length;
    return spec
      .slice(start, spec.indexOf('\n});\n', start))
      .split('\n')
      .map((line) => line.trim())
      .join('\n');
  };

  it('click options', () => {
    expect(body([{ id: 'c', type: 'click', config: { locator: '#x', button: 'middle', modifiers: 'Shift', position: '1,2', clickCount: 3 } }])).toBe(
      `await tabs["main"].locator("#x").click({ button: 'middle', modifiers: ["Shift"], position: { x: 1, y: 2 }, clickCount: 3 });`,
    );
    expect(body([{ id: 'c', type: 'click', config: { locator: '#x', action: 'double', modifiers: 'Meta' } }])).toBe('await tabs["main"].locator("#x").dblclick({ modifiers: ["Meta"] });');
    expect(body([{ id: 'c', type: 'click', config: { locator: '#x', action: 'right' } }])).toBe(`await tabs["main"].locator("#x").click({ button: 'right' });`);
    expect(body([{ id: 'c', type: 'click', config: { locator: '#x', action: 'hover', button: 'right' } }])).toBe('await tabs["main"].locator("#x").hover();');
  });

  it('element actions, drag, drop zones and data uploads', () => {
    const loc = 'tabs["main"].locator("#x")';
    expect(body([{ id: 'e', type: 'element-action', config: { locator: '#x', action: 'focus' } }])).toBe(`await ${loc}.focus();`);
    expect(body([{ id: 'e', type: 'element-action', config: { locator: '#x', action: 'blur' } }])).toBe(`await ${loc}.blur();`);
    expect(body([{ id: 'e', type: 'element-action', config: { locator: '#x', action: 'clear' } }])).toBe(`await ${loc}.clear();`);
    expect(body([{ id: 'e', type: 'element-action', config: { locator: '#x', action: 'scroll-into-view' } }])).toBe(`await ${loc}.scrollIntoViewIfNeeded();`);
    expect(body([{ id: 'e', type: 'element-action', config: { locator: '#x', action: 'dispatch-event', eventType: 'my-event', detail: '{"a":1}' } }])).toBe(
      `data = { ...data, defaultPrevented: await dispatchEvent(${loc}, "my-event", JSON.parse("{\\"a\\":1}")) };`,
    );
    expect(body([{ id: 'd', type: 'drag', config: { from: '#x', to: '#y', toPosition: '0,5' } }])).toBe(
      `await ${loc}.dragTo(tabs["main"].locator("#y"), { targetPosition: { x: 0, y: 5 } });\ndata = { ...data, dragMode: 'pointer' };`,
    );
    expect(body([{ id: 'u', type: 'upload-file', config: { locator: '#x', target: 'dropzone', content: 'hi', filename: 'a.txt' } }])).toBe(
      `{ const file = { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("hi") }; await dropFiles(${loc}, file); data = { ...data, uploaded: file.name }; }`,
    );
    expect(body([{ id: 'u', type: 'upload-file', config: { locator: '#x', source: 'data', data: '{{body64}}', filename: 'a.pdf', mime: 'application/pdf' } }])).toBe(
      `{ const file = fileFromData(render("{{body64}}", data), "a.pdf", "application/pdf"); await ${loc}.setInputFiles(file); data = { ...data, uploaded: file.name }; }`,
    );
    expect(body([{ id: 'h', type: 'http-request', config: { url: 'https://x.test/a.pdf', responseType: 'base64' } }])).toContain("body64: (await response.body()).toString('base64')");
  });

  it('the new helpers compile and decode data like the extension', () => {
    const spec = workflowToPlaywright(flow([{ id: 'l', type: 'log', config: { message: 'x' } }], []), { registry });
    const helpers = spec.slice(spec.indexOf('// --- helpers'));
    const result = ts.transpileModule(helpers, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
    expect(result.diagnostics ?? []).toEqual([]);
    const fileFromData = new Function('Buffer', `${result.outputText}\nreturn fileFromData;`)(Buffer) as (text: string, name: string, mime: string) => { mimeType: string; buffer: Buffer };
    expect(fileFromData('data:image/png;base64,aGk=', 'a', 'x')).toMatchObject({ mimeType: 'image/png' });
    expect(fileFromData(' aG\nk= ', 'a', 'text/plain').buffer.toString()).toBe('hi');
    expect(fileFromData('data:,a%20b', 'a', 'x').buffer.toString()).toBe('a b');
  });
});
