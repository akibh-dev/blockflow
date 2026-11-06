import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../src/core/blocks';

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
