import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../src/core/blocks';
import { parseImport } from '../../src/core/library';

// The authoring eval set (tests/evals/tasks.json) stays runnable: known check kinds, known block
// types, and fixture pages that exist.
const root = path.resolve(__dirname, '../..');
const file = JSON.parse(readFileSync(path.join(root, 'tests/evals/tasks.json'), 'utf8')) as {
  checkKinds: Record<string, string>;
  tasks: { id: string; prompt: string; checks: { kind: string; type?: string }[] }[];
};
const registry = createDefaultRegistry();
const dynamic = new Set(['/products', '/spa/']);

describe('authoring evals', () => {
  it('has ten tasks with unique ids', () => {
    expect(file.tasks).toHaveLength(10);
    expect(new Set(file.tasks.map((task) => task.id)).size).toBe(10);
  });

  it.each(file.tasks.map((task) => [task.id, task] as const))('%s is well formed', (_id, task) => {
    for (const check of task.checks) {
      expect(Object.keys(file.checkKinds)).toContain(check.kind);
      if (check.kind === 'step-type') expect(registry.get(check.type ?? '')).toBeDefined();
    }
    const pages = [...task.prompt.matchAll(/\{\{BASE\}\}(\/[\w./-]*\w\/?)/g)].map((match) => match[1] as string);
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      if (dynamic.has(page)) continue;
      expect(existsSync(path.join(root, 'tests/fixtures/site', page)), page).toBe(true);
    }
  });
});

describe('authoring evals: reference solutions', () => {
  // tests/evals/solutions/<task id>.script.json: one passing answer per task, run by the e2e spec
  // tests/e2e/specs/evals.mjs. Here they must import with no issues at all and honour step-type checks.
  const solutions = path.join(root, 'tests/evals/solutions');
  it.each(file.tasks.map((task) => [task.id, task] as const))('%s imports cleanly', (id, task) => {
    const text = readFileSync(path.join(solutions, `${id}.script.json`), 'utf8').replaceAll('{{BASE}}', 'http://127.0.0.1:8080');
    const result = parseImport(text, [], { secrets: Object.keys((task as { secrets?: Record<string, string> }).secrets ?? {}) });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(result.issues.map((issue) => `${issue.level} ${issue.code} ${issue.path}: ${issue.message}`)).toEqual([]);
    if (!result.ok) return;
    const types = new Set(result.workflows[0]?.nodes.map((node) => node.type));
    for (const check of task.checks) if (check.kind === 'step-type') expect(types.has(check.type ?? '')).toBe(true);
  });
});
