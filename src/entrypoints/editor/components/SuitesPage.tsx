import { useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { loadScreenshot } from '../../../browser/blobStore';
import { loadWorkflows } from '../../../browser/stores';
import { loadSuites, saveSuites, suiteReports } from '../../../browser/suites';
import type { SuiteFormat } from '../../../browser/suites';
import type { Suite, SuiteResult } from '../../../core/bridgeProtocol';
import { durationOf } from '../../../core/report';
import { createSuite, failingStep, moveItem, normaliseSuites, suiteSummary } from '../../../core/suite';
import type { Workflow } from '../../../core/types';
import { STORAGE_KEYS } from '../../../shared/keys';
import { isExtensionMessage } from '../../../shared/messages';
import type { RunSuiteMessage } from '../../../shared/messages';
import { downloadText } from '../files';
import { registry } from '../registry';
import { formatMs } from './ConfigPanel';
import { confirmDialog, toast } from './Dialogs';

type Progress = { index: number; total: number; workflowName: string; status: string };

const FILES: Record<SuiteFormat, { ext: string; mime: string; label: string }> = {
  html: { ext: 'html', mime: 'text/html', label: 'HTML' },
  junit: { ext: 'xml', mime: 'application/xml', label: 'JUnit XML' },
  json: { ext: 'json', mime: 'application/json', label: 'JSON' },
};

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'suite';
}

/**
 * Suites (M4.4): named, ordered lists of saved workflows (`bf:suites`), run one after the other by the
 * background (`bf:run-suite`, answered with `bf:suite-progress` / `bf:suite-result`), with one combined
 * report to download. The last result per suite is kept while the page is open; every run is also in Reports.
 */
export function SuitesPage() {
  const [suites, setSuites] = useState<Suite[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [running, setRunning] = useState<Record<string, Progress[]>>({});
  const [results, setResults] = useState<Record<string, SuiteResult>>({});
  const [adding, setAdding] = useState('');

  useEffect(() => {
    let alive = true;
    void loadSuites().then((stored) => {
      if (!alive) return;
      setSuites(stored);
      setOpenId((current) => current ?? stored[0]?.id ?? null);
    });
    void loadWorkflows().then((stored) => alive && setWorkflows(stored));
    const onStorage = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'local') return;
      if (changes[STORAGE_KEYS.suites]) setSuites(normaliseSuites(changes[STORAGE_KEYS.suites].newValue));
      if (changes[STORAGE_KEYS.workflows]) setWorkflows((changes[STORAGE_KEYS.workflows].newValue as Workflow[] | undefined) ?? []);
    };
    const onMessage = (message: unknown) => {
      if (!isExtensionMessage(message)) return;
      if (message.type === 'bf:suite-progress') {
        const { suiteId, index, total, workflowName, status } = message;
        setRunning((current) => (current[suiteId] ? { ...current, [suiteId]: [...current[suiteId], { index, total, workflowName, status }] } : current));
      } else if (message.type === 'bf:suite-result') {
        const { suiteId } = message;
        setRunning((current) => {
          const { [suiteId]: _done, ...rest } = current;
          return rest;
        });
        if (message.result) {
          const result = message.result;
          setResults((current) => ({ ...current, [suiteId]: result }));
          toast(`Suite "${result.name}" ${result.status}`, result.status === 'passed' ? 'success' : 'error');
        } else {
          toast(message.error ?? 'The suite could not run', 'error');
        }
      }
    };
    browser.storage.onChanged.addListener(onStorage);
    browser.runtime.onMessage.addListener(onMessage);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(onStorage);
      browser.runtime.onMessage.removeListener(onMessage);
    };
  }, []);

  const byId = useMemo(() => new Map(workflows.map((workflow) => [workflow.id, workflow])), [workflows]);
  const open = suites.find((suite) => suite.id === openId) ?? null;

  const save = (next: Suite[]) => {
    setSuites(next);
    void saveSuites(next).catch((error: unknown) => toast(`Could not save the suites: ${error instanceof Error ? error.message : String(error)}`, 'error'));
  };
  const change = (id: string, patch: Partial<Suite>) => save(suites.map((suite) => (suite.id === id ? { ...suite, ...patch } : suite)));

  const create = () => {
    const suite = createSuite(suites);
    save([...suites, suite]);
    setOpenId(suite.id);
  };

  const remove = async (suite: Suite) => {
    if (!(await confirmDialog({ title: 'Delete suite', message: `Delete the suite "${suite.name}"? Its workflows are kept.`, confirmLabel: 'Delete', danger: true }))) return;
    const next = suites.filter((item) => item.id !== suite.id);
    save(next);
    if (openId === suite.id) setOpenId(next[0]?.id ?? null);
  };

  const run = (suite: Suite) => {
    setRunning((current) => ({ ...current, [suite.id]: [] }));
    const message: RunSuiteMessage = { type: 'bf:run-suite', suiteId: suite.id };
    void browser.runtime.sendMessage(message).catch(() => {
      setRunning(({ [suite.id]: _gone, ...rest }) => rest);
      toast('Could not reach the background worker. Try reloading the extension.', 'error');
    });
  };

  const download = async (result: SuiteResult, format: SuiteFormat) => {
    const reports = await suiteReports(result, [format], {
      registry,
      loadScreenshot: async (id) => (await loadScreenshot(id))?.dataUrl,
    });
    const stamp = result.startedAt.slice(0, 19).replace(/[:T]/g, '-');
    downloadText(`blockflow-suite-${slug(result.name)}-${stamp}.${FILES[format].ext}`, reports[format] ?? '', FILES[format].mime);
  };

  const missing = open ? open.workflowIds.filter((id) => !byId.has(id)) : [];
  const progress = open ? running[open.id] : undefined;
  const result = open ? results[open.id] : undefined;
  const available = open ? workflows.filter((workflow) => !open.workflowIds.includes(workflow.id)) : [];

  return (
    <section className="bf-manage">
      <div className="bf-manage-bar">
        <h2>Suites</h2>
        <span className="bf-muted">Workflows run one after the other, with one combined report (JUnit, HTML, JSON).</span>
        <span className="bf-spacer" />
        <button type="button" onClick={create}>
          New suite
        </button>
      </div>
      <div className="bf-report">
        <ul className="bf-report-list">
          {suites.map((suite) => (
            <li key={suite.id}>
              <button type="button" className={suite.id === openId ? 'active' : ''} onClick={() => setOpenId(suite.id)}>
                {results[suite.id] && <span className={`bf-run-status ${results[suite.id]?.status}`}>{results[suite.id]?.status}</span>}
                {running[suite.id] && <span className="bf-run-status running">running</span>}
                <strong>{suite.name}</strong>
                <span className="bf-muted">
                  {suite.workflowIds.length} workflow{suite.workflowIds.length === 1 ? '' : 's'}
                  {suite.stopOnFailure ? ' · stops on failure' : ''}
                </span>
              </button>
            </li>
          ))}
          {suites.length === 0 && <li className="bf-muted">No suites yet. A suite runs several workflows in order, like a CI test run.</li>}
        </ul>
        {open && (
          <div className="bf-report-detail bf-suite">
            <div className="bf-suite-head">
              <input
                type="text"
                aria-label="Suite name"
                key={open.id}
                defaultValue={open.name}
                onBlur={(event) => {
                  const name = event.target.value.trim();
                  if (!name) event.target.value = open.name;
                  else if (name !== open.name) change(open.id, { name });
                }}
              />
              <label>
                <input type="checkbox" checked={open.stopOnFailure === true} onChange={(event) => change(open.id, event.target.checked ? { stopOnFailure: true } : { stopOnFailure: false })} /> Stop
                at the first failure
              </label>
              <span className="bf-spacer" />
              <button type="button" className="bf-run" disabled={!!progress || open.workflowIds.length === 0 || missing.length > 0} onClick={() => run(open)}>
                {progress ? 'Running…' : '▶ Run suite'}
              </button>
              <button type="button" className="bf-danger" onClick={() => void remove(open)}>
                Delete
              </button>
            </div>
            {missing.length > 0 && <p className="bf-error">{missing.length} workflow{missing.length === 1 ? ' was' : 's were'} deleted: remove {missing.length === 1 ? 'it' : 'them'} to run the suite.</p>}

            <table className="bf-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Workflow</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {open.workflowIds.map((id, index) => (
                  <tr key={id}>
                    <td className="bf-muted">{index + 1}</td>
                    <td>{byId.get(id)?.name ?? <span className="bf-error">deleted workflow</span>}</td>
                    <td className="bf-table-actions">
                      <button type="button" aria-label="Move up" title="Move up" disabled={index === 0} onClick={() => change(open.id, { workflowIds: moveItem(open.workflowIds, index, -1) })}>
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label="Move down"
                        title="Move down"
                        disabled={index === open.workflowIds.length - 1}
                        onClick={() => change(open.id, { workflowIds: moveItem(open.workflowIds, index, 1) })}
                      >
                        ↓
                      </button>
                      <button type="button" className="bf-danger" onClick={() => change(open.id, { workflowIds: open.workflowIds.filter((item) => item !== id) })}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {open.workflowIds.length === 0 && (
                  <tr>
                    <td colSpan={3} className="bf-muted">
                      No workflows in this suite yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <div className="bf-suite-add">
              <select value={adding} onChange={(event) => setAdding(event.target.value)} aria-label="Workflow to add">
                <option value="">Add a workflow…</option>
                {available.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!adding}
                onClick={() => {
                  change(open.id, { workflowIds: [...open.workflowIds, adding] });
                  setAdding('');
                }}
              >
                Add
              </button>
            </div>

            {progress && (
              <p className="bf-muted" role="status">
                Running {Math.min(progress.length + 1, progress[0]?.total ?? open.workflowIds.length)} of {progress[0]?.total ?? open.workflowIds.length}
                {progress.length > 0 && ` · last: ${progress[progress.length - 1]?.workflowName} ${progress[progress.length - 1]?.status}`}
              </p>
            )}

            {result && <SuiteResultView result={result} onDownload={(format) => void download(result, format)} />}
          </div>
        )}
      </div>
    </section>
  );
}

function SuiteResultView({ result, onDownload }: { result: SuiteResult; onDownload(format: SuiteFormat): void }) {
  const sum = suiteSummary(result);
  return (
    <div className="bf-suite-result">
      <h3>
        Last result <span className={`bf-run-status ${result.status}`}>{result.status}</span>
      </h3>
      <p className="bf-muted bf-totals">
        {new Date(result.startedAt).toLocaleString()} · <span className="bf-ok">{sum.passed} passed</span> · <span className="bf-error">{sum.failed} failed</span> · {sum.skipped} skipped ·{' '}
        {formatMs(sum.durationMs)}. Each run is also in Reports.
      </p>
      <ol className="bf-report-steps">
        {result.runs.map((run) => {
          const step = failingStep(run);
          return (
            <li key={run.id} className={run.status}>
              <span className={`bf-run-status ${run.status}`}>{run.status}</span> <strong>{run.workflowName}</strong>
              <span className="bf-muted"> · {formatMs(durationOf(run))}</span>
              {run.status !== 'passed' && (step?.error || run.error) && (
                <div className="bf-error">
                  {step?.code && <code>{step.code}</code>} {step ? `${registry.get(step.blockType)?.label ?? step.blockType}: ${step.error ?? ''}` : run.error}
                </div>
              )}
            </li>
          );
        })}
        {result.skipped.map((name) => (
          <li key={`skipped-${name}`} className="skipped">
            <span className="bf-run-status">skipped</span> <strong>{name}</strong>
          </li>
        ))}
      </ol>
      <div className="bf-suite-downloads">
        {(Object.keys(FILES) as SuiteFormat[]).map((format) => (
          <button key={format} type="button" onClick={() => onDownload(format)}>
            Download {FILES[format].label}
          </button>
        ))}
      </div>
    </div>
  );
}
