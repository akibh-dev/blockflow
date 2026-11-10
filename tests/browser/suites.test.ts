import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Suite, SuiteInput } from '../../src/core/bridgeProtocol';
import type { RunRecord } from '../../src/core/runs';
import type { Workflow } from '../../src/core/types';

const storage = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in storage.data ? { [key]: storage.data[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => Object.assign(storage.data, items)),
      },
    },
  },
}));

const { loadSuites, runSuite, saveSuites } = await import('../../src/browser/suites');

const workflow = (id: string, name = id): Workflow => ({ schemaVersion: 2, id, name, enabled: false, nodes: [], edges: [] });
const saved = [workflow('a', 'Login'), workflow('b', 'Cart'), workflow('c', 'Pay')];

function deps(statuses: Record<string, RunRecord['status']> = {}) {
  const ran: { name: string; secrets?: Record<string, string> }[] = [];
  const progress: { index: number; total: number; workflowName: string; status: string }[] = [];
  return {
    ran,
    progress,
    deps: {
      loadWorkflows: vi.fn(async () => saved),
      runWorkflow: vi.fn(async (wf: Workflow, opts: { secrets?: Record<string, string> }): Promise<RunRecord> => {
        ran.push({ name: wf.name, ...(opts.secrets ? { secrets: opts.secrets } : {}) });
        const status = statuses[wf.name] ?? 'passed';
        return {
          id: `run-${wf.name}`,
          workflowId: wf.id,
          workflowName: wf.name,
          trigger: 'manual',
          status,
          startedAt: '2026-11-01T10:00:00.000Z',
          endedAt: '2026-11-01T10:00:01.000Z',
          steps: status === 'failed' ? [{ nodeId: 'n', blockType: 'assert', status: 'failed', startedAt: '', attempts: 1, error: 'nope', code: 'assert.failed' }] : [],
        };
      }),
      onProgress: (p: { index: number; total: number; workflowName: string; status: string }) => progress.push(p),
    },
  };
}

const script = (name: string) => ({ format: 'blockflow-script', version: 1, name, steps: [{ log: 'hi' }] });

beforeEach(() => {
  storage.data = {};
});

describe('suite storage', () => {
  it('saves and loads bf:suites, leniently', async () => {
    expect(await loadSuites()).toEqual([]);
    const suites: Suite[] = [{ id: 's', name: 'Smoke', workflowIds: ['a'], stopOnFailure: true }];
    await saveSuites(suites);
    expect(storage.data['bf:suites']).toEqual(suites);
    expect(await loadSuites()).toEqual(suites);
    storage.data['bf:suites'] = [{ id: 'x', workflowIds: 'bad' }, 'junk'];
    expect(await loadSuites()).toEqual([{ id: 'x', name: 'Untitled suite', workflowIds: [] }]);
  });
});

describe('runSuite', () => {
  it('runs saved workflows in suite order and reports progress', async () => {
    const t = deps();
    const { result, reports } = await runSuite({ suite: { id: 's', name: 'Smoke', workflowIds: ['c', 'a', 'b'] } }, t.deps);
    expect(t.ran.map((r) => r.name)).toEqual(['Pay', 'Login', 'Cart']);
    expect(t.progress).toEqual([
      { index: 0, total: 3, workflowName: 'Pay', status: 'passed' },
      { index: 1, total: 3, workflowName: 'Login', status: 'passed' },
      { index: 2, total: 3, workflowName: 'Cart', status: 'passed' },
    ]);
    expect(result).toMatchObject({ suiteId: 's', name: 'Smoke', status: 'passed', skipped: [] });
    expect(result.runs.map((run) => run.workflowName)).toEqual(['Pay', 'Login', 'Cart']);
    expect(reports).toBeUndefined();
  });

  it('without stopOnFailure runs everything; with it, skips the rest', async () => {
    const all = deps({ Login: 'failed' });
    const first = await runSuite({ suite: { id: 's', name: 'S', workflowIds: ['a', 'b', 'c'] } }, all.deps);
    expect(all.ran).toHaveLength(3);
    expect(first.result).toMatchObject({ status: 'failed', skipped: [] });

    const stop = deps({ Login: 'failed' });
    const second = await runSuite({ suite: { id: 's', name: 'S', workflowIds: ['a', 'b', 'c'], stopOnFailure: true } }, stop.deps);
    expect(stop.ran.map((r) => r.name)).toEqual(['Login']);
    expect(second.result).toMatchObject({ status: 'failed', skipped: ['Cart', 'Pay'] });
    expect(stop.progress.map((p) => p.status)).toEqual(['failed', 'skipped', 'skipped']);
  });

  it('passes secrets to every run', async () => {
    const t = deps();
    await runSuite({ suite: { id: 's', name: 'S', workflowIds: ['a', 'b'] }, secrets: { token: 't0k3n' } }, t.deps);
    expect(t.ran).toEqual([
      { name: 'Login', secrets: { token: 't0k3n' } },
      { name: 'Cart', secrets: { token: 't0k3n' } },
    ]);
    const none = deps();
    await runSuite({ suite: { id: 's', name: 'S', workflowIds: ['a'] } }, none.deps);
    expect(none.deps.runWorkflow.mock.calls[0]?.[1]).toEqual({});
  });

  it('compiles inline sources (object or text) and runs them after the saved ids', async () => {
    const t = deps();
    const suite: SuiteInput = { name: 'Inline', workflowIds: ['a'], sources: [script('Login'), JSON.stringify(script('Second'))] };
    const { result } = await runSuite({ suite }, t.deps);
    // The inline "Login" keeps its name although a saved workflow has it.
    expect(t.ran.map((r) => r.name)).toEqual(['Login', 'Login', 'Second']);
    const inline = t.deps.runWorkflow.mock.calls[1]?.[0] as Workflow;
    expect(inline.nodes.map((node) => node.type)).toEqual(['log']);
    expect(inline.id).not.toBe('a');
    expect(result.suiteId).toBeUndefined();
  });

  it('an invalid source fails the suite before anything runs', async () => {
    const t = deps();
    const suite: SuiteInput = { name: 'Bad', workflowIds: ['a'], sources: [script('Good'), { format: 'blockflow-script', version: 1, name: 'X', steps: [{ clik: 'x' }] }, '{not json'] };
    const error = await runSuite({ suite }, t.deps).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'config.invalid' });
    expect((error as Error).message).toContain('/sources/1');
    expect((error as Error).message).toContain('/sources/2');
    expect(t.deps.runWorkflow).not.toHaveBeenCalled();
  });

  it('unknown workflow ids, no name or no workflows throw config.invalid', async () => {
    const t = deps();
    await expect(runSuite({ suite: { id: 's', name: 'S', workflowIds: ['a', 'zzz'] } }, t.deps)).rejects.toMatchObject({ code: 'config.invalid', message: expect.stringContaining('zzz') });
    await expect(runSuite({ suite: { name: '', workflowIds: ['a'] } }, t.deps)).rejects.toMatchObject({ code: 'config.invalid' });
    await expect(runSuite({ suite: { name: 'Empty' } }, t.deps)).rejects.toMatchObject({ code: 'config.invalid' });
    expect(t.deps.runWorkflow).not.toHaveBeenCalled();
  });

  it('a runner that throws becomes a failed run', async () => {
    const t = deps();
    t.deps.runWorkflow.mockRejectedValueOnce(new Error('tab gone'));
    const { result } = await runSuite({ suite: { id: 's', name: 'S', workflowIds: ['a', 'b'] } }, t.deps);
    expect(result.runs[0]).toMatchObject({ status: 'failed', error: 'tab gone', workflowName: 'Login' });
    expect(result.runs[1]?.status).toBe('passed');
    expect(result.status).toBe('failed');
  });

  it('builds only the requested report formats', async () => {
    const t = deps({ Cart: 'failed' });
    const loadScreenshot = vi.fn(async () => 'data:image/png;base64,AA');
    const { reports } = await runSuite({ suite: { id: 's', name: 'S', workflowIds: ['a', 'b'] }, formats: ['junit', 'json', 'junit'] }, { ...t.deps, loadScreenshot });
    expect(Object.keys(reports ?? {}).sort()).toEqual(['json', 'junit']);
    expect(reports?.junit).toContain('<failure message="[assert.failed] Assert: nope" type="assert.failed">');
    expect(JSON.parse(reports?.json ?? '{}')).toMatchObject({ schemaVersion: 1, suite: { name: 'S', status: 'failed' } });

    const html = await runSuite({ suite: { id: 's', name: 'S', workflowIds: ['a'] }, formats: ['html'] }, t.deps);
    expect(Object.keys(html.reports ?? {})).toEqual(['html']);
    expect(html.reports?.html).toContain('<title>Suite: S</title>');
  });
});
