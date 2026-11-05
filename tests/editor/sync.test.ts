import { describe, expect, it } from 'vitest';
import { mergeStoredWorkflows, sameData, syncBase } from '../../src/entrypoints/editor/sync';
import type { Workflow } from '../../src/core/types';

const wf = (id: string, name = id): Workflow => ({ schemaVersion: 1, id, name, enabled: false, nodes: [], edges: [] });

describe('mergeStoredWorkflows (two editor tabs)', () => {
  it("takes the other tab's version of workflows this tab did not touch", () => {
    const base = syncBase([wf('a'), wf('b')]);
    const merged = mergeStoredWorkflows([wf('a'), wf('b')], base, [wf('a', 'A renamed'), wf('b')]);
    expect(merged.map((w) => w.name)).toEqual(['A renamed', 'b']);
  });

  it('keeps its own unsaved edits, and its new workflows', () => {
    const base = syncBase([wf('a'), wf('b')]);
    const merged = mergeStoredWorkflows([wf('a', 'mine'), wf('b'), wf('new')], base, [wf('a', 'theirs'), wf('b', 'B2'), wf('c')]);
    expect(merged.map((w) => w.name)).toEqual(['mine', 'B2', 'c', 'new']);
  });

  it('drops workflows deleted elsewhere unless edited here', () => {
    const base = syncBase([wf('a'), wf('b')]);
    expect(mergeStoredWorkflows([wf('a'), wf('b')], base, [wf('a')]).map((w) => w.id)).toEqual(['a']);
    expect(mergeStoredWorkflows([wf('a'), wf('b', 'edited')], base, [wf('a')]).map((w) => w.id)).toEqual(['a', 'b']);
  });

  it('an editor opened before the samples were seeded keeps its new workflow and gains the samples', () => {
    const merged = mergeStoredWorkflows([wf('first')], syncBase([]), [wf('sample1'), wf('sample2')]);
    expect(merged.map((w) => w.id)).toEqual(['sample1', 'sample2', 'first']);
  });

  it('ignores key order: storage does not keep it', () => {
    const local = wf('a');
    const stored = { edges: [], nodes: [], enabled: false, name: 'a', id: 'a', schemaVersion: 1 } as Workflow;
    expect(sameData(local, stored)).toBe(true);
    // Not edited here, so the stored copy wins, and it is the same data.
    expect(mergeStoredWorkflows([local], syncBase([local]), [stored])).toEqual([stored]);
  });
});
