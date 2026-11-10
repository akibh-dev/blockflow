import { describe, expect, it } from 'vitest';
import { toHtmlReport, toJsonReport } from '../../src/core/report';
import type { RunRecord } from '../../src/core/runs';

// M5.1: trace pictures in the HTML report, trace fields kept in the JSON report.
const run: RunRecord = {
  id: 'r', workflowId: 'w', workflowName: 'Traced', trigger: 'manual', status: 'passed',
  startedAt: '2026-11-10T10:00:00.000Z', endedAt: '2026-11-10T10:00:01.000Z', mode: { trace: true },
  steps: [{
    nodeId: 'n', blockType: 'click', status: 'passed', startedAt: '2026-11-10T10:00:00.000Z', attempts: 1,
    trace: { before: 'b1', after: 'a1', box: { x: 100, y: 50, width: 200, height: 25 }, viewport: { width: 1000, height: 500 }, url: 'https://example.test/<x>', network: { requests: 3, failed: 1 } },
  }],
};

describe('report with traces', () => {
  it('HTML embeds before/after with the box over the after picture when screenshots are on', () => {
    const page = toHtmlReport([run], { blockLabel: (type) => type, screenshots: { b1: 'data:image/jpeg;base64,BEFORE', a1: 'data:image/jpeg;base64,AFTER' } });
    expect(page).toContain('data:image/jpeg;base64,BEFORE');
    expect(page).toContain('data:image/jpeg;base64,AFTER');
    expect(page).toContain('left:10.00%;top:10.00%;width:20.00%;height:5.00%');
    expect(page).toContain('https://example.test/&lt;x&gt;');
    expect(page).toContain('Network: 3 requests, 1 failed');
    expect(page).toContain('traced');
  });

  it('without embedded pictures there are no images, but URL and network stay', () => {
    const page = toHtmlReport([run], { blockLabel: (type) => type });
    expect(page).not.toContain('<img');
    expect(page).toContain('Network: 3 requests');
  });

  it('JSON keeps the trace and mode as stored', () => {
    const report = toJsonReport([run]);
    expect(report.runs[0]!.steps[0]!.trace).toEqual(run.steps[0]!.trace);
    expect(report.runs[0]!.mode).toEqual({ trace: true });
  });
});
