// @vitest-environment jsdom
// jsdom only for its DOMParser (to check the JUnit XML is well-formed); the code under test is pure.
import { describe, expect, it } from 'vitest';
import type { SuiteResult } from '../../src/core/bridgeProtocol';
import { SUITE_REPORT_SCHEMA_VERSION, toSuiteHtml, toSuiteJson, toSuiteJUnit } from '../../src/core/report';
import type { RunRecord } from '../../src/core/runs';

const run = (name: string, status: RunRecord['status'], extra: Partial<RunRecord> = {}): RunRecord => ({
  id: `r-${name}`,
  workflowId: name,
  workflowName: name,
  trigger: 'manual',
  status,
  startedAt: '2026-11-01T10:00:00.000Z',
  endedAt: '2026-11-01T10:00:01.500Z',
  steps: [
    { nodeId: 'a', blockType: 'open-url', status: 'passed', startedAt: '', attempts: 1, durationMs: 400 },
    ...(status === 'failed'
      ? [{ nodeId: 'b', blockType: 'assert', status: 'failed' as const, startedAt: '', attempts: 1, durationMs: 90, error: 'Expected "a" & got <b>', code: 'assert.failed' as const, screenshot: 's1' }]
      : []),
  ],
  ...extra,
});
const options = { blockLabel: (type: string) => (type === 'assert' ? 'Assert' : 'Open Tab'), screenshots: { s1: 'data:image/jpeg;base64,AAA' } };
const result: SuiteResult = {
  suiteId: 's1',
  name: 'Smoke & <checkout>',
  status: 'failed',
  startedAt: '2026-11-01T10:00:00.000Z',
  finishedAt: '2026-11-01T10:00:04.000Z',
  runs: [run('Login', 'passed'), run('Cart "add"', 'failed', { error: 'Assert: Expected "a" & got <b>' })],
  skipped: ['Pay $& go'],
};

describe('suite reports', () => {
  it('JUnit: one testsuite, one testcase per workflow, well-formed and escaped', () => {
    const text = toSuiteJUnit(result, options);
    expect(text.startsWith('<?xml')).toBe(true);
    // Parse it: well-formed XML or this throws / reports errors.
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    expect(doc.getElementsByTagName('parsererror').length).toBe(0);
    // (the check itself works: broken XML gives a parsererror)
    expect(new DOMParser().parseFromString('<a b="<">', 'text/xml').getElementsByTagName('parsererror').length).toBeGreaterThan(0);
    const suites = doc.getElementsByTagName('testsuite');
    expect(suites.length).toBe(1);
    const suite = suites[0]!;
    expect(suite.getAttribute('name')).toBe('Smoke & <checkout>');
    expect(suite.getAttribute('tests')).toBe('3');
    expect(suite.getAttribute('failures')).toBe('1');
    expect(suite.getAttribute('skipped')).toBe('1');
    expect(suite.getAttribute('time')).toBe('4.000');
    const cases = doc.getElementsByTagName('testcase');
    expect(Array.from({ length: cases.length }, (_, i) => cases[i]!.getAttribute('name'))).toEqual(['Login', 'Cart "add"', 'Pay $& go']);
    expect(cases[0]!.getAttribute('classname')).toBe('Smoke & <checkout>');
    expect(cases[0]!.getAttribute('time')).toBe('1.500');
    const failure = cases[1]!.getElementsByTagName('failure')[0]!;
    expect(failure.getAttribute('message')).toBe('[assert.failed] Assert: Expected "a" & got <b>');
    expect(failure.getAttribute('type')).toBe('assert.failed');
    expect(failure.textContent).toContain('failed  Assert (90 ms) — Expected "a" & got <b> [assert.failed]');
    expect(cases[2]!.getElementsByTagName('skipped').length).toBe(1);
    expect(cases[0]!.getElementsByTagName('failure').length).toBe(0);
  });

  it('JUnit: a run that failed without a failing step uses the run error', () => {
    const text = toSuiteJUnit({ ...result, runs: [run('X', 'interrupted', { error: 'worker stopped', steps: [] })], skipped: [] }, options);
    expect(text).toContain('<failure message="worker stopped" type="interrupted">');
  });

  it('HTML: self-contained, escaped, a section per workflow, skipped listed', () => {
    const page = toSuiteHtml(result, options);
    expect(page).not.toMatch(/<(script|link)\b/);
    expect(page).toContain('<title>Suite: Smoke &amp; &lt;checkout&gt;</title>');
    expect(page).toContain('Cart &quot;add&quot;');
    expect(page).not.toContain('got <b>');
    expect(page).toContain('got &lt;b&gt;');
    expect(page.match(/<section class="(passed|failed)">/g)).toHaveLength(2);
    expect(page).toContain('<li>Pay $&amp; go</li>');
    expect(page).toContain('3 workflows');
    expect(page).toContain('1 skipped');
    expect(page).toContain('<img src="data:image/jpeg;base64,AAA"');
  });

  it('JSON: versioned, with the suite outcome and runs', () => {
    const json = toSuiteJson(result, new Date('2026-11-01T11:00:00.000Z'));
    expect(json.schemaVersion).toBe(SUITE_REPORT_SCHEMA_VERSION);
    expect(json.$schema).toMatch(/suite-report\.schema\.json$/);
    expect(json.generatedAt).toBe('2026-11-01T11:00:00.000Z');
    expect(json.suite).toEqual({ id: 's1', name: result.name, status: 'failed', startedAt: result.startedAt, finishedAt: result.finishedAt, skipped: ['Pay $& go'] });
    expect(json.summary).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1, durationMs: 4000 });
    expect(json.runs).toHaveLength(2);
  });
});
