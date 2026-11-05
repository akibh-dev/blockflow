import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../src/core/blocks';
import { sampleWorkflows } from '../../src/core/samples';
import { parseTimerKey, makeTimerKey, workflowTimerPrefix } from '../../src/core/timerKey';
import { validateWorkflow } from '../../src/core/validate';
import { uid } from '../../src/core/id';
import { createWorkflow, diffWorkflows, rootSignature } from '../../src/core/workflow';
import type { Workflow } from '../../src/core/types';
import { flow } from '../helpers/fakeHost';

const base = () =>
  flow(
    [
      { id: 'a', type: 'timer', config: { seconds: 30 } },
      { id: 'b', type: 'open-url', config: { url: 'https://example.com' } },
    ],
    [['a', 'b']],
  );

const clone = (wf: Workflow): Workflow => JSON.parse(JSON.stringify(wf)) as Workflow;

describe('diffWorkflows', () => {
  it('starts a newly enabled workflow', () => {
    const before = base();
    before.enabled = false;
    const after = clone(before);
    after.enabled = true;
    expect(diffWorkflows([before], [after])).toEqual({ start: [after.id], restart: [], stop: [], removed: [] });
  });

  it('starts an enabled workflow that did not exist before', () => {
    const wf = base();
    expect(diffWorkflows(undefined, [wf])).toEqual({ start: [wf.id], restart: [], stop: [], removed: [] });
  });

  it('stops a workflow that was disabled or deleted', () => {
    const before = base();
    const disabled = clone(before);
    disabled.enabled = false;
    expect(diffWorkflows([before], [disabled])).toEqual({ start: [], restart: [], stop: [before.id], removed: [] });
    expect(diffWorkflows([before], [])).toEqual({ start: [], restart: [], stop: [before.id], removed: [before.id] });
    // Deleting a workflow that is off: nothing to stop, but its state and timers go.
    expect(diffWorkflows([disabled], [])).toEqual({ start: [], restart: [], stop: [], removed: [before.id] });
  });

  it('restarts (without running plain start blocks) when a start block changes', () => {
    const before = base();
    const edited = clone(before);
    edited.nodes[0]!.config = { seconds: 45 };
    expect(diffWorkflows([before], [edited])).toEqual({ start: [], restart: [before.id], stop: [], removed: [] });
    const newRoot = clone(before);
    newRoot.edges = [];
    expect(diffWorkflows([before], [newRoot])).toEqual({ start: [], restart: [before.id], stop: [], removed: [] });
  });

  it('does not restart when only later blocks change: runs read them from storage', () => {
    const before = base();
    const edited = clone(before);
    edited.nodes[1]!.config = { url: 'https://example.org' };
    edited.nodes[1]!.step = { retries: 2 };
    expect(diffWorkflows([before], [edited])).toEqual({ start: [], restart: [], stop: [], removed: [] });
  });

  it('does not restart when only positions or the name change', () => {
    const before = base();
    const moved = clone(before);
    moved.nodes[0]!.position = { x: 999, y: 999 };
    moved.name = 'Renamed';
    expect(diffWorkflows([before], [moved])).toEqual({ start: [], restart: [], stop: [], removed: [] });
  });

  it('ignores disabled workflows', () => {
    const before = base();
    before.enabled = false;
    const edited = clone(before);
    edited.nodes[0]!.config = { seconds: 45 };
    expect(diffWorkflows([before], [edited])).toEqual({ start: [], restart: [], stop: [], removed: [] });
    expect(diffWorkflows(undefined, undefined)).toEqual({ start: [], restart: [], stop: [], removed: [] });
  });
});

describe('rootSignature', () => {
  it('does not depend on node order', () => {
    const wf = base();
    const reordered = clone(wf);
    reordered.nodes.reverse();
    expect(rootSignature(reordered)).toBe(rootSignature(wf));
  });
});

describe('createWorkflow', () => {
  it('creates an empty, disabled workflow with a unique id', () => {
    const one = createWorkflow('A');
    const two = createWorkflow('B');
    expect(one.enabled).toBe(false);
    expect(one.nodes).toEqual([]);
    expect(one.id === two.id).toBe(false);
  });
});

describe('sampleWorkflows', () => {
  it('ships valid, disabled examples', () => {
    const registry = createDefaultRegistry();
    const samples = sampleWorkflows();
    expect(samples).toHaveLength(2);
    for (const sample of samples) {
      expect(sample.enabled).toBe(false);
      const problems = validateWorkflow(sample, registry).filter((issue) => issue.level === 'error');
      expect(problems).toEqual([]);
      // Only settings the block knows (no legacy keys such as Open Tab's old `newTab`).
      for (const node of sample.nodes) {
        const known = (registry.get(node.type)?.fields ?? []).map((field) => field.key);
        expect(Object.keys(node.config).filter((key) => !known.includes(key)), node.type).toEqual([]);
      }
    }
  });
});

describe('timer keys', () => {
  it('round-trips, including names that contain separators', () => {
    const key = makeTimerKey('wf', 'node', 'delay:abc::def');
    expect(parseTimerKey(key)).toEqual({ workflowId: 'wf', nodeId: 'node', name: 'delay:abc::def' });
    expect(key.startsWith(workflowTimerPrefix('wf'))).toBe(true);
  });

  it('rejects keys that are not ours', () => {
    expect(parseTimerKey('something-else')).toBeNull();
    expect(parseTimerKey('bf::only-two')).toBeNull();
  });
});

describe('uid', () => {
  it('makes unique UUID-shaped ids', () => {
    const a = uid();
    const b = uid();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a === b).toBe(false);
  });

  it('still works where crypto.randomUUID is unavailable (insecure pages)', () => {
    const original = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      const id = uid();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(uid() === id).toBe(false);
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', { value: original, configurable: true });
    }
  });
});
