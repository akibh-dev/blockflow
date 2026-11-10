import type { Suite, SuiteInput, SuiteResult } from './bridgeProtocol';
import { uid } from './id';
import type { Issue } from './issues';
import { pointer } from './issues';
import type { RunRecord, StepRecord } from './runs';

/**
 * Suites (M4.4): a named, ordered list of workflows run one after the other with one combined
 * report. Saved suites (`Suite`, in `bf:suites`) name saved workflows by id; an inline suite
 * (`SuiteInput`, from the bridge or the CLI) may also carry workflow sources to compile first.
 * Running lives in src/browser/suites.ts; the reports in report.ts (`toSuiteJUnit` …). Pure.
 */

/** A saved suite has an `id`; a `SuiteInput` does not. */
export function isSavedSuite(suite: Suite | SuiteInput): suite is Suite {
  return typeof (suite as Suite).id === 'string';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Problems with one suite. `knownWorkflowIds`, when given, are the saved workflows: an id not among
 * them is an error. A suite needs a name and at least one workflow (an id or a source); ids may not repeat.
 */
export function validateSuite(suite: Suite | SuiteInput, knownWorkflowIds?: Iterable<string>, base = ''): Issue[] {
  const issues: Issue[] = [];
  const raw = suite as unknown;
  if (!isObject(raw)) return [{ level: 'error', code: 'suite.invalid', path: base, message: 'A suite must be an object with a name and workflows.' }];
  if (typeof raw.name !== 'string' || raw.name.trim() === '') {
    issues.push({ level: 'error', code: 'suite.name.missing', path: `${base}/name`, message: 'The suite has no name.' });
  }
  if ('id' in raw && (typeof raw.id !== 'string' || raw.id === '')) {
    issues.push({ level: 'error', code: 'suite.id.invalid', path: `${base}/id`, message: 'The suite id must be a non-empty string.' });
  }
  const ids = raw.workflowIds;
  if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))) {
    issues.push({ level: 'error', code: 'suite.workflowIds.invalid', path: `${base}/workflowIds`, message: '`workflowIds` must be a list of workflow ids.' });
  }
  const sources = raw.sources;
  if (sources !== undefined && !Array.isArray(sources)) {
    issues.push({ level: 'error', code: 'suite.sources.invalid', path: `${base}/sources`, message: '`sources` must be a list of workflow sources.' });
  }
  const idList = Array.isArray(ids) ? (ids.filter((id) => typeof id === 'string') as string[]) : [];
  const sourceCount = Array.isArray(sources) ? sources.length : 0;
  if (idList.length + sourceCount === 0) {
    issues.push({ level: 'error', code: 'suite.empty', path: `${base}/workflowIds`, message: 'The suite has no workflows.', hint: 'Add at least one workflow.' });
  }
  const known = knownWorkflowIds ? new Set(knownWorkflowIds) : undefined;
  const seen = new Set<string>();
  idList.forEach((id, index) => {
    const path = `${base}${pointer('workflowIds', index)}`;
    if (seen.has(id)) issues.push({ level: 'error', code: 'suite.workflow.duplicate', path, message: `Workflow "${id}" is in the suite twice.` });
    seen.add(id);
    if (known && !known.has(id)) {
      issues.push({ level: 'error', code: 'suite.workflow.unknown', path, message: `No saved workflow has the id "${id}".`, hint: 'Remove it from the suite, or import the workflow first.' });
    }
  });
  return issues;
}

/** Problems with a list of saved suites: each suite's own, plus repeated ids or names. */
export function validateSuites(suites: Suite[], knownWorkflowIds?: Iterable<string>): Issue[] {
  const known = knownWorkflowIds ? [...knownWorkflowIds] : undefined;
  const issues: Issue[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  suites.forEach((suite, index) => {
    const base = pointer(index);
    issues.push(...validateSuite(suite, known, base));
    if (!isSavedSuite(suite)) issues.push({ level: 'error', code: 'suite.id.invalid', path: `${base}/id`, message: 'A saved suite needs an id.' });
    else if (ids.has(suite.id)) issues.push({ level: 'error', code: 'suite.id.duplicate', path: `${base}/id`, message: `Two suites have the id "${suite.id}".` });
    else ids.add(suite.id);
    const name = typeof suite.name === 'string' ? suite.name.trim().toLowerCase() : '';
    if (name && names.has(name)) issues.push({ level: 'error', code: 'suite.name.duplicate', path: `${base}/name`, message: `Two suites are named "${suite.name}".` });
    if (name) names.add(name);
  });
  return issues;
}

/**
 * Reads stored suites leniently (whatever `bf:suites` holds): drops entries that are not objects or
 * have no id, fills a missing name, keeps only string workflow ids and a boolean stopOnFailure.
 */
export function normaliseSuites(value: unknown): Suite[] {
  if (!Array.isArray(value)) return [];
  const out: Suite[] = [];
  for (const raw of value) {
    if (!isObject(raw) || typeof raw.id !== 'string' || raw.id === '') continue;
    const suite: Suite = {
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Untitled suite',
      workflowIds: Array.isArray(raw.workflowIds) ? raw.workflowIds.filter((id): id is string => typeof id === 'string') : [],
    };
    if (raw.stopOnFailure === true) suite.stopOnFailure = true;
    out.push(suite);
  }
  return out;
}

/** A new, empty suite with a fresh id and a name not taken by `existing` ("Suite", "Suite 2", …). */
export function createSuite(existing: Suite[], wanted = 'Suite'): Suite {
  const taken = new Set(existing.map((suite) => suite.name.trim().toLowerCase()));
  let name = wanted;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${wanted} ${n}`;
  return { id: uid(), name, workflowIds: [] };
}

/** Finds a saved suite by id, else by name (case-insensitive). */
export function findSuite(suites: Suite[], ref: { suiteId?: string; name?: string }): Suite | undefined {
  if (ref.suiteId) return suites.find((suite) => suite.id === ref.suiteId);
  const name = ref.name?.trim().toLowerCase();
  return name ? suites.find((suite) => suite.name.trim().toLowerCase() === name) : undefined;
}

/** Moves the item at `index` one place up (-1) or down (+1); out of range leaves the list as it is. */
export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  const copy = [...list];
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return copy;
  [copy[index], copy[target]] = [copy[target] as T, copy[index] as T];
  return copy;
}

/** A workflow run counts as passed only with status `passed` (failed, interrupted, cancelled do not). */
export function runPassed(run: RunRecord): boolean {
  return run.status === 'passed';
}

/** passed when every workflow ran and passed. */
export function suiteStatus(runs: RunRecord[], skipped: string[]): SuiteResult['status'] {
  return runs.length > 0 && skipped.length === 0 && runs.every(runPassed) ? 'passed' : 'failed';
}

/** Names of the workflows after the first `ranCount` (the ones not run after a stop on failure). */
export function skippedNames(names: string[], ranCount: number): string[] {
  return names.slice(ranCount);
}

/** The step a failed run failed at: the last `failed` step (handled failures do not count). */
export function failingStep(run: RunRecord): StepRecord | undefined {
  for (let index = run.steps.length - 1; index >= 0; index--) {
    const step = run.steps[index];
    if (step?.status === 'failed') return step;
  }
  return undefined;
}

/** Assembles a `SuiteResult`; `status` is computed from the runs and the skipped names. */
export function buildSuiteResult(parts: { suite: Suite | SuiteInput; startedAt: string; finishedAt: string; runs: RunRecord[]; skipped: string[] }): SuiteResult {
  const result: SuiteResult = {
    name: parts.suite.name,
    status: suiteStatus(parts.runs, parts.skipped),
    startedAt: parts.startedAt,
    finishedAt: parts.finishedAt,
    runs: parts.runs,
    skipped: parts.skipped,
  };
  if (isSavedSuite(parts.suite)) result.suiteId = parts.suite.id;
  return result;
}

/** Counts for a suite result's header (skipped workflows are counted apart from the runs). */
export function suiteSummary(result: SuiteResult): { total: number; passed: number; failed: number; skipped: number; durationMs: number } {
  const passed = result.runs.filter(runPassed).length;
  return {
    total: result.runs.length + result.skipped.length,
    passed,
    failed: result.runs.length - passed,
    skipped: result.skipped.length,
    durationMs: Math.max(0, Date.parse(result.finishedAt) - Date.parse(result.startedAt)) || 0,
  };
}
