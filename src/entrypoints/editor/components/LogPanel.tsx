import { useEffect, useRef } from 'react';
import type { LogEntry } from '../../../core/types';

interface LogPanelProps {
  entries: LogEntry[];
  /** Label for a log line's block, e.g. "Timer". */
  labelFor(entry: LogEntry): string;
  showAll: boolean;
  onToggleAll(next: boolean): void;
  onClear(): void;
}

export function LogPanel({ entries, labelFor, showAll, onToggleAll, onClear }: LogPanelProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [entries.length]);

  return (
    <section className="bf-logs">
      <header>
        <strong>Run log</strong>
        <label>
          <input type="checkbox" checked={showAll} onChange={(event) => onToggleAll(event.target.checked)} /> all workflows
        </label>
        <button type="button" className="bf-link" onClick={onClear}>
          Clear
        </button>
      </header>
      <div className="bf-log-lines">
        {entries.length === 0 && <p className="bf-muted">Nothing yet. Turn the workflow on and watch it work.</p>}
        {entries.map((entry, index) => (
          <div key={`${entry.ts}-${index}`} className={`bf-log ${entry.level}`}>
            <time>{new Date(entry.ts).toLocaleTimeString()}</time>
            <span className="bf-log-label">{labelFor(entry)}</span>
            <span>{entry.message}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </section>
  );
}
