import { describe, expect, it } from 'vitest';
import { BLOB_CHUNK_BYTES, BRIDGE_PROTOCOL_VERSION, INLINE_RESULT_BYTES, MAX_BRIDGE_LOG, RPC_ERRORS } from '../../src/core/bridgeProtocol';
import type { BridgeLogEntry, RpcFailure, RpcSuccess, Suite } from '../../src/core/bridgeProtocol';
import { BLOB_TTL_MS, boundedLog, createBridgeHandlers, TIMEOUT_GRACE_MS, withRunOverlay } from '../../src/browser/bridgeHandlers';
import type { BridgeHandlerDeps, RunWorkflowOptions } from '../../src/browser/bridgeHandlers';
import { createDefaultRegistry } from '../../src/core/blocks';
import { WorkflowRunner } from '../../src/core/engine';
import type { RunRecord } from '../../src/core/runs';
import type { Workflow } from '../../src/core/types';
import { FakeHost } from '../helpers/fakeHost';

const registry = createDefaultRegistry();

/** A script calling an API with a secret in the URL and logging it. */
const SCRIPT = {
  format: 'blockflow-script',
  version: 1,
  name: 'Ping API',
  steps: [{ id: 'call', 'http-request': { url: 'https://api.test/ping?key={{secret.token}}' } }, { id: 'say', log: { message: 'used {{secret.token}}' } }],
};

interface Timer {
  ms: number;
  fn: () => void;
  cancelled: boolean;
}

function setup(overrides: Partial<BridgeHandlerDeps> = {}) {
  const fakeHost = new FakeHost();
  fakeHost.secretValues = { stored: 'stored-value' };
  let workflows: Workflow[] = [];
  const runs: RunRecord[] = [];
  const log: BridgeLogEntry[] = [];
  const cancelled = new Set<string>();
  const live = new Set<string>();
  const timers: Timer[] = [];
  let clock = 1_000_000;
  const screenshots: Record<string, string> = {};
  const suites: Suite[] = [];
  let enabled = true;
  const runWorkflow = (workflow: Workflow, options: RunWorkflowOptions) =>
    new WorkflowRunner({
      workflow,
      registry,
      host: withRunOverlay(fakeHost, options),
      onRun: (run) => {
        // Like background.ts: every update is stored (bf:runs), then given to the caller.
        const index = runs.findIndex((candidate) => candidate.id === run.id);
        if (index >= 0) runs[index] = run;
        else runs.push(run);
        if (run.status === 'running') live.add(run.id);
        else live.delete(run.id);
        options.onRun?.(run);
      },
      isCancelled: (runId) => cancelled.has(runId),
    }).runOnce();
  const deps: BridgeHandlerDeps = {
    isEnabled: () => enabled,
    info: () => ({ extensionVersion: '9.9.9', browser: 'chrome', extensionId: 'abc' }),
    loadWorkflows: async () => workflows,
    saveWorkflows: async (next) => {
      workflows = next;
    },
    secretNames: async () => Object.keys(fakeHost.secretValues),
    loadRuns: async () => runs,
    runWorkflow,
    cancelRun: (runId) => cancelled.add(runId),
    isRunLive: (runId) => live.has(runId),
    snapshot: async ({ url }) => ({ url: url ?? '', title: 'T', outline: '- heading "Hi"' }),
    loadScreenshot: async (id) => screenshots[id],
    loadSuites: async () => suites,
    runSuite: async (input, suiteDeps) => {
      const list = await suiteDeps.loadWorkflows();
      const ids = 'workflowIds' in input.suite ? (input.suite.workflowIds ?? []) : [];
      const done: RunRecord[] = [];
      for (const [index, id] of ids.entries()) {
        const workflow = list.find((candidate) => candidate.id === id) as Workflow;
        const run = await suiteDeps.runWorkflow(workflow, { ...(input.secrets ? { secrets: input.secrets } : {}) });
        done.push(run);
        suiteDeps.onProgress?.({ index, total: ids.length, workflowName: workflow.name, status: run.status });
      }
      const status = done.every((run) => run.status === 'passed') ? 'passed' : 'failed';
      return { result: { name: input.suite.name, status, startedAt: '', finishedAt: '', runs: done, skipped: [] }, ...(input.formats ? { reports: { junit: '<testsuites/>' } } : {}) };
    },
    blockLabel: (type) => registry.get(type)?.label ?? type,
    appendLog: (entry) => {
      log.push(entry);
    },
    after: (ms, fn) => {
      const timer = { ms, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    now: () => clock,
    ...overrides,
  };
  const handlers = createBridgeHandlers(deps);
  const notes: { method: string; params: Record<string, unknown> }[] = [];
  let nextId = 1;
  const call = async (method: string, params?: unknown, id: number | string = nextId++) =>
    handlers.respond({ id, method, params }, (name, payload) => notes.push({ method: name, params: payload as Record<string, unknown> }));
  const ok = async <T = Record<string, unknown>>(method: string, params?: unknown, id?: number) => {
    const response = await call(method, params, id);
    if ('error' in response) throw new Error(`${method}: ${response.error.message}`);
    return (response as RpcSuccess).result as T;
  };
  const fail = async (method: string, params?: unknown) => {
    const response = await call(method, params);
    if (!('error' in response)) throw new Error(`${method} did not fail`);
    return (response as RpcFailure).error;
  };
  return {
    fakeHost,
    deps,
    handlers,
    call,
    ok,
    fail,
    notes,
    log,
    runs,
    timers,
    cancelled,
    screenshots,
    suites,
    get workflows() {
      return workflows;
    },
    setWorkflows: (next: Workflow[]) => {
      workflows = next;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('bridge handlers: hello, validate, import, list', () => {
  it('hello answers with the extension and refuses another protocol version', async () => {
    const h = setup();
    expect(await h.ok('hello', { protocol: BRIDGE_PROTOCOL_VERSION, client: 'test' })).toEqual({ protocol: BRIDGE_PROTOCOL_VERSION, extensionVersion: '9.9.9', browser: 'chrome', extensionId: 'abc' });
    expect((await h.fail('hello', { protocol: 99 })).code).toBe(RPC_ERRORS.version);
  });

  it('validate reports ok with the compiled workflows, or the issues', async () => {
    const h = setup();
    const good = await h.ok<{ ok: boolean; workflows: unknown[]; issues: unknown[] }>('validate', { source: SCRIPT });
    expect(good.ok).toBe(true);
    expect(good.workflows).toEqual([{ name: 'Ping API', nodes: 2 }]);
    // As JSON text too.
    expect((await h.ok<{ ok: boolean }>('validate', { source: JSON.stringify(SCRIPT) })).ok).toBe(true);

    const bad = await h.ok<{ ok: boolean; issues: { level: string; code: string; path: string }[] }>('validate', { source: { ...SCRIPT, steps: [{ 'http-request': { ulr: 'x' } }] } });
    expect(bad.ok).toBe(false);
    expect(bad.issues.some((issue) => issue.level === 'error')).toBe(true);
    expect((await h.ok<{ ok: boolean; issues: { code: string }[] }>('validate', { source: '{nope' })).issues[0]?.code).toBe('json.invalid');
    // Nothing was saved.
    expect(h.workflows).toEqual([]);
  });

  it('import saves the workflows tagged "via bridge", replace keeps the id of a bridge workflow', async () => {
    const h = setup();
    const first = await h.ok<{ workflows: { id: string; name: string; viaBridge?: boolean; enabled: boolean }[] }>('import', { source: SCRIPT });
    expect(first.workflows).toMatchObject([{ name: 'Ping API', viaBridge: true, enabled: false }]);
    expect(h.workflows[0]?.importedVia).toBe('bridge');

    // Without replace: a second copy with a unique name.
    const second = await h.ok<{ workflows: { name: string }[] }>('import', { source: SCRIPT });
    expect(second.workflows[0]?.name).not.toBe('Ping API');
    expect(h.workflows).toHaveLength(2);

    // With replace: the bridge workflow named "Ping API" is replaced in place.
    const id = first.workflows[0]?.id;
    const changed = { ...SCRIPT, steps: [{ id: 'say', log: { message: 'hello' } }] };
    const third = await h.ok<{ workflows: { id: string; name: string }[] }>('import', { source: changed, replace: true });
    expect(third.workflows).toMatchObject([{ id, name: 'Ping API' }]);
    expect(h.workflows).toHaveLength(2);
    expect(h.workflows[0]?.nodes).toHaveLength(1);

    // A user's own workflow of the same name is never replaced.
    h.setWorkflows([{ ...h.workflows[0]!, id: 'mine', importedVia: undefined }]);
    await h.ok('import', { source: SCRIPT, replace: true });
    expect(h.workflows.map((workflow) => workflow.id)).toContain('mine');
    expect(h.workflows).toHaveLength(2);

    // list shows the tag.
    const listed = await h.ok<{ workflows: { id: string; viaBridge?: boolean }[] }>('list');
    expect(listed.workflows.find((workflow) => workflow.id === 'mine')?.viaBridge).toBeUndefined();
    expect(listed.workflows.filter((workflow) => workflow.viaBridge)).toHaveLength(1);
  });

  it('import of an invalid source fails with invalidWorkflow and the issues', async () => {
    const h = setup();
    const error = await h.fail('import', { source: { format: 'blockflow-script', version: 1, name: 'x', steps: [{ nope: {} }] } });
    expect(error.code).toBe(RPC_ERRORS.invalidWorkflow);
    expect(Array.isArray((error.data as { issues?: unknown[] }).issues)).toBe(true);
    expect((await h.fail('import', {})).code).toBe(RPC_ERRORS.invalidParams);
  });
});

describe('bridge handlers: run', () => {
  it('streams run.started and run.step with the request id and resolves with the finished run', async () => {
    const h = setup();
    const result = await h.ok<{ run: RunRecord }>('run', { source: SCRIPT }, 42);
    expect(result.run.status).toBe('passed');
    expect(h.notes[0]).toEqual({ method: 'run.started', params: { requestId: 42, runId: result.run.id, workflowName: 'Ping API' } });
    const steps = h.notes.filter((note) => note.method === 'run.step');
    expect(steps.every((note) => note.params.requestId === 42 && note.params.runId === result.run.id)).toBe(true);
    // running + finished, for each of the two steps.
    expect(steps.map((note) => (note.params.step as { status: string }).status)).toEqual(['running', 'passed', 'running', 'passed']);
    // An inline source is not saved.
    expect(h.workflows).toEqual([]);
  });

  it('runs a saved workflow by id, and fails for an unknown id', async () => {
    const h = setup();
    const imported = await h.ok<{ workflows: { id: string }[] }>('import', { source: SCRIPT });
    const result = await h.ok<{ run: RunRecord }>('run', { workflowId: imported.workflows[0]?.id });
    expect(result.run.workflowId).toBe(imported.workflows[0]?.id);
    expect((await h.fail('run', { workflowId: 'missing' })).code).toBe(RPC_ERRORS.notFound);
    expect((await h.fail('run', {})).code).toBe(RPC_ERRORS.invalidParams);
    expect((await h.fail('run', { source: { format: 'blockflow-script', version: 1, name: 'x', steps: [{ nope: {} }] } })).code).toBe(RPC_ERRORS.invalidWorkflow);
  });

  it('overlays secrets for that run only: used by blocks, masked in the stored run, never stored', async () => {
    const h = setup();
    const result = await h.ok<{ run: RunRecord }>('run', { source: SCRIPT, secrets: { token: 'tok-SECRET-123' } });
    expect(result.run.status).toBe('passed');
    // The block saw the value.
    expect(h.fakeHost.requests[0]?.url).toBe('https://api.test/ping?key=tok-SECRET-123');
    // Stored secrets are unchanged.
    expect(await h.fakeHost.secrets.all()).toEqual({ stored: 'stored-value' });
    // Neither the stored runs, the notifications nor the bridge log contain the value.
    const everything = JSON.stringify({ runs: h.runs, notes: h.notes, log: h.log, result });
    expect(everything).not.toContain('tok-SECRET-123');
    expect(everything).toContain('•••');
    // The next run without the overlay does not see it.
    await h.ok('run', { source: SCRIPT });
    expect(h.fakeHost.requests[1]?.url).toBe('https://api.test/ping?key=');
    expect((await h.fail('run', { source: SCRIPT, secrets: { token: 5 } })).code).toBe(RPC_ERRORS.invalidParams);
  });

  it('timeoutSeconds stops the run through the cancel path', async () => {
    let finish: ((run: RunRecord) => void) | undefined;
    const h = setup({
      runWorkflow: (workflow, options) =>
        new Promise<RunRecord>((resolve) => {
          const run: RunRecord = { id: 'r1', workflowId: workflow.id, workflowName: workflow.name, trigger: 'manual', status: 'running', startedAt: '', steps: [] };
          options.onRun?.(run);
          finish = (done) => resolve(done);
        }),
    });
    const pending = h.ok<{ run: RunRecord }>('run', { source: SCRIPT, timeoutSeconds: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const timer = h.timers.find((candidate) => candidate.ms === 2000);
    expect(timer).toBeDefined();
    timer!.fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.cancelled.has('r1')).toBe(true);
    finish!({ id: 'r1', workflowId: 'w', workflowName: 'Ping API', trigger: 'manual', status: 'cancelled', startedAt: '', steps: [], error: 'Stopped by the user.' });
    const result = await pending;
    expect(result.run.status).toBe('cancelled');
    expect(result.run.error).toMatch(/Timed out after 2 s/);
  });

  it('a run that does not stop after its timeout is answered after the grace period', async () => {
    const h = setup({
      runWorkflow: (workflow, options) =>
        new Promise<RunRecord>(() => {
          options.onRun?.({ id: 'r2', workflowId: workflow.id, workflowName: workflow.name, trigger: 'manual', status: 'running', startedAt: '', steps: [] });
        }),
    });
    const pending = h.ok<{ run: RunRecord }>('run', { source: SCRIPT, timeoutSeconds: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.timers.find((timer) => timer.ms === 1000)!.fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.timers.find((timer) => timer.ms === TIMEOUT_GRACE_MS)!.fn();
    const result = await pending;
    expect(result.run).toMatchObject({ id: 'r2', status: 'cancelled' });
    expect(result.run.error).toMatch(/still stopping/);
    expect((await h.fail('run', { source: SCRIPT, timeoutSeconds: -1 })).code).toBe(RPC_ERRORS.invalidParams);
  });

  it('a run within its timeout cancels the timer', async () => {
    const h = setup();
    await h.ok('run', { source: SCRIPT, timeoutSeconds: 30 });
    expect(h.timers.find((timer) => timer.ms === 30_000)?.cancelled).toBe(true);
  });
});

describe('bridge handlers: stop, report, snapshot, blobs, suites', () => {
  it('stop cancels a live run, says false for a finished one, notFound otherwise', async () => {
    const h = setup();
    const result = await h.ok<{ run: RunRecord }>('run', { source: SCRIPT });
    expect(await h.ok('stop', { runId: result.run.id })).toEqual({ stopped: false });
    expect((await h.fail('stop', { runId: 'nope' })).code).toBe(RPC_ERRORS.notFound);
    const live = setup({ isRunLive: () => true });
    expect(await live.ok('stop', { runId: 'x' })).toEqual({ stopped: true });
    expect(live.cancelled.has('x')).toBe(true);
  });

  it('report builds json, junit and html from stored runs', async () => {
    const h = setup();
    const { run } = await h.ok<{ run: RunRecord }>('run', { source: SCRIPT });
    const json = await h.ok<{ format: string; content: string }>('report', { format: 'json', runIds: [run.id] });
    expect(JSON.parse(json.content)).toMatchObject({ schemaVersion: 1, summary: { total: 1, passed: 1 } });
    const junit = await h.ok<{ content: string }>('report', { format: 'junit', workflowId: run.workflowId });
    expect(junit.content).toContain('<testsuite name="Ping API"');
    const htmlReport = await h.ok<{ content: string }>('report', { format: 'html', limit: 1 });
    expect(htmlReport.content).toContain('<html');
    expect((await h.fail('report', { format: 'pdf' })).code).toBe(RPC_ERRORS.invalidParams);
    expect((await h.fail('report', { format: 'json', runIds: ['gone'] })).code).toBe(RPC_ERRORS.notFound);
  });

  it('snapshot passes url or tab through and needs one of them', async () => {
    const h = setup();
    expect(await h.ok('snapshot', { url: 'https://example.test/' })).toEqual({ url: 'https://example.test/', title: 'T', outline: '- heading "Hi"' });
    expect((await h.fail('snapshot', {})).code).toBe(RPC_ERRORS.invalidParams);
  });

  it('large results come back as a blob, read in chunks; blobs expire', async () => {
    const big = 'x'.repeat(INLINE_RESULT_BYTES + BLOB_CHUNK_BYTES);
    const h = setup({ snapshot: async () => ({ url: 'u', title: 't', outline: big }) });
    const ref = await h.ok<{ blobId: string; size: number }>('snapshot', { url: 'https://example.test/' });
    expect(ref.blobId).toBeTruthy();
    expect(ref.size).toBeGreaterThan(INLINE_RESULT_BYTES);
    let offset = 0;
    const parts: Buffer[] = [];
    for (;;) {
      const chunk = await h.ok<{ data: string; offset: number; size: number; done: boolean; mime?: string }>('blob.get', { blobId: ref.blobId, offset });
      expect(chunk.size).toBe(ref.size);
      const bytes = Buffer.from(chunk.data, 'base64');
      expect(bytes.length).toBeLessThanOrEqual(BLOB_CHUNK_BYTES);
      parts.push(bytes);
      offset += bytes.length;
      if (chunk.done) break;
    }
    expect(parts.length).toBe(Math.ceil(ref.size / BLOB_CHUNK_BYTES));
    expect(JSON.parse(Buffer.concat(parts).toString('utf8'))).toEqual({ url: 'u', title: 't', outline: big });
    expect((await h.fail('blob.get', { blobId: ref.blobId, offset: ref.size + 1 })).code).toBe(RPC_ERRORS.invalidParams);
    h.advance(BLOB_TTL_MS + 1);
    expect((await h.fail('blob.get', { blobId: ref.blobId, offset: 0 })).code).toBe(RPC_ERRORS.notFound);
  });

  it('blob.get screenshot:<id> returns the image bytes with their type', async () => {
    const h = setup();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    h.screenshots.s1 = `data:image/png;base64,${png.toString('base64')}`;
    const chunk = await h.ok<{ data: string; size: number; done: boolean; mime: string }>('blob.get', { blobId: 'screenshot:s1', offset: 0 });
    expect(chunk).toMatchObject({ size: png.length, done: true, mime: 'image/png' });
    expect(Buffer.from(chunk.data, 'base64').equals(png)).toBe(true);
    expect((await h.fail('blob.get', { blobId: 'screenshot:none', offset: 0 })).code).toBe(RPC_ERRORS.notFound);
  });

  it('suite.list and suite.run (saved by name, with progress and run notifications)', async () => {
    const h = setup();
    const imported = await h.ok<{ workflows: { id: string }[] }>('import', { source: SCRIPT });
    h.suites.push({ id: 's1', name: 'Smoke', workflowIds: [imported.workflows[0]!.id] });
    expect(await h.ok('suite.list')).toEqual({ suites: h.suites });
    const outcome = await h.ok<{ result: { status: string; runs: RunRecord[] }; reports?: Record<string, string> }>('suite.run', { name: 'Smoke', formats: ['junit'], secrets: { token: 'abcdef' } }, 7);
    expect(outcome.result.status).toBe('passed');
    expect(outcome.reports?.junit).toBe('<testsuites/>');
    expect(h.notes.some((note) => note.method === 'suite.progress' && note.params.requestId === 7 && note.params.total === 1)).toBe(true);
    expect(h.notes.some((note) => note.method === 'run.started' && note.params.requestId === 7)).toBe(true);
    expect(h.fakeHost.requests.at(-1)?.url).toContain('abcdef');
    expect((await h.fail('suite.run', { name: 'Nope' })).code).toBe(RPC_ERRORS.notFound);
    expect((await h.fail('suite.run', {})).code).toBe(RPC_ERRORS.invalidParams);
  });
});

describe('bridge handlers: disabled, unknown methods, the log', () => {
  it('refuses everything with disabled while outside control is off, and logs it', async () => {
    const h = setup();
    h.setEnabled(false);
    for (const method of ['hello', 'list', 'run', 'blob.get']) expect((await h.fail(method, {})).code).toBe(RPC_ERRORS.disabled);
    expect(h.log.every((entry) => !entry.ok)).toBe(true);
    expect(h.log).toHaveLength(4);
  });

  it('unknown methods and auth are methodNotFound; params must be an object', async () => {
    const h = setup();
    expect((await h.fail('auth', { token: 'x', protocol: 1 })).code).toBe(RPC_ERRORS.methodNotFound);
    expect((await h.fail('toString', {})).code).toBe(RPC_ERRORS.methodNotFound);
    expect((await h.fail('list', [1])).code).toBe(RPC_ERRORS.invalidParams);
  });

  it('logs method, ok and a short detail for every request, without payloads', async () => {
    const h = setup();
    await h.ok('run', { source: SCRIPT, secrets: { token: 'very-secret-value' } });
    await h.fail('stop', { runId: 'nope' });
    expect(h.log.map((entry) => [entry.method, entry.ok])).toEqual([
      ['run', true],
      ['stop', false],
    ]);
    expect(h.log[0]?.detail).toMatch(/"Ping API" passed/);
    expect(JSON.stringify(h.log)).not.toContain('very-secret-value');
    expect(JSON.stringify(h.log)).not.toContain('api.test');
  });

  it('boundedLog keeps the newest MAX_BRIDGE_LOG entries', () => {
    let list: BridgeLogEntry[] = [];
    for (let index = 0; index < MAX_BRIDGE_LOG + 25; index += 1) list = boundedLog(list, { at: String(index), method: 'list', ok: true });
    expect(list).toHaveLength(MAX_BRIDGE_LOG);
    expect(list[0]?.at).toBe('25');
    expect(list.at(-1)?.at).toBe(String(MAX_BRIDGE_LOG + 24));
  });
});
