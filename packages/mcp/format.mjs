// Text an LLM reads back from the tools: issues in the guide's repair format, compact run summaries.

/** `<level> <code> at <path>: <message> <hint>`, the format of the guide's Repair section. */
export function formatIssue(issue) {
  const hint = issue.hint ? ` ${issue.hint}` : '';
  return `${issue.level} ${issue.code} at ${issue.path || '/'}: ${issue.message}${hint}`;
}

export function formatIssues(issues) {
  if (!issues?.length) return 'No issues.';
  const errors = issues.filter((issue) => issue.level === 'error').length;
  const warnings = issues.filter((issue) => issue.level === 'warning').length;
  return [`${errors} error(s), ${warnings} warning(s), ${issues.length - errors - warnings} note(s):`, ...issues.map((issue) => `- ${formatIssue(issue)}`)].join('\n');
}

export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '?';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Duration of a run from its ISO times, or undefined while it has no end. */
export function runDuration(run) {
  if (!run?.startedAt || !run?.endedAt) return undefined;
  const ms = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  return Number.isFinite(ms) ? ms : undefined;
}

/** The step id an author recognises: the id in the imported file when there was one. */
export function stepId(step) {
  return step.sourceId ?? step.nodeId;
}

/** The step that made the run fail: the last `failed` step (handled failures do not stop a run). */
export function failingStep(run) {
  const steps = run?.steps ?? [];
  for (let i = steps.length - 1; i >= 0; i -= 1) if (steps[i].status === 'failed') return steps[i];
  return undefined;
}

const MARK = { passed: 'ok', failed: 'FAILED', handled: 'handled', skipped: 'skipped', running: 'running' };

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Structured summary of a run (also the tool's structuredContent). */
export function summarizeRun(run) {
  const failing = failingStep(run);
  return {
    status: run.status,
    runId: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    durationMs: runDuration(run),
    error: run.error,
    failingStep: failing
      ? {
          id: stepId(failing),
          nodeId: failing.nodeId,
          blockType: failing.blockType,
          code: failing.code,
          message: failing.error,
          locator: failing.locator,
          url: failing.url,
          matches: failing.matches,
          screenshot: failing.screenshot,
          console: failing.console,
        }
      : undefined,
    steps: (run.steps ?? []).map((step) => ({
      id: stepId(step),
      blockType: step.blockType,
      status: step.status,
      durationMs: step.durationMs,
      attempts: step.attempts,
      code: step.code,
      error: step.error,
      output: step.output,
    })),
    droppedSteps: run.droppedSteps,
  };
}

/** The compact text an LLM reads first: verdict, then what failed and where, then the step list. */
export function formatRunText(run) {
  const summary = summarizeRun(run);
  const lines = [
    `Run ${String(run.status).toUpperCase()} in ${formatDuration(summary.durationMs)}: "${run.workflowName}" (run ${run.id}, workflow ${run.workflowId})`,
  ];
  const failing = summary.failingStep;
  if (failing) {
    lines.push(`Failing step: ${failing.id} (${failing.blockType})`);
    if (failing.code) lines.push(`Error code: ${failing.code}`);
    if (failing.message) lines.push(`Message: ${failing.message}`);
    if (failing.locator) lines.push(`Locator: ${failing.locator}`);
    if (failing.url) lines.push(`Page URL: ${failing.url}`);
    if (failing.matches?.length) lines.push(`Matches: ${failing.matches.join(' | ')}`);
    const consoleLines = (failing.console ?? []).slice(-5).map((entry) => `${entry.level}: ${truncate(String(entry.text ?? ''), 200)}`);
    if (consoleLines.length) lines.push(`Console: ${consoleLines.join(' | ')}`);
  } else if (run.status !== 'passed' && run.error) {
    lines.push(`Error: ${run.error}`);
  }
  lines.push('Steps:');
  for (const step of run.steps ?? []) {
    const detail = step.status === 'failed' || step.status === 'handled' ? ` ${step.code ?? ''} ${truncate(step.error ?? '', 160)}`.trimEnd() : '';
    lines.push(`- ${stepId(step)} ${step.blockType} ${MARK[step.status] ?? step.status} ${formatDuration(step.durationMs)}${detail}`);
  }
  if (run.droppedSteps) lines.push(`(${run.droppedSteps} more steps not kept)`);
  if (run.status !== 'passed') {
    lines.push(
      failing
        ? `Next: look up ${failing.code ?? 'the error'} in the guide's error-code table (resource blockflow://guide), fix step "${failing.id}" (snapshot_page for fresh locators), validate_workflow, then run_workflow again.`
        : 'Next: read the error, fix the workflow, validate_workflow, then run_workflow again.',
    );
  }
  return lines.join('\n');
}

/** Text for a finished suite: verdict, one line per workflow, skipped ones. */
export function formatSuiteText(result) {
  const passed = result.runs.filter((run) => run.status === 'passed').length;
  const ms = Date.parse(result.finishedAt) - Date.parse(result.startedAt);
  const lines = [`Suite ${String(result.status).toUpperCase()} in ${formatDuration(ms)}: "${result.name}", ${passed}/${result.runs.length} workflow(s) passed`];
  for (const run of result.runs) {
    const failing = failingStep(run);
    const detail = failing ? ` at ${stepId(failing)} (${failing.blockType}) ${failing.code ?? ''}: ${truncate(failing.error ?? '', 200)}` : run.status !== 'passed' && run.error ? `: ${run.error}` : '';
    lines.push(`- ${run.workflowName} ${String(run.status).toUpperCase()} ${formatDuration(runDuration(run))} (run ${run.id})${detail}`);
  }
  if (result.skipped?.length) lines.push(`Skipped (stopOnFailure): ${result.skipped.join(', ')}`);
  if (result.status !== 'passed') lines.push('Use get_report with a runId, or run_workflow on the failing workflow, to see its full steps.');
  return lines.join('\n');
}
