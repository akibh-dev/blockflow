// The MCP server against an in-process fake bridge, through the SDK client over InMemoryTransport.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBlockflowServer } from '../../packages/mcp/index.mjs';
import type { BlockflowServerOptions } from '../../packages/mcp/index.mjs';
import { blobHandler, failedRun, fakeBridge, FakeBridgeError, passedRun } from './fakeBridge';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function connect(options: BlockflowServerOptions) {
  const app = createBlockflowServer(options);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await app.server.connect(serverSide);
  await client.connect(clientSide);
  closers.push(async () => {
    await client.close();
    await app.close();
  });
  return client;
}

type Content = { type: string; text?: string; data?: string; mimeType?: string }[];
const textOf = (result: any) => (result.content as Content).filter((part) => part.type === 'text').map((part) => part.text).join('\n');

const issue = { level: 'error', code: 'config.key.unknown', path: '/steps/1/click/locater', message: 'Block "s2" (click) has no setting "locater".', hint: 'Did you mean "locator"?' };

describe('tools', () => {
  it('lists every tool with an input schema and a description', async () => {
    const client = await connect({ connect: fakeBridge({}).connect });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ['get_report', 'import_workflow', 'list_suites', 'list_workflows', 'run_suite', 'run_workflow', 'snapshot_page', 'stop_run', 'validate_workflow'].sort(),
    );
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description!.length).toBeGreaterThan(60);
    }
    const run = tools.find((tool) => tool.name === 'run_workflow')!;
    expect(Object.keys(run.inputSchema.properties!)).toEqual(expect.arrayContaining(['workflowId', 'source', 'secrets', 'timeoutSeconds']));
    const validate = tools.find((tool) => tool.name === 'validate_workflow')!;
    expect(validate.inputSchema.required).toEqual(['source']);
  });

  it('does not connect to the bridge until a tool is called', async () => {
    const bridge = fakeBridge({ list: () => ({ workflows: [] }) });
    const client = await connect({ connect: bridge.connect });
    await client.listTools();
    expect(bridge.connects).toBe(0);
    await client.callTool({ name: 'list_workflows', arguments: {} });
    await client.callTool({ name: 'list_workflows', arguments: {} });
    expect(bridge.connects).toBe(1);
  });

  it('list_workflows', async () => {
    const workflows = [
      { id: 'wf-1', name: 'Login test', enabled: false, viaBridge: true },
      { id: 'wf-2', name: 'Price watch', enabled: true },
    ];
    const client = await connect({ connect: fakeBridge({ list: () => ({ workflows }) }).connect });
    const result: any = await client.callTool({ name: 'list_workflows', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('wf-1 "Login test" off (via bridge)');
    expect(textOf(result)).toContain('wf-2 "Price watch" on');
    expect(result.structuredContent).toEqual({ workflows });
  });

  it('validate_workflow passes the source through and returns ok', async () => {
    const bridge = fakeBridge({ validate: () => ({ ok: true, issues: [], workflows: [{ name: 'Login test', nodes: 4 }] }) });
    const client = await connect({ connect: bridge.connect });
    const source = { format: 'blockflow-script', version: 1, name: 'Login test', steps: [{ open: 'https://example.com' }] };
    const result: any = await client.callTool({ name: 'validate_workflow', arguments: { source } });
    expect(bridge.calls[0]).toMatchObject({ method: 'validate', params: { source } });
    expect(textOf(result)).toMatch(/^Valid: "Login test" \(4 blocks\)/);
    expect(result.structuredContent.ok).toBe(true);
  });

  it('validate_workflow returns issues as code/path/hint lines for an invalid script', async () => {
    const client = await connect({ connect: fakeBridge({ validate: () => ({ ok: false, issues: [issue], workflows: [] }) }).connect });
    const result: any = await client.callTool({ name: 'validate_workflow', arguments: { source: '{"format":"blockflow-script"}' } });
    expect(textOf(result)).toContain('INVALID');
    expect(textOf(result)).toContain('error config.key.unknown at /steps/1/click/locater: Block "s2" (click) has no setting "locater". Did you mean "locator"?');
    expect(result.structuredContent).toMatchObject({ ok: false, issues: [issue] });
  });

  it('import_workflow passes replace and lists the new ids; an import with only errors is an error', async () => {
    const bridge = fakeBridge({
      import: ({ replace }) =>
        replace ? { workflows: [{ id: 'wf-9', name: 'Login test', enabled: false, viaBridge: true }], issues: [] } : { workflows: [], issues: [issue] },
    });
    const client = await connect({ connect: bridge.connect });
    const ok: any = await client.callTool({ name: 'import_workflow', arguments: { source: '{}', replace: true } });
    expect(bridge.calls[0].params).toEqual({ source: '{}', replace: true });
    expect(ok.isError).toBeFalsy();
    expect(textOf(ok)).toContain('wf-9 "Login test"');
    const bad: any = await client.callTool({ name: 'import_workflow', arguments: { source: '{}' } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('config.key.unknown');
  });

  it('run_workflow: a passed run gives a summary and the step outputs', async () => {
    const bridge = fakeBridge({ run: () => ({ run: passedRun }) });
    const client = await connect({ connect: bridge.connect });
    const result: any = await client.callTool({ name: 'run_workflow', arguments: { workflowId: 'wf-1', secrets: { pw: 'x' }, timeoutSeconds: 30 } });
    expect(bridge.calls[0]).toMatchObject({ method: 'run', params: { workflowId: 'wf-1', secrets: { pw: 'x' }, timeoutSeconds: 30 }, options: { timeoutMs: 90_000 } });
    const body = textOf(result);
    expect(body.split('\n')[0]).toBe('Run PASSED in 2.5 s: "Login test" (run run-1, workflow wf-1)');
    expect(body).toContain('- title read-element ok 300 ms');
    expect(body).toContain('title: {"text":"Welcome"}');
    expect(result.structuredContent).toMatchObject({ status: 'passed', runId: 'run-1', durationMs: 2500 });
    expect((result.content as Content).some((part) => part.type === 'image')).toBe(false);
  });

  it('run_workflow: a failed run gives the failing step first and the screenshot as an image', async () => {
    const png = Buffer.from('\x89PNG fake image bytes, longer than one chunk');
    const bridge = fakeBridge({ run: () => ({ run: failedRun }), 'blob.get': blobHandler({ 'screenshot:shot-1': { bytes: png, mime: 'image/png' } }, 7) });
    const client = await connect({ connect: bridge.connect });
    const result: any = await client.callTool({ name: 'run_workflow', arguments: { source: { format: 'blockflow-script', version: 1, name: 'x', steps: [] } } });
    expect(result.isError).toBeFalsy();
    const first = (result.content as Content)[0].text!;
    expect(first).toContain('Run FAILED in 2.5 s');
    expect(first).toContain('Failing step: landed (click)');
    expect(first).toContain('Error code: locator.not-found');
    expect(first).toContain('Message: No element matches role=button[name="Sign in"]');
    expect(first).toContain('Locator: role=button[name="Sign in"]');
    expect(first).toContain('Page URL: https://example.com/login');
    expect(first).toContain('Next:');
    const image = (result.content as Content).find((part) => part.type === 'image')!;
    expect(image.mimeType).toBe('image/png');
    expect(Buffer.from(image.data!, 'base64').equals(png)).toBe(true);
    expect(bridge.calls.filter((call) => call.method === 'blob.get').map((call) => call.params.offset)).toEqual([0, 7, 14, 21, 28, 35, 42]);
    expect(result.structuredContent.failingStep).toMatchObject({ id: 'landed', blockType: 'click', code: 'locator.not-found', url: 'https://example.com/login' });
  });

  it('run_workflow: a screenshot that cannot be fetched is a note, not a failure', async () => {
    const client = await connect({ connect: fakeBridge({ run: () => ({ run: failedRun }), 'blob.get': blobHandler({}) }).connect });
    const result: any = await client.callTool({ name: 'run_workflow', arguments: { workflowId: 'wf-1' } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('The failure screenshot could not be fetched: No blob screenshot:shot-1');
  });

  it('run_workflow: an invalid inline source returns its issues as an error', async () => {
    const client = await connect({
      connect: fakeBridge({
        run: () => {
          throw new FakeBridgeError(-32005, 'The workflow did not validate', { issues: [issue] });
        },
      }).connect,
    });
    const result: any = await client.callTool({ name: 'run_workflow', arguments: { source: '{}' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('nothing ran');
    expect(textOf(result)).toContain('error config.key.unknown at /steps/1/click/locater');
  });

  it('run_workflow needs exactly one of workflowId and source', async () => {
    const bridge = fakeBridge({});
    const client = await connect({ connect: bridge.connect });
    const result: any = await client.callTool({ name: 'run_workflow', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('exactly one of workflowId');
    expect(bridge.calls).toHaveLength(0);
  });

  it('run_workflow: a BlobRef result is fetched in chunks and parsed', async () => {
    const big = Buffer.from(JSON.stringify({ run: { ...passedRun, workflowName: 'Big ünïcode run' } }), 'utf8');
    const bridge = fakeBridge({ run: () => ({ blobId: 'b1', size: big.length }), 'blob.get': blobHandler({ b1: { bytes: big } }, 64) });
    const client = await connect({ connect: bridge.connect });
    const result: any = await client.callTool({ name: 'run_workflow', arguments: { workflowId: 'wf-1' } });
    expect(textOf(result)).toContain('"Big ünïcode run"');
    expect(bridge.calls.filter((call) => call.method === 'blob.get').length).toBe(Math.ceil(big.length / 64));
  });

  it('run_workflow streams run.started and run.step as progress notifications', async () => {
    const bridge = fakeBridge({
      run: async (_params, notify) => {
        notify('run.started', { runId: 'run-1', workflowName: 'Login test' });
        for (const step of passedRun.steps) notify('run.step', { runId: 'run-1', step });
        return { run: passedRun };
      },
    });
    const client = await connect({ connect: bridge.connect });
    const progress: { progress: number; message?: string }[] = [];
    await client.callTool({ name: 'run_workflow', arguments: { workflowId: 'wf-1' } }, undefined, { onprogress: (p) => progress.push(p) });
    expect(progress.map((p) => p.progress)).toEqual([1, 2, 3]);
    expect(progress[0].message).toContain('started "Login test" (run run-1)');
    expect(progress[2].message).toBe('title read-element passed');
  });

  it('get_report, snapshot_page, stop_run', async () => {
    const outline = '# Page snapshot: Log in\nURL: https://example.com/login\n- button "Sign in" [ref=e1] locator=role=button[name="Sign in"]';
    const bridge = fakeBridge({
      report: ({ format }) => ({ format, content: `<testsuites format="${format}"/>` }),
      snapshot: () => ({ blobId: 'snap', size: Buffer.byteLength(JSON.stringify({ url: 'https://example.com/login', title: 'Log in', outline })) }),
      'blob.get': blobHandler({ snap: { bytes: Buffer.from(JSON.stringify({ url: 'https://example.com/login', title: 'Log in', outline })) } }, 1000),
      stop: ({ runId }) => ({ stopped: runId === 'run-1' }),
    });
    const client = await connect({ connect: bridge.connect });
    const report: any = await client.callTool({ name: 'get_report', arguments: { format: 'junit', runIds: ['run-1'] } });
    expect(textOf(report)).toBe('<testsuites format="junit"/>');
    expect(bridge.calls[0].params).toEqual({ format: 'junit', runIds: ['run-1'] });
    const snap: any = await client.callTool({ name: 'snapshot_page', arguments: { url: 'https://example.com/login' } });
    expect(textOf(snap)).toBe(outline);
    expect(snap.structuredContent).toEqual({ url: 'https://example.com/login', title: 'Log in' });
    const noArgs: any = await client.callTool({ name: 'snapshot_page', arguments: {} });
    expect(noArgs.isError).toBe(true);
    const stop: any = await client.callTool({ name: 'stop_run', arguments: { runId: 'run-1' } });
    expect(textOf(stop)).toBe('Stopping run run-1.');
    const notRunning: any = await client.callTool({ name: 'stop_run', arguments: { runId: 'nope' } });
    expect(textOf(notRunning)).toBe('Run nope was not running.');
  });

  it('list_suites and run_suite (with progress and reports)', async () => {
    const suites = [{ id: 'su-1', name: 'Smoke', workflowIds: ['wf-1', 'wf-2'], stopOnFailure: true }];
    const result = { name: 'Smoke', suiteId: 'su-1', status: 'failed', startedAt: passedRun.startedAt, finishedAt: '2026-11-10T10:00:05.000Z', runs: [passedRun, failedRun], skipped: ['Third'] };
    const bridge = fakeBridge({
      'suite.list': () => ({ suites }),
      'suite.run': async (_params, notify) => {
        notify('suite.progress', { index: 0, total: 2, workflowName: 'Login test', status: 'passed' });
        notify('suite.progress', { index: 1, total: 2, workflowName: 'Login test', status: 'failed' });
        return { result, reports: { junit: '<testsuite/>' } };
      },
    });
    const client = await connect({ connect: bridge.connect });
    const list: any = await client.callTool({ name: 'list_suites', arguments: {} });
    expect(textOf(list)).toContain('su-1 "Smoke": 2 workflow(s), stops on the first failure');
    const progress: { progress: number; total?: number }[] = [];
    const run: any = await client.callTool({ name: 'run_suite', arguments: { name: 'Smoke', formats: ['junit'] } }, undefined, { onprogress: (p) => progress.push(p) });
    expect(bridge.calls[1].params).toEqual({ name: 'Smoke', formats: ['junit'] });
    const body = textOf(run);
    expect(body).toContain('Suite FAILED in 5.0 s: "Smoke", 1/2 workflow(s) passed');
    expect(body).toContain('at landed (click) locator.not-found');
    expect(body).toContain('Skipped (stopOnFailure): Third');
    expect(body).toContain('junit report:\n<testsuite/>');
    expect(progress).toEqual([expect.objectContaining({ progress: 1, total: 2 }), expect.objectContaining({ progress: 2, total: 2 })]);
    const both: any = await client.callTool({ name: 'run_suite', arguments: { name: 'Smoke', suiteId: 'su-1' } });
    expect(both.isError).toBe(true);
  });
});

describe('bridge errors', () => {
  it('a bridge that cannot be reached becomes an isError result, and the server keeps working', async () => {
    let attempts = 0;
    const client = await connect({
      connect: async () => {
        attempts += 1;
        throw new FakeBridgeError(-32006, 'BlockFlow is not reachable: is the browser open with Allow outside control on, and the bridge installed?');
      },
    });
    const result: any = await client.callTool({ name: 'list_workflows', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('BlockFlow error: BlockFlow is not reachable: is the browser open with Allow outside control on, and the bridge installed?');
    expect(attempts).toBe(2); // one reconnect
    const again: any = await client.callTool({ name: 'list_workflows', arguments: {} });
    expect(again.isError).toBe(true);
  });

  it('outside control off: the message says how to switch it on', async () => {
    const client = await connect({
      connect: fakeBridge({
        list: () => {
          throw new FakeBridgeError(-32002, 'Outside control is off.');
        },
      }).connect,
    });
    const result: any = await client.callTool({ name: 'list_workflows', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Allow outside control');
  });

  it('a dropped connection is reconnected once for a safe call, not retried for a run', async () => {
    let connects = 0;
    let closeFirst: () => void = () => {};
    const connectFn = async () => {
      connects += 1;
      const id = connects;
      const closed = new Promise<void>((resolve) => (closeFirst = resolve));
      return {
        closed,
        close() {},
        async call(method: string) {
          if (id === 1) {
            closeFirst();
            throw new FakeBridgeError(-32006, 'The BlockFlow bridge closed the connection.');
          }
          if (method === 'list') return { workflows: [] };
          throw new Error(`socket hang up during ${method}`);
        },
      };
    };
    const client = await connect({ connect: connectFn });
    const list: any = await client.callTool({ name: 'list_workflows', arguments: {} });
    expect(list.isError).toBeFalsy();
    expect(connects).toBe(2);
    const run: any = await client.callTool({ name: 'run_workflow', arguments: { workflowId: 'wf-1' } });
    expect(run.isError).toBe(true);
    expect(textOf(run)).toContain('not retried');
    expect(connects).toBe(2);
  });

  it('notConnected as an answer (the extension is not connected to the host) is not retried', async () => {
    const bridge = fakeBridge({
      list: () => {
        throw new FakeBridgeError(-32006, 'The extension is not connected.');
      },
    });
    const client = await connect({ connect: bridge.connect });
    const result: any = await client.callTool({ name: 'list_workflows', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('switch on "Allow outside control"');
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.connects).toBe(1);
  });
});

describe('resources and prompt', () => {
  it('serves the guide, block reference, script schema and llms.txt from the repo', async () => {
    const client = await connect({ connect: fakeBridge({}).connect });
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri).sort()).toEqual(['blockflow://blocks', 'blockflow://guide', 'blockflow://llms.txt', 'blockflow://script-schema']);
    const guide = await client.readResource({ uri: 'blockflow://guide' });
    expect((guide.contents[0] as any).text).toContain('Rules for AI tools');
    const schema = await client.readResource({ uri: 'blockflow://script-schema' });
    expect(JSON.parse((schema.contents[0] as any).text)).toBeTypeOf('object');
    expect(schema.contents[0].mimeType).toBe('application/schema+json');
  });

  it('prefers the packaged copy in <package>/resources', async () => {
    const packageDir = mkdtempSync(path.join(os.tmpdir(), 'bf-mcp-'));
    mkdirSync(path.join(packageDir, 'resources'));
    writeFileSync(path.join(packageDir, 'resources', 'llms.txt'), 'packaged copy');
    const client = await connect({ connect: fakeBridge({}).connect, resourceDirs: { packageDir, repoDir: path.resolve(__dirname, '../..') } });
    const llms = await client.readResource({ uri: 'blockflow://llms.txt' });
    expect((llms.contents[0] as any).text).toBe('packaged copy');
    const blocks = await client.readResource({ uri: 'blockflow://blocks' });
    expect((blocks.contents[0] as any).text.length).toBeGreaterThan(1000);
  });

  it('write-and-repair-test explains the loop with the url and goal', async () => {
    const client = await connect({ connect: fakeBridge({}).connect });
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toEqual(['write-and-repair-test']);
    expect(prompts[0].arguments?.map((arg) => arg.name)).toEqual(['url', 'goal']);
    const prompt = await client.getPrompt({ name: 'write-and-repair-test', arguments: { url: 'https://example.com/login', goal: 'log in and see the dashboard' } });
    const body = (prompt.messages[0].content as any).text as string;
    expect(body).toContain('https://example.com/login');
    expect(body).toContain('log in and see the dashboard');
    const order = ['Call snapshot_page', 'Call validate_workflow', 'Call run_workflow'].map((name) => body.indexOf(name));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
