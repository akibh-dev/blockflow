import { describe, expect, it, vi } from 'vitest';
import { WorkflowRunner } from '../../src/core/engine';
import { createDefaultRegistry } from '../../src/core/blocks';
import type { BlockDefinition, Host } from '../../src/core/types';
import type { RunRecord } from '../../src/core/runs';
import { FakeHost, flow } from '../helpers/fakeHost';

function setup(invoke: NonNullable<BlockDefinition['run']>) {
  const base: Host = new FakeHost();
  const notify = vi.fn(async () => {});
  const finish = vi.fn(async (_id: string): Promise<{ usedDebugger?: boolean }> => ({ usedDebugger: true }));
  const opened: string[] = [];
  base.forRun = (id) => {
    opened.push(id);
    return Object.assign(Object.create(base) as Host, { notify, finishRun: finish });
  };
  const registry = createDefaultRegistry();
  registry.register({ type: 'probe', label: 'Probe', description: 'Test run resources', icon: '', accent: '', defaultConfig: {}, fields: [], outputs: [], run: invoke });
  const records: RunRecord[] = [];
  const runner = new WorkflowRunner({ workflow: flow([{ id: 'probe', type: 'probe' }], []), registry, host: base, onRun: (record) => records.push(record) });
  return { runner, base, registry, records, notify, finish, opened };
}

describe('run-scoped Host resource lifecycle', () => {
  it('bounds and masks step console diagnostics before publishing or exporting them', async () => {
    const h = setup(async () => ({}));
    h.base.secrets.all = async () => ({ token: 'sensitive-token' });
    const begin = vi.fn();
    const finish = vi.fn(() => Array.from({ length: 120 }, () => ({ level: 'error', text: `sensitive-token ${'x'.repeat(2500)}`, timestamp: 1 })));
    h.base.diagnostics = { beginStep: begin, finishStep: finish };
    const record = await h.runner.runOnce();
    expect(begin).toHaveBeenCalledWith('probe');
    expect(record.steps[0]?.console).toHaveLength(100);
    expect(JSON.stringify(record)).not.toContain('sensitive-token');
    expect(record.steps[0]?.console?.every((entry) => entry.text.length <= 2000)).toBe(true);
  });
  it('hands blocks the scoped Host and cleans it before publishing the final record', async () => {
    const h = setup(async (ctx) => { await ctx.host.notify({ title: 'Scoped', message: ctx.runId }); return {}; });
    let finalized = false;
    h.finish.mockImplementation(async () => { finalized = true; return { usedDebugger: true }; });
    const record = await h.runner.runOnce();
    expect(h.opened).toEqual([record.id]);
    expect(h.notify).toHaveBeenCalledExactlyOnceWith({ title: 'Scoped', message: record.id });
    expect(h.finish).toHaveBeenCalledExactlyOnceWith(record.id);
    expect(finalized).toBe(true);
    expect(record).toMatchObject({ status: 'passed', usedDebugger: true });
    expect(h.records.at(-1)).toMatchObject({ status: 'passed', usedDebugger: true });
  });

  it('cleans up a failing step and preserves its failure', async () => {
    const h = setup(async () => { throw new Error('probe failed'); });
    const record = await h.runner.runOnce();
    expect(record.status).toBe('failed'); expect(record.error).toContain('probe failed');
    expect(h.finish).toHaveBeenCalledExactlyOnceWith(record.id);
  });

  it('awaits cleanup before publishing completion and refuses outputs while cleanup is pending', async () => {
    let late!: () => Promise<void>;
    let release!: () => void;
    let cleaning!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const began = new Promise<void>((resolve) => { cleaning = resolve; });
    const h = setup(async (ctx) => { late = async () => { await ctx.emit({ late: true }); }; return {}; });
    h.finish.mockImplementation(async () => { cleaning(); await gate; return {}; });
    const running = h.runner.runOnce();
    await began;
    expect(h.records.at(-1)?.status).toBe('running');
    await expect(late()).rejects.toThrow('run has ended');
    release();
    expect((await running).status).toBe('passed');
  });

  it('cleans up after a timeout and fences late callbacks', async () => {
    let late!: () => Promise<void>;
    const h = setup(async (ctx) => {
      await new Promise<void>((resolve) => { late = async () => { resolve(); await ctx.emit({ late: true }); }; });
      return {};
    });
    const record = await h.runner.runOnce();
    expect(record.status).toBe('failed'); expect(record.steps[0]?.code).toBe('timeout');
    expect(h.finish).toHaveBeenCalledExactlyOnceWith(record.id);
    await expect(late()).rejects.toThrow('timed out');
    expect(record.steps).toHaveLength(1);
  });

  it('cleans up cancelled runs even when no step started', async () => {
    const h = setup(async () => ({}));
    const runner = new WorkflowRunner({ workflow: flow([{ id: 'probe', type: 'probe' }], []), registry: h.registry, host: h.base, isCancelled: () => true });
    const record = await runner.runOnce();
    expect(record.status).toBe('cancelled'); expect(record.steps).toHaveLength(0);
    expect(h.finish).toHaveBeenCalledExactlyOnceWith(record.id);
  });

  it('finishes resources when secret loading fails before any step', async () => {
    const h = setup(async () => ({}));
    h.base.secrets.all = async () => { throw new Error('cannot load secrets'); };
    const record = await h.runner.runOnce();
    expect(record.status).toBe('failed'); expect(record.steps).toHaveLength(0);
    expect(h.finish).toHaveBeenCalledExactlyOnceWith(record.id);
  });

  it('reports cleanup failures instead of a false pass', async () => {
    const h = setup(async () => ({}));
    h.finish.mockRejectedValue(new Error('cannot detach'));
    const record = await h.runner.runOnce();
    expect(record.status).toBe('failed'); expect(record.error).toContain('Run cleanup failed: cannot detach');
  });

  it('keeps the original failure when cleanup also fails', async () => {
    const h = setup(async () => { throw new Error('original failure'); });
    h.finish.mockRejectedValue(new Error('cleanup failed'));
    expect((await h.runner.runOnce()).error).toContain('original failure');
  });

  it('gives a child run its own lifecycle and closes it before its parent', async () => {
    const h = setup(async () => ({}));
    const child = flow([{ id: 'child', type: 'probe' }], []);
    h.base.workflows.get = async () => child;
    const parent = flow([{ id: 'call', type: 'run-workflow', config: { workflow: child.id } }], []);
    const runner = new WorkflowRunner({ workflow: parent, registry: h.registry, host: h.base });
    const record = await runner.runOnce();
    expect(record.status).toBe('passed');
    expect(h.opened).toHaveLength(2);
    expect(h.finish.mock.calls.map(([id]) => id)).toEqual([...h.opened].reverse());
  });

  it('omits the CDP marker when resources were not used, and supports hosts without lifecycle hooks', async () => {
    const h = setup(async () => ({}));
    h.finish.mockResolvedValue({});
    expect((await h.runner.runOnce()).usedDebugger).toBeUndefined();
    delete h.base.forRun; delete h.base.finishRun;
    expect((await h.runner.runOnce()).status).toBe('passed');
  });
});
