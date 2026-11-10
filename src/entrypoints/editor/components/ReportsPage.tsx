import { useMemo, useState } from 'react';
import { loadScreenshot } from '../../../browser/blobStore';
import { durationOf, summarize, toHtmlReport, toJsonReport, toJUnitXml } from '../../../core/report';
import { TRIGGER_LABELS } from '../../../core/runs';
import type { RunRecord } from '../../../core/runs';
import { downloadText } from '../files';
import { registry } from '../registry';
import { ErrorDetails, formatMs } from './ConfigPanel';
import { Screenshot } from './Screenshot';

interface ReportsPageProps {
  runs: RunRecord[];
  onShowOnCanvas(run: RunRecord): void;
  onClear(): void;
}

const blockLabel = (type: string) => registry.get(type)?.label ?? type;

/** Every run, filterable, with step details, screenshots, and exports for CI or for people. */
export function ReportsPage({ runs, onShowOnCanvas, onClear }: ReportsPageProps) {
  const [workflow, setWorkflow] = useState('');
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const workflows = useMemo(() => [...new Map(runs.map((run) => [run.workflowId, run.workflowName])).entries()], [runs]);
  const shown = useMemo(
    () =>
      [...runs]
        .reverse()
        .filter((run) => (!workflow || run.workflowId === workflow) && (!status || run.status === status)),
    [runs, workflow, status],
  );
  const sum = summarize(shown);
  const open = shown.find((run) => run.id === openId) ?? null;

  const exportAs = async (kind: 'json' | 'junit' | 'html') => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    if (kind === 'json') return downloadText(`blockflow-runs-${stamp}.json`, JSON.stringify(toJsonReport(shown), null, 2));
    if (kind === 'junit') return downloadText(`blockflow-junit-${stamp}.xml`, toJUnitXml(shown, { blockLabel }), 'application/xml');
    const screenshots: Record<string, string> = {};
    for (const run of shown) {
      for (const step of run.steps) {
        if (step.screenshot) {
          const shot = await loadScreenshot(step.screenshot).catch(() => undefined);
          if (shot) screenshots[step.screenshot] = shot.dataUrl;
        }
      }
    }
    downloadText(`blockflow-report-${stamp}.html`, toHtmlReport(shown, { blockLabel, screenshots }), 'text/html');
  };

  return (
    <section className="bf-manage">
      <div className="bf-manage-bar">
        <h2>Reports</h2>
        <select value={workflow} onChange={(event) => setWorkflow(event.target.value)} aria-label="Workflow">
          <option value="">All workflows</option>
          {workflows.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Status">
          <option value="">Any result</option>
          <option value="passed">Passed</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
          <option value="interrupted">Interrupted</option>
          <option value="running">Running</option>
        </select>
        <span className="bf-spacer" />
        <button type="button" onClick={() => void exportAs('html')}>
          Export HTML
        </button>
        <button type="button" onClick={() => void exportAs('junit')}>
          Export JUnit XML
        </button>
        <button type="button" onClick={() => void exportAs('json')}>
          Export JSON
        </button>
        <button type="button" className="bf-danger" onClick={onClear}>
          Clear
        </button>
      </div>
      <p className="bf-muted bf-totals">
        {sum.total} runs · <span className="bf-ok">{sum.passed} passed</span> · <span className="bf-error">{sum.failed} failed</span> · {sum.other} other ·{' '}
        {formatMs(sum.durationMs)} in total. Keeps the last 40 runs.
      </p>
      <div className="bf-report">
        <ul className="bf-report-list">
          {shown.map((run) => (
            <li key={run.id}>
              <button type="button" className={run.id === openId ? 'active' : ''} onClick={() => setOpenId(run.id)}>
                <span className={`bf-run-status ${run.status}`}>{run.status}</span>
                <strong>{run.workflowName}</strong>
                <span className="bf-muted">
                  {new Date(run.startedAt).toLocaleString()} · {TRIGGER_LABELS[run.trigger] ?? run.trigger} · {formatMs(durationOf(run))}
                </span>
                {run.error && <span className="bf-error">{run.error}</span>}
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="bf-muted">No runs match.</li>}
        </ul>
        {open && (
          <div className="bf-report-detail">
            <h3>
              {open.workflowName} <span className={`bf-run-status ${open.status}`}>{open.status}</span>
            </h3>
            <p className="bf-muted">
              {new Date(open.startedAt).toLocaleString()} · {TRIGGER_LABELS[open.trigger] ?? open.trigger}
              {open.parentRunId && ' · called by another workflow'} ·{' '}
              {open.usedDebugger && 'Chromium debugger (CDP) · '}
              <button type="button" className="bf-link" onClick={() => onShowOnCanvas(open)}>
                show on canvas
              </button>
            </p>
            {open.error && <p className="bf-error">{open.error}</p>}
            <ol className="bf-report-steps">
              {open.steps.map((step, index) => (
                // Steps of one run have no ids of their own.
                // eslint-disable-next-line react/no-array-index-key
                <li key={index} className={step.status}>
                  <span className={`bf-run-badge ${step.status}`}>{step.status}</span> <strong>{blockLabel(step.blockType)}</strong>
                  {step.durationMs !== undefined && <span className="bf-muted"> · {formatMs(step.durationMs)}</span>}
                  {step.attempts > 1 && <span className="bf-muted"> · {step.attempts} attempts</span>}
                  {step.port && step.port !== 'out' && <span className="bf-muted"> · → {step.port}</span>}
                  {step.childRunId && (
                    <button type="button" className="bf-link" onClick={() => setOpenId(step.childRunId ?? null)}>
                      open called run
                    </button>
                  )}
                  {step.error && <div className="bf-error">{step.error}</div>}
                  <ErrorDetails step={step} />
                  {step.console && step.console.length > 0 && (
                    <details>
                      <summary>Console ({step.console.length})</summary>
                      <pre className="bf-json">{step.console.map((entry) => `[${entry.level}] ${entry.text}${entry.url ? ` (${entry.url})` : ''}`).join('\n')}</pre>
                    </details>
                  )}
                  {step.screenshot && <Screenshot id={step.screenshot} />}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </section>
  );
}
