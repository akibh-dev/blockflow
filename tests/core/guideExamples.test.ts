import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../src/core/blocks';
import { parseImport } from '../../src/core/library';
import { compileScript, compileScriptFile, decompile, sameScriptGraph } from '../../src/core/script';
import type { Workflow } from '../../src/core/types';
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

// The script versions (*.script.json) compile to the same graphs as the graph files, and every graph
// example survives graph → decompile → compile (same blocks, configs, step settings and wiring by id).
describe('docs/guide/examples as scripts', () => {
  const graphs = readdirSync(dir).filter((name) => name.endsWith('.blockflow.json'));
  for (const file of graphs) {
    const raw = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    const rawList: Workflow[] = raw.workflows ?? [raw];
    const withOrigin = (workflow: Workflow): Workflow => ({ ...workflow, nodes: workflow.nodes.map((node) => ({ ...node, origin: node.id })) });

    it(`${file}: round trip`, () => {
      for (const workflow of rawList) {
        const script = decompile(withOrigin(workflow), registry);
        expect(script, workflow.name).not.toBeNull();
        const back = compileScript(script, registry);
        expect(back.issues).toEqual([]);
        expect(sameScriptGraph(workflow, back.workflow as Workflow, registry)).toBe(true);
      }
    });

    const scriptFile = file.replace('.blockflow.json', '.script.json');
    it(`${scriptFile}: same graph as ${file}, imports cleanly`, () => {
      const text = readFileSync(path.join(dir, scriptFile), 'utf8');
      const compiled = compileScriptFile(JSON.parse(text), registry);
      expect(compiled.issues).toEqual([]);
      expect(compiled.scripts).toHaveLength(rawList.length);
      compiled.scripts.forEach((script, index) => {
        expect(sameScriptGraph(rawList[index] as Workflow, script.workflow as Workflow, registry)).toBe(true);
      });
      const result = parseImport(text, []);
      expect(result.ok, result.ok ? '' : result.error).toBe(true);
      if (!result.ok) return;
      for (const workflow of result.workflows) {
        const errors = validateWorkflow(workflow, registry).filter((issue) => issue.level === 'error');
        expect(errors, `${workflow.name}: ${errors.map((issue) => issue.message).join('; ')}`).toEqual([]);
      }
    });
  }
});
