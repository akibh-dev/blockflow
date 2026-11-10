import { describe, expect, it } from 'vitest';
import { summarize, toHtmlReport, toJUnitXml } from '../../src/core/report';
import type { RunRecord } from '../../src/core/runs';

const run = (id: string, status: RunRecord['status'], extra: Partial<RunRecord> = {}): RunRecord => ({
  id,
  workflowId: 'w',
  workflowName: 'Login <test>',
  trigger: 'manual',
  status,
  startedAt: '2026-10-23T10:00:00.000Z',
  endedAt: '2026-10-23T10:00:02.500Z',
  steps: [
    { nodeId: 'a', blockType: 'open-url', status: 'passed', startedAt: '', attempts: 1, durationMs: 400 },
    { nodeId: 'b', blockType: 'assert', status: status === 'failed' ? 'failed' : 'passed', startedAt: '', attempts: 1, durationMs: 90, ...(status === 'failed' ? { error: 'Expected "a" & got "b"', screenshot: 's1' } : {}) },
  ],
  ...extra,
});
const options = { blockLabel: (type: string) => (type === 'assert' ? 'Assert' : 'Open Tab'), screenshots: { s1: 'data:image/jpeg;base64,AAA' } };

describe('reports', () => {
  const runs = [run('1', 'passed'), run('2', 'failed', { error: 'Assert: Expected "a" & got "b"' }), run('3', 'cancelled')];

  it('summarizes', () => {
    expect(summarize(runs)).toEqual({ total: 3, passed: 1, failed: 1, other: 1, durationMs: 7500 });
  });

  it('JUnit: suites per workflow, failures with steps, escaped', () => {
    const xml = toJUnitXml(runs, options);
    expect(xml).toContain('<testsuite name="Login &lt;test&gt;" tests="3" failures="1" skipped="1" time="7.500">');
    expect(xml).toContain('<failure message="Assert: Expected &quot;a&quot; &amp; got &quot;b&quot;" type="failed">');
    expect(xml).toContain('<skipped message="cancelled"/>');
    expect(xml).toContain('failed  Assert (90 ms) — Expected &quot;a&quot; &amp; got &quot;b&quot;');
    expect(xml.startsWith('<?xml')).toBe(true);
  });

  it('HTML: self-contained, escaped, with screenshots', () => {
    const page = toHtmlReport(runs, options);
    expect(page).toContain('<img src="data:image/jpeg;base64,AAA"');
    expect(page).toContain('Login &lt;test&gt;');
    expect(page).toContain('1 passed');
    expect(page).not.toMatch(/<(script|link)\b/);
  });

  it('shows whether a run used the Chromium debugger', () => {
    expect(toHtmlReport([run('cdp', 'passed', { usedDebugger: true })], options)).toContain('Chromium debugger (CDP)');
    expect(toHtmlReport([run('plain', 'passed')], options)).not.toContain('Chromium debugger (CDP)');
  });
});
