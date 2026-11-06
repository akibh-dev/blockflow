import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../src/core/blocks';
import { parseImport } from '../../src/core/library';
import { validateWorkflow } from '../../src/core/validate';

// The guide's example files must import cleanly and have no errors, so AI tools can copy them.
const dir = path.resolve(__dirname, '../../docs/guide/examples');
const registry = createDefaultRegistry();

describe('docs/guide/examples', () => {
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.blockflow.json'))) {
    it(file, () => {
      const result = parseImport(readFileSync(path.join(dir, file), 'utf8'), []);
      expect(result.ok, result.ok ? '' : result.error).toBe(true);
      // Strict checking (check.ts): no errors, and no warnings either, so examples teach clean files.
      // (secret.unknown needs the user's secret list, which is not passed here.)
      expect(result.issues.map((issue) => `${issue.level} ${issue.code} ${issue.path}: ${issue.message}`)).toEqual([]);
      if (!result.ok) return;
      // Ports and step settings survive the import (If false, error outputs, retries…).
      const raw = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
      const rawList: { nodes: { step?: unknown }[]; edges: { sourcePort?: string }[] }[] = raw.workflows ?? [raw];
      rawList.forEach((original, index) => {
        const copy = result.workflows[index]!;
        expect(copy.edges.map((edge) => edge.sourcePort)).toEqual(original.edges.map((edge) => edge.sourcePort));
        expect(copy.nodes.map((node) => node.step)).toEqual(original.nodes.map((node) => node.step));
      });
      for (const workflow of result.workflows) {
        const errors = validateWorkflow(workflow, registry).filter((issue) => issue.level === 'error');
        expect(errors, `${workflow.name}: ${errors.map((issue) => issue.message).join('; ')}`).toEqual([]);
      }
    });
  }
});

describe('docs/guide/README.md', () => {
  // Every ```json block that is a whole file (has "nodes" or "workflows") must check clean too.
  const readme = readFileSync(path.resolve(__dirname, '../../docs/guide/README.md'), 'utf8');
  const blocks = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1] ?? '').filter((text) => /^\s*\{\s*"(format|name|workflows)"/.test(text));
  it('has at least one complete example', () => expect(blocks.length).toBeGreaterThan(0));
  blocks.forEach((text, index) => {
    it(`example ${index + 1} checks clean`, () => {
      const result = parseImport(text, []);
      expect(result.ok, result.ok ? '' : result.error).toBe(true);
      expect(result.issues).toEqual([]);
    });
  });
});
