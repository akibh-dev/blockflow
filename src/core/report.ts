import type { RunRecord, StepRecord } from './runs';

/**
 * Test reports from run records: JUnit XML (what CI tools read) and a self-contained HTML page
 * (screenshots embedded) to send to someone.
 */

export interface ReportOptions {
  /** Block type → label, e.g. "assert" → "Assert". */
  blockLabel(type: string): string;
  /** Screenshot id → data URL, for the HTML report. */
  screenshots?: Record<string, string>;
  title?: string;
}

/** Counts over a list of runs. failed includes interrupted; other = cancelled or still running. */
export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  other: number;
  durationMs: number;
}

/** Run length in ms (0 while it is still running). */
export function durationOf(run: RunRecord): number {
  return run.endedAt ? Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt)) : 0;
}

/** Totals for the report header and JUnit attributes. */
export function summarize(runs: RunRecord[]): RunSummary {
  return {
    total: runs.length,
    passed: runs.filter((run) => run.status === 'passed').length,
    failed: runs.filter((run) => run.status === 'failed' || run.status === 'interrupted').length,
    other: runs.filter((run) => run.status === 'cancelled' || run.status === 'running').length,
    durationMs: runs.reduce((sum, run) => sum + durationOf(run), 0),
  };
}

function xml(text: string): string {
  return text.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char] ?? char);
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

function stepLine(step: StepRecord, options: ReportOptions): string {
  const time = step.durationMs !== undefined ? ` (${step.durationMs} ms)` : '';
  return `${step.status.padEnd(7)} ${options.blockLabel(step.blockType)}${time}${step.error ? ` — ${step.error}` : ''}`;
}

/** One <testsuite> per workflow, one <testcase> per run. */
export function toJUnitXml(runs: RunRecord[], options: ReportOptions): string {
  const byWorkflow = new Map<string, RunRecord[]>();
  for (const run of runs) byWorkflow.set(run.workflowName, [...(byWorkflow.get(run.workflowName) ?? []), run]);
  const total = summarize(runs);
  const suites = [...byWorkflow.entries()].map(([name, list]) => {
    const sum = summarize(list);
    const cases = list.map((run) => {
      const steps = run.steps.map((step) => stepLine(step, options)).join('\n');
      let body = '';
      if (run.status === 'failed' || run.status === 'interrupted') {
        body = `\n      <failure message="${xml(run.error ?? run.status)}" type="${run.status}">${xml(steps)}</failure>`;
      } else if (run.status === 'cancelled') {
        body = `\n      <skipped message="${xml(run.error ?? 'cancelled')}"/>`;
      }
      body += `\n      <system-out>${xml(steps)}</system-out>`;
      return `    <testcase classname="${xml(name)}" name="${xml(`${run.startedAt} (${run.trigger})`)}" time="${seconds(durationOf(run))}">${body}\n    </testcase>`;
    });
    return `  <testsuite name="${xml(name)}" tests="${sum.total}" failures="${sum.failed}" skipped="${sum.other}" time="${seconds(sum.durationMs)}">\n${cases.join('\n')}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${xml(options.title ?? 'BlockFlow')}" tests="${total.total}" failures="${total.failed}" time="${seconds(total.durationMs)}">\n${suites.join('\n')}\n</testsuites>\n`;
}

function html(text: string): string {
  return text.replace(/[<>&"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[char] ?? char);
}

/** A single HTML file, no external resources. */
export function toHtmlReport(runs: RunRecord[], options: ReportOptions): string {
  const sum = summarize(runs);
  const title = options.title ?? 'BlockFlow test report';
  const sections = runs.map((run) => {
    const rows = run.steps
      .map((step) => {
        const shot = step.screenshot ? options.screenshots?.[step.screenshot] : undefined;
        return `<tr class="${step.status}"><td>${html(step.status)}</td><td>${html(options.blockLabel(step.blockType))}</td><td>${step.durationMs ?? ''} ms</td><td>${html(step.error ?? '')}${shot ? `<br><img src="${shot}" alt="Screenshot">` : ''}</td></tr>`;
      })
      .join('');
    return `<section class="${run.status}"><h2><span class="badge ${run.status}">${html(run.status)}</span> ${html(run.workflowName)}</h2>
<p class="meta">${html(new Date(run.startedAt).toLocaleString())} · ${html(run.trigger)} · ${(durationOf(run) / 1000).toFixed(1)} s${run.error ? ` · <b>${html(run.error)}</b>` : ''}</p>
<table><thead><tr><th>Status</th><th>Block</th><th>Time</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${html(title)}</title>
<style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px auto;max-width:1000px;padding:0 16px;color:#1b1e24;background:#f6f7f9}
h1{margin:0 0 4px}.meta{color:#6b7280;margin:4px 0 10px}section{background:#fff;border:1px solid #e2e5ea;border-radius:8px;padding:12px 16px;margin:14px 0}
section.failed,section.interrupted{border-left:5px solid #dc2626}section.passed{border-left:5px solid #16a34a}
h2{font-size:16px;margin:0}table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:4px 6px;border-top:1px solid #eee;vertical-align:top}
tr.failed td:first-child{color:#dc2626;font-weight:600}tr.passed td:first-child{color:#16a34a}tr.handled td:first-child{color:#d97706}
.badge{font-size:12px;padding:1px 8px;border-radius:999px;background:#eee}.badge.passed{background:#dcfce7;color:#166534}.badge.failed,.badge.interrupted{background:#fee2e2;color:#991b1b}
img{max-width:100%;margin-top:6px;border:1px solid #ddd;border-radius:4px}.totals span{margin-right:14px}
</style></head><body>
<h1>${html(title)}</h1>
<p class="meta totals"><span>${sum.total} runs</span><span style="color:#16a34a">${sum.passed} passed</span><span style="color:#dc2626">${sum.failed} failed</span><span>${sum.other} other</span><span>${(sum.durationMs / 1000).toFixed(1)} s</span></p>
${sections.join('\n')}
</body></html>
`;
}
