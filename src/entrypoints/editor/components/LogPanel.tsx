import { useEffect, useRef, useState } from 'react';
import type { RunRecord } from '../../../core/runs';
import type { LogEntry } from '../../../core/types';
import { formatMs } from './ConfigPanel';

interface LogPanelProps {
  entries: LogEntry[];
  /** Label for a log line's block, e.g. "Timer". */
  labelFor(entry: LogEntry): string;
  showAll: boolean;
  onToggleAll(next: boolean): void;
  onClear(): void;
  runs: RunRecord[];
  /** Run shown on the canvas and in the step inspector. */
  inspectedRunId: string | undefined;
  onInspect(runId: string): void;
  onClearRuns(): void;
  workflowName(id: string): string;
}

/**
 * Bottom panel with two tabs: "Run log" (log lines, auto-scrolled to the end) and "Runs" (newest
 * first; clicking one shows it on the canvas and in the step inspector). Purely presentational:
 * filtering by workflow and clearing are done by `Editor` through the props.
 */
export function LogPanel(props: LogPanelProps) {
  const { entries, labelFor, showAll, onToggleAll, onClear, runs, inspectedRunId, onInspect, onClearRuns } = props;
  const [tab, setTab] = useState<'log' | 'runs'>('log');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (tab === 'log') endRef.current?.scrollIntoView({ block: 'end' });
  }, [entries.length, tab]);

  return (
    <section className="bf-logs">
      <header>
        <nav className="bf-tabs" aria-label="Bottom panel">
          <button type="button" className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>
            Run log
          </button>
          <button type="button" className={tab === 'runs' ? 'active' : ''} onClick={() => setTab('runs')}>
            Runs ({runs.length})
          </button>
        </nav>
        <label>
          <input type="checkbox" checked={showAll} onChange={(event) => onToggleAll(event.target.checked)} /> all workflows
        </label>
        <button type="button" className="bf-link" onClick={tab === 'log' ? onClear : onClearRuns}>
          Clear
        </button>
      </header>
      {tab === 'log' ? (
        <div className="bf-log-lines">
          {entries.length === 0 && <p className="bf-muted">Nothing yet. Press Run, or turn the workflow on and watch it work.</p>}
          {entries.map((entry, index) => (
            <div key={`${entry.ts}-${index}`} className={`bf-log ${entry.level}`}>
              <time>{new Date(entry.ts).toLocaleTimeString()}</time>
              <span className="bf-log-label">{labelFor(entry)}</span>
              <span>{entry.message}</span>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      ) : (
        <div className="bf-log-lines bf-runs">
          {runs.length === 0 && <p className="bf-muted">No runs yet. Press Run to try the workflow once.</p>}
          {[...runs].reverse().map((run) => (
            <button
              type="button"
              key={run.id}
              className={`bf-run-row${run.id === inspectedRunId ? ' active' : ''}`}
              onClick={() => onInspect(run.id)}
              title="Show this run on the canvas"
            >
              <span className={`bf-run-status ${run.status}`}>{run.status}</span>
              <time>{new Date(run.startedAt).toLocaleTimeString()}</time>
              {showAll && <span className="bf-log-label">{props.workflowName(run.workflowId)}</span>}
              <span className="bf-muted">{run.trigger === 'manual' ? 'Run button' : run.trigger === 'timer' ? 'schedule' : 'turned on'}</span>
              <span>
                {run.steps.length + (run.droppedSteps ?? 0)} steps
                {run.endedAt && ` · ${formatMs(Date.parse(run.endedAt) - Date.parse(run.startedAt))}`}
              </span>
              {run.error && <span className="bf-error">{run.error}</span>}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
