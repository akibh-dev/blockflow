import { describe, expect, it } from 'vitest';
import type { Suite } from '../../src/core/bridgeProtocol';
import type { RunRecord } from '../../src/core/runs';
import {
  buildSuiteResult,
  createSuite,
  failingStep,
  findSuite,
  isSavedSuite,
  moveItem,
  normaliseSuites,
  skippedNames,
  suiteStatus,
  suiteSummary,
  validateSuite,
  validateSuites,
} from '../../src/core/suite';

const run = (name: string, status: RunRecord['status']): RunRecord => ({
  id: `r-${name}`,
  workflowId: name,
  workflowName: name,
  trigger: 'manual',
  status,
  startedAt: '2026-11-01T10:00:00.000Z',
  endedAt: '2026-11-01T10:00:01.000Z',
  steps: [],
});
const codes = (issues: { code: string }[]) => issues.map((issue) => issue.code);

describe('validateSuite', () => {
  it('accepts a named suite with known workflows', () => {
    expect(validateSuite({ id: 's', name: 'Smoke', workflowIds: ['a', 'b'] }, ['a', 'b'])).toEqual([]);
  });

  it('needs a name and at least one workflow', () => {
    expect(codes(validateSuite({ id: 's', name: '  ', workflowIds: [] }))).toEqual(['suite.name.missing', 'suite.empty']);
    // An inline suite may have only sources.
    expect(validateSuite({ name: 'Inline', sources: [{}] })).toEqual([]);
  });

  it('reports repeated and unknown workflow ids with their path', () => {
    const issues = validateSuite({ id: 's', name: 'S', workflowIds: ['a', 'a', 'x'] }, ['a']);
    expect(issues.map((issue) => [issue.code, issue.path])).toEqual([
      ['suite.workflow.duplicate', '/workflowIds/1'],
      ['suite.workflow.unknown', '/workflowIds/2'],
    ]);
  });

  it('does not check ids without a workflow list', () => {
    expect(validateSuite({ name: 'S', workflowIds: ['anything'] })).toEqual([]);
  });

  it('rejects wrong shapes', () => {
    expect(codes(validateSuite(null as unknown as Suite))).toEqual(['suite.invalid']);
    expect(codes(validateSuite({ name: 'S', workflowIds: 'a' as unknown as string[], sources: {} as unknown as unknown[] }))).toEqual([
      'suite.workflowIds.invalid',
      'suite.sources.invalid',
      'suite.empty',
    ]);
  });

  it('validateSuites: unique ids and names', () => {
    const suites: Suite[] = [
      { id: '1', name: 'Smoke', workflowIds: ['a'] },
      { id: '1', name: 'smoke', workflowIds: ['a'] },
    ];
    expect(codes(validateSuites(suites, ['a']))).toEqual(['suite.id.duplicate', 'suite.name.duplicate']);
  });
});

describe('suite helpers', () => {
  it('status: passed only when everything ran and passed', () => {
    expect(suiteStatus([run('a', 'passed')], [])).toBe('passed');
    expect(suiteStatus([run('a', 'passed'), run('b', 'cancelled')], [])).toBe('failed');
    expect(suiteStatus([run('a', 'passed')], ['b'])).toBe('failed');
    expect(suiteStatus([], [])).toBe('failed');
  });

  it('skipped names and the failing step', () => {
    expect(skippedNames(['a', 'b', 'c'], 1)).toEqual(['b', 'c']);
    const failed: RunRecord = {
      ...run('a', 'failed'),
      steps: [
        { nodeId: '1', blockType: 'click', status: 'handled', startedAt: '', attempts: 1, error: 'first' },
        { nodeId: '2', blockType: 'assert', status: 'failed', startedAt: '', attempts: 1, error: 'real', code: 'assert.failed' },
        { nodeId: '3', blockType: 'log', status: 'skipped', startedAt: '', attempts: 0 },
      ],
    };
    expect(failingStep(failed)?.nodeId).toBe('2');
    expect(failingStep(run('b', 'passed'))).toBeUndefined();
  });

  it('builds a result with suiteId only for saved suites, and sums it up', () => {
    const parts = { startedAt: '2026-11-01T10:00:00.000Z', finishedAt: '2026-11-01T10:00:03.000Z', runs: [run('a', 'passed'), run('b', 'failed')], skipped: ['c'] };
    const saved = buildSuiteResult({ ...parts, suite: { id: 's1', name: 'S', workflowIds: [] } });
    expect(saved).toMatchObject({ suiteId: 's1', name: 'S', status: 'failed', skipped: ['c'] });
    expect('suiteId' in buildSuiteResult({ ...parts, suite: { name: 'Inline' } })).toBe(false);
    expect(suiteSummary(saved)).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1, durationMs: 3000 });
  });

  it('normalises stored suites', () => {
    expect(normaliseSuites('nope')).toEqual([]);
    expect(normaliseSuites([null, { name: 'no id' }, { id: 'a', workflowIds: ['x', 3], stopOnFailure: 'yes' }, { id: 'b', name: 'B', workflowIds: [], stopOnFailure: true }])).toEqual([
      { id: 'a', name: 'Untitled suite', workflowIds: ['x'] },
      { id: 'b', name: 'B', workflowIds: [], stopOnFailure: true },
    ]);
  });

  it('creates, finds and reorders', () => {
    const first = createSuite([]);
    expect(first.name).toBe('Suite');
    const second = createSuite([first]);
    expect(second.name).toBe('Suite 2');
    expect(second.id).not.toBe(first.id);
    expect(isSavedSuite(first)).toBe(true);
    expect(isSavedSuite({ name: 'x' })).toBe(false);
    expect(findSuite([first, second], { name: 'suite 2' })).toBe(second);
    expect(findSuite([first, second], { suiteId: first.id })).toBe(first);
    expect(findSuite([first], {})).toBeUndefined();
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });
});
