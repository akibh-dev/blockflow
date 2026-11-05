import { useMemo, useState } from 'react';
import type { RunRecord } from '../../../core/runs';
import type { Workflow } from '../../../core/types';
import { registry } from '../registry';
import { ImportButton } from './ImportButton';
import { NewMenu } from './NewMenu';
import type { WorkflowActions } from './WorkflowActions';

interface WorkflowsPageProps extends WorkflowActions {
  workflows: Workflow[];
  activeId: string | null;
  /** Run history (`bf:runs`): the source of "Last activity". */
  runs: RunRecord[];
  /** Problems per workflow id that stop it from being switched on. */
  errorCounts: Map<string, number>;
  onSetAll(enabled: boolean): void;
}

function blockSummary(workflow: Workflow): string {
  const labels = workflow.nodes.map((node) => registry.get(node.type)?.icon ?? '?');
  return labels.length === 0 ? 'empty' : labels.join(' ');
}

/** Table of every workflow with the actions you would expect from a file manager. */
export function WorkflowsPage({ workflows, activeId, runs, errorCounts, onSetAll, ...actions }: WorkflowsPageProps) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // The latest run per workflow (runs are stored oldest first; the log is capped and noisier).
  const lastRun = useMemo(() => {
    const map = new Map<string, RunRecord>();
    for (const run of runs) {
      const seen = map.get(run.workflowId);
      if (!seen || run.startedAt >= seen.startedAt) map.set(run.workflowId, run);
    }
    return map;
  }, [runs]);

  const shown = workflows.filter((workflow) => workflow.name.toLowerCase().includes(query.trim().toLowerCase()));
  const pickedIds = shown.filter((workflow) => picked.has(workflow.id)).map((workflow) => workflow.id);
  const allPicked = shown.length > 0 && pickedIds.length === shown.length;

  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="bf-manage">
      <div className="bf-manage-bar">
        <h2>All workflows</h2>
        <input
          type="text"
          placeholder="Search…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search workflows"
        />
        <span className="bf-spacer" />
        <NewMenu onBlank={actions.onCreate} onTemplate={actions.onCreateFromTemplate} plain />
        <ImportButton onFiles={actions.onImport} />
        <button type="button" onClick={() => actions.onExport(pickedIds.length > 0 ? pickedIds : workflows.map((w) => w.id))}>
          Export {pickedIds.length > 0 ? `selected (${pickedIds.length})` : 'all'}
        </button>
        <button type="button" onClick={() => onSetAll(true)}>
          Turn all on
        </button>
        <button type="button" onClick={() => onSetAll(false)}>
          Turn all off
        </button>
      </div>

      <table className="bf-table">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                aria-label="Select all"
                checked={allPicked}
                onChange={() => setPicked(allPicked ? new Set() : new Set(shown.map((workflow) => workflow.id)))}
              />
            </th>
            <th>On</th>
            <th>Name</th>
            <th>Blocks</th>
            <th>Last activity</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.map((workflow) => {
            const run = lastRun.get(workflow.id);
            const problems = errorCounts.get(workflow.id) ?? 0;
            return (
              <tr key={workflow.id} className={workflow.id === activeId ? 'active' : ''}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${workflow.name}`}
                    checked={picked.has(workflow.id)}
                    onChange={() => toggle(workflow.id)}
                  />
                </td>
                <td>
                  <label className="bf-switch" title={problems > 0 && !workflow.enabled ? 'Fix the problems first' : workflow.enabled ? 'Running in the background' : 'Turn on to run'}>
                    <input
                      type="checkbox"
                      aria-label={`${workflow.name} on`}
                      checked={workflow.enabled}
                      disabled={problems > 0 && !workflow.enabled}
                      onChange={(event) => actions.onToggle(workflow.id, event.target.checked)}
                    />
                  </label>
                </td>
                <td>
                  <button type="button" className="bf-link" onClick={() => actions.onOpen(workflow.id)}>
                    {workflow.name}
                  </button>
                  {problems > 0 && <span className="bf-error"> · {problems} problem{problems === 1 ? '' : 's'}</span>}
                </td>
                <td title={`${workflow.nodes.length} blocks, ${workflow.edges.length} connections`}>{blockSummary(workflow)}</td>
                <td className="bf-muted">
                  {run ? (
                    <>
                      {new Date(run.endedAt ?? run.startedAt).toLocaleString()} <span className={`bf-run-status ${run.status}`}>{run.status}</span>
                    </>
                  ) : (
                    'never'
                  )}
                </td>
                <td className="bf-table-actions">
                  <button type="button" onClick={() => actions.onOpen(workflow.id)}>
                    Edit
                  </button>
                  <button type="button" onClick={() => actions.onDuplicate(workflow.id)}>
                    Duplicate
                  </button>
                  <button type="button" onClick={() => actions.onExport([workflow.id])}>
                    Export
                  </button>
                  <button type="button" onClick={() => actions.onExportPlaywright(workflow.id)} title="Download as a Playwright test (.spec.ts) to run in CI">
                    Playwright
                  </button>
                  <button type="button" className="bf-danger" onClick={() => actions.onDelete(workflow.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            );
          })}
          {shown.length === 0 && (
            <tr>
              <td colSpan={6} className="bf-muted">
                {workflows.length === 0 ? 'No workflows yet.' : 'No match.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
