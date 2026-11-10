import { browser } from 'wxt/browser';
import { createDefaultRegistry } from '../core/blocks';
import type { BlockRegistry } from '../core/registry';
import type { Suite, SuiteInput, SuiteResult, WorkflowSource } from '../core/bridgeProtocol';
import { CodedError } from '../core/errors';
import type { Issue } from '../core/issues';
import { hasErrors } from '../core/issues';
import { parseImport } from '../core/library';
import { toSuiteHtml, toSuiteJson, toSuiteJUnit } from '../core/report';
import type { RunRecord } from '../core/runs';
import { buildSuiteResult, isSavedSuite, normaliseSuites, runPassed, validateSuite } from '../core/suite';
import type { Workflow } from '../core/types';
import { STORAGE_KEYS } from '../shared/keys';

/**
 * Suites (M4.4): stored in `bf:suites`, run in order through whatever runs one workflow (the worker's
 * runner, or the bridge's). Used by the background (`bf:run-suite` from the editor's Suites page) and
 * the bridge's `suite.list` / `suite.run`.
 */

export type SuiteFormat = 'json' | 'junit' | 'html';

/** Every saved suite (`bf:suites`), read leniently ([] when missing). */
export async function loadSuites(): Promise<Suite[]> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.suites);
  return normaliseSuites(stored[STORAGE_KEYS.suites]);
}

/** Replaces `bf:suites`. */
export async function saveSuites(suites: Suite[]): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.suites]: suites });
}

export interface SuiteProgress {
  /** 0-based position of the workflow in the suite. */
  index: number;
  total: number;
  workflowName: string;
  /** The run's status, or `skipped` for a workflow not run after a failure. */
  status: string;
}

export interface RunSuiteInput {
  suite: Suite | SuiteInput;
  /** Overlay the stored secrets for every run of this suite (never stored). */
  secrets?: Record<string, string>;
  /** Combined reports to build (none by default). */
  formats?: SuiteFormat[];
  /**
   * M5.5 "Re-run failed": run only the suite's workflows with these ids, in suite order (`failedWorkflowIds`).
   * Ids not in the suite are ignored; when none is left the suite throws `config.invalid`.
   */
  only?: string[];
}

export interface RunSuiteDeps {
  /** The saved workflows (to resolve `workflowIds`). */
  loadWorkflows(): Promise<Workflow[]>;
  /** Runs one workflow to the end and resolves with its finished run. */
  runWorkflow(wf: Workflow, opts: { secrets?: Record<string, string> }): Promise<RunRecord>;
  /** Called after each workflow finished (or was skipped). */
  onProgress?(p: SuiteProgress): void;
  /** Optional: screenshot id → data URL, embedded in the HTML report (`loadScreenshot` of blobStore.ts). */
  loadScreenshot?(id: string): Promise<string | undefined>;
  /** Block registry for compiling sources and labelling steps. Default: the built-in blocks. */
  registry?: BlockRegistry;
}

let builtIn: BlockRegistry | undefined;

/** One line per error issue, for the `config.invalid` message. */
function describeIssues(issues: Issue[]): string {
  return issues
    .filter((issue) => issue.level === 'error')
    .map((issue) => `${issue.path || '/'}: ${issue.message} (${issue.code})`)
    .join('; ');
}

/**
 * Compiles inline workflow sources (a script, a graph file or one workflow; JSON text or parsed) with
 * the M1 importer. Run Workflow blocks may call saved workflows by id; names are not made unique
 * against saved workflows (so reports show the name the author wrote).
 */
function compileSources(sources: WorkflowSource[], saved: Workflow[], registry: BlockRegistry): { workflows: Workflow[]; issues: Issue[] } {
  // parseImport renames on a name clash with `existing`; blank names keep the ids known without that.
  const existing = saved.map((workflow) => ({ ...workflow, name: '' }));
  const workflows: Workflow[] = [];
  const issues: Issue[] = [];
  sources.forEach((source, index) => {
    let text: string;
    try {
      text = typeof source === 'string' ? source : JSON.stringify(source);
    } catch {
      text = '';
    }
    const parsed = parseImport(text ?? '', existing, { registry });
    const base = `/sources/${index}`;
    issues.push(...parsed.issues.map((issue) => ({ ...issue, path: `${base}${issue.path}` })));
    if (parsed.ok) workflows.push(...parsed.workflows);
    else if (!hasErrors(parsed.issues)) issues.push({ level: 'error', code: 'source.invalid', path: base, message: parsed.error });
  });
  return { workflows, issues };
}

/** A failed run standing in for a workflow whose runner threw (so the suite still reports it). */
function crashedRun(workflow: Workflow, error: unknown, at: string): RunRecord {
  return {
    id: `suite-error-${workflow.id}`,
    workflowId: workflow.id,
    workflowName: workflow.name,
    trigger: 'manual',
    status: 'failed',
    startedAt: at,
    endedAt: new Date().toISOString(),
    steps: [],
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Runs a suite: saved `workflowIds` first, then the workflows compiled from `sources`, one after the
 * other. Anything invalid (no name, no workflows, unknown ids, a source that does not compile) throws
 * a `CodedError('config.invalid')` listing the issues before anything runs. With `stopOnFailure`, the
 * workflows after the first one that did not pass are not run and are listed in `skipped`.
 */
export async function runSuite(
  input: RunSuiteInput,
  deps: RunSuiteDeps,
): Promise<{ result: SuiteResult; reports?: Partial<Record<SuiteFormat, string>> }> {
  const { suite } = input;
  const registry = deps.registry ?? (builtIn ??= createDefaultRegistry());
  const saved = await deps.loadWorkflows();
  const issues = validateSuite(suite, saved.map((workflow) => workflow.id));
  const sources = !isSavedSuite(suite) && Array.isArray(suite.sources) ? suite.sources : [];
  const compiled = hasErrors(issues) ? { workflows: [], issues: [] } : compileSources(sources, saved, registry);
  issues.push(...compiled.issues);
  if (hasErrors(issues)) {
    throw new CodedError('config.invalid', `Suite "${typeof suite?.name === 'string' ? suite.name : ''}" is invalid: ${describeIssues(issues)}`);
  }

  const byId = new Map(saved.map((workflow) => [workflow.id, workflow]));
  const all = [...(suite.workflowIds ?? []).map((id) => byId.get(id) as Workflow), ...compiled.workflows];
  const only = input.only ? new Set(input.only) : undefined;
  const workflows = only ? all.filter((workflow) => only.has(workflow.id)) : all;
  if (only && workflows.length === 0) throw new CodedError('config.invalid', `Suite "${suite.name}": none of the workflows to re-run is in the suite any more.`);
  const total = workflows.length;
  const startedAt = new Date().toISOString();
  const runs: RunRecord[] = [];
  const skipped: string[] = [];
  const runOptions = input.secrets ? { secrets: input.secrets } : {};

  for (const [index, workflow] of workflows.entries()) {
    if (suite.stopOnFailure && runs.some((run) => !runPassed(run))) {
      skipped.push(workflow.name);
      deps.onProgress?.({ index, total, workflowName: workflow.name, status: 'skipped' });
      continue;
    }
    const at = new Date().toISOString();
    let run: RunRecord;
    try {
      run = await deps.runWorkflow(workflow, runOptions);
    } catch (error) {
      run = crashedRun(workflow, error, at);
    }
    runs.push(run);
    deps.onProgress?.({ index, total, workflowName: workflow.name, status: run.status });
  }

  const result = buildSuiteResult({ suite, startedAt, finishedAt: new Date().toISOString(), runs, skipped });
  const formats = [...new Set(input.formats ?? [])];
  if (formats.length === 0) return { result };
  return { result, reports: await suiteReports(result, formats, { registry, ...(deps.loadScreenshot ? { loadScreenshot: deps.loadScreenshot } : {}) }) };
}

/**
 * M5.5: the workflows of `result` to run again: the ones whose run did not pass, then the ones skipped
 * after a failure (`stopOnFailure`; matched by name among `suiteWorkflows`), as saved workflow ids in suite order.
 */
export function failedWorkflowIds(result: SuiteResult, suiteWorkflows: Pick<Workflow, 'id' | 'name'>[]): string[] {
  const failed = new Set(result.runs.filter((run) => !runPassed(run)).map((run) => run.workflowId));
  const skipped = new Set(result.skipped);
  return suiteWorkflows.filter((workflow) => failed.has(workflow.id) || skipped.has(workflow.name)).map((workflow) => workflow.id);
}

/** The combined reports of a suite result in `formats` (HTML with the screenshots `loadScreenshot` finds). */
export async function suiteReports(
  result: SuiteResult,
  formats: SuiteFormat[],
  options: { registry?: BlockRegistry; loadScreenshot?(id: string): Promise<string | undefined> } = {},
): Promise<Partial<Record<SuiteFormat, string>>> {
  const registry = options.registry ?? (builtIn ??= createDefaultRegistry());
  const blockLabel = (type: string) => registry.get(type)?.label ?? type;
  const reports: Partial<Record<SuiteFormat, string>> = {};
  for (const format of formats) {
    if (format === 'json') reports.json = JSON.stringify(toSuiteJson(result), null, 2);
    else if (format === 'junit') reports.junit = toSuiteJUnit(result, { blockLabel });
    else if (format === 'html') {
      const screenshots: Record<string, string> = {};
      if (options.loadScreenshot) {
        for (const run of result.runs) {
          for (const step of run.steps) {
            if (!step.screenshot) continue;
            const shot = await options.loadScreenshot(step.screenshot).catch(() => undefined);
            if (shot) screenshots[step.screenshot] = shot;
          }
        }
      }
      reports.html = toSuiteHtml(result, { blockLabel, screenshots });
    }
  }
  return reports;
}
