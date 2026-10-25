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
      if (!result.ok) return;
      for (const workflow of result.workflows) {
        const errors = validateWorkflow(workflow, registry).filter((issue) => issue.level === 'error');
        expect(errors, `${workflow.name}: ${errors.map((issue) => issue.message).join('; ')}`).toEqual([]);
      }
    });
  }
});
