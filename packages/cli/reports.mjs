// Reports and console output for a CLI run.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPORT_FILES } from './args.mjs';

/**
 * A large bridge result comes back as `{ blobId, size }`; fetch its chunks with `blob.get` and parse the JSON.
 * Anything else is returned unchanged.
 * @param {{ call(method: string, params: unknown): Promise<any> }} client
 * @param {any} result
 */
export async function resolveBlob(client, result) {
  if (!result || typeof result.blobId !== 'string' || typeof result.size !== 'number' || Object.keys(result).length !== 2) return result;
  /** @type {Buffer[]} */
  const chunks = [];
  let offset = 0;
  for (;;) {
    const chunk = await client.call('blob.get', { blobId: result.blobId, offset });
    const bytes = Buffer.from(chunk.data, 'base64');
    chunks.push(bytes);
    offset += bytes.length;
    if (chunk.done || bytes.length === 0) break;
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Writes the reports returned by `suite.run` into `outDir` (junit.xml, report.json, report.html).
 * Formats that were asked for but not returned are listed in `missing`.
 * @param {string} outDir
 * @param {Partial<Record<'junit' | 'json' | 'html', string>> | undefined} reports
 * @param {('junit' | 'json' | 'html')[]} formats
 */
export function writeReports(outDir, reports, formats) {
  /** @type {string[]} */
  const written = [];
  /** @type {string[]} */
  const missing = [];
  if (formats.length === 0) return { written, missing };
  mkdirSync(outDir, { recursive: true });
  for (const format of formats) {
    const content = reports?.[format];
    if (typeof content !== 'string') {
      missing.push(format);
      continue;
    }
    const file = path.join(outDir, REPORT_FILES[format]);
    writeFileSync(file, content);
    written.push(file);
  }
  return { written, missing };
}

/** @param {number} ms */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** @param {{ startedAt?: string, endedAt?: string, finishedAt?: string }} record */
export function durationOf(record) {
  const start = Date.parse(record.startedAt ?? '');
  const end = Date.parse(record.endedAt ?? record.finishedAt ?? '');
  return Number.isFinite(start) && Number.isFinite(end) ? end - start : NaN;
}

/**
 * The step that failed a run: the last `failed` step (handled errors do not count).
 * @param {{ steps?: any[] }} run
 */
export function failingStep(run) {
  return (run.steps ?? []).findLast((step) => step.status === 'failed');
}

/**
 * Console lines for a finished suite: one per workflow (✓/✗, name, duration), the failing step with its
 * error code, message, locator and URL, the skipped workflows, then a totals line.
 * @param {{ name: string, status: string, runs: any[], skipped?: string[], startedAt?: string, finishedAt?: string }} result
 * @returns {string[]}
 */
export function summaryLines(result) {
  const lines = [];
  let passed = 0;
  let failed = 0;
  for (const run of result.runs) {
    const ok = run.status === 'passed';
    if (ok) passed += 1;
    else failed += 1;
    lines.push(`${ok ? '✓' : '✗'} ${run.workflowName}  ${formatDuration(durationOf(run))}${ok ? '' : `  (${run.status})`}`);
    if (ok) continue;
    const step = failingStep(run);
    if (step) {
      const id = step.sourceId ?? step.nodeId;
      lines.push(`    step "${id}" (${step.blockType})${step.code ? ` ${step.code}` : ''}: ${step.error ?? 'failed'}`);
      if (step.locator) lines.push(`    locator: ${step.locator}`);
      if (step.url) lines.push(`    url: ${step.url}`);
    }
    if (run.error && run.error !== step?.error) lines.push(`    ${run.error}`);
  }
  const skipped = result.skipped ?? [];
  for (const name of skipped) lines.push(`- ${name}  (skipped)`);
  lines.push(
    `${result.status === 'passed' ? 'PASSED' : 'FAILED'} ${result.name}: ${passed} passed, ${failed} failed${skipped.length ? `, ${skipped.length} skipped` : ''} in ${formatDuration(durationOf(result))}`,
  );
  return lines;
}

/**
 * Console lines for validation issues of one file: `file: level code at /path: message (hint)`.
 * @param {string} file
 * @param {{ level: string, code: string, path?: string, message: string, hint?: string }[]} issues
 */
export function issueLines(file, issues) {
  return issues.map((issue) => `${file}: ${issue.level} ${issue.code}${issue.path ? ` at ${issue.path}` : ''}: ${issue.message}${issue.hint ? ` (${issue.hint})` : ''}`);
}
