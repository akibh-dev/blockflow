import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SUITE_NAME, UsageError, collectInputs, findWorkflowFiles } from '../../packages/cli/index.mjs';

const script = (name: string) => ({ format: 'blockflow-script', version: 1, name, steps: [] });
let dir: string;
const write = (rel: string, value: unknown) => {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
};
const names = (files: { display: string }[]) => files.map((file) => file.display);

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bf-cli-inputs-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('findWorkflowFiles', () => {
  it('finds scripts, graph files and workflow-shaped JSON recursively, sorted, skipping the rest', () => {
    write('b.script.json', script('b'));
    write('a.blockflow.json', { format: 'blockflow-workflows', version: 1, workflows: [] });
    write('nested/one.json', { schemaVersion: 2, id: 'x', name: 'x', nodes: [], edges: [] });
    write('nested/package.json', { name: 'pkg' });
    write('nested/suite.json', { format: 'blockflow-suite', name: 's', workflows: ['../b.script.json'] });
    write('node_modules/c.script.json', script('c'));
    write('.hidden/d.script.json', script('d'));
    write('notes.txt', 'hi');
    write('broken.json', '{');
    expect(findWorkflowFiles(dir).map((file) => path.relative(dir, file))).toEqual(['a.blockflow.json', 'b.script.json', path.join('nested', 'one.json')]);
  });
});

describe('collectInputs', () => {
  it('runs plain files and directories as one inline suite, in argument order, without duplicates', () => {
    write('flows/x.script.json', script('x'));
    write('flows/y.script.json', script('y'));
    write('z.script.json', script('z'));
    const collected = collectInputs({ inputs: ['z.script.json', 'flows', 'flows/x.script.json'], cwd: dir });
    expect(collected.name).toBe(DEFAULT_SUITE_NAME);
    expect(names(collected.files)).toEqual(['z.script.json', path.join('flows', 'x.script.json'), path.join('flows', 'y.script.json')]);
    expect(collected.files[0].source).toEqual(script('z'));
  });

  it('keeps an explicitly named file that is not JSON as a parse error', () => {
    write('bad.json', 'nope');
    const [file] = collectInputs({ inputs: ['bad.json'], cwd: dir }).files;
    expect(file.parseError).toMatch(/not valid JSON/);
    expect(file.source).toBeUndefined();
  });

  it('rejects missing paths and empty directories', () => {
    expect(() => collectInputs({ inputs: ['missing.json'], cwd: dir })).toThrow(UsageError);
    mkdirSync(path.join(dir, 'empty'));
    expect(() => collectInputs({ inputs: ['empty'], cwd: dir })).toThrow(/No workflow files/);
  });

  it('runs --suite <file> with paths relative to the suite file', () => {
    write('suites/flows/a.script.json', script('a'));
    write('suites/smoke.json', { format: 'blockflow-suite', version: 1, name: 'Smoke', stopOnFailure: true, workflows: ['flows/a.script.json', 'flows'] });
    const collected = collectInputs({ inputs: [], suite: 'suites/smoke.json', cwd: dir });
    expect(collected).toMatchObject({ name: 'Smoke', stopOnFailure: true });
    expect(names(collected.files)).toEqual([path.join('suites', 'flows', 'a.script.json')]);
  });

  it('picks one suite of several with <file>#<name> or by name', () => {
    write('a.script.json', script('a'));
    write('b.script.json', script('b'));
    write('all.json', { format: 'blockflow-suite', version: 1, suites: [{ name: 'A', workflows: ['a.script.json'] }, { name: 'B', workflows: ['b.script.json'] }] });
    expect(names(collectInputs({ inputs: [], suite: 'all.json#B', cwd: dir }).files)).toEqual(['b.script.json']);
    expect(names(collectInputs({ inputs: ['all.json'], suite: 'A', cwd: dir }).files)).toEqual(['a.script.json']);
    expect(() => collectInputs({ inputs: [], suite: 'all.json', cwd: dir })).toThrow(/several suites/);
    expect(() => collectInputs({ inputs: [], suite: 'all.json#C', cwd: dir })).toThrow(/No suite "C"/);
    expect(() => collectInputs({ inputs: ['all.json'], cwd: dir })).toThrow(/several suites/);
  });

  it('looks a suite name up in ./blockflow.suites.json', () => {
    write('a.script.json', script('a'));
    write('blockflow.suites.json', { format: 'blockflow-suite', version: 1, suites: [{ name: 'Nightly', workflows: ['a.script.json'] }] });
    expect(collectInputs({ inputs: [], suite: 'Nightly', cwd: dir }).name).toBe('Nightly');
    expect(() => collectInputs({ inputs: [], suite: 'Weekly', cwd: dir })).toThrow(/No suite named "Weekly"/);
  });

  it('runs a single-suite file given as the only input', () => {
    write('a.script.json', script('a'));
    write('s.json', { format: 'blockflow-suite', version: 1, name: 'S', workflows: ['a.script.json'] });
    expect(collectInputs({ inputs: ['s.json'], cwd: dir }).name).toBe('S');
  });

  it('rejects mixing --suite with workflow files and malformed suites', () => {
    write('a.script.json', script('a'));
    write('s.json', { format: 'blockflow-suite', version: 1, name: 'S', workflows: ['a.script.json'] });
    write('bad.json', { format: 'blockflow-suite', version: 1, name: 'Bad', workflows: [] });
    expect(() => collectInputs({ inputs: ['a.script.json'], suite: 's.json', cwd: dir })).toThrow(/With --suite/);
    expect(() => collectInputs({ inputs: ['a.script.json', 's.json'], cwd: dir })).toThrow(UsageError);
    expect(() => collectInputs({ inputs: [], suite: 'bad.json', cwd: dir })).toThrow(/non-empty list/);
    expect(() => collectInputs({ inputs: [], suite: 'a.script.json', cwd: dir })).toThrow(/not a suite file/);
    expect(() => collectInputs({ inputs: [], suite: 'Nope', cwd: dir })).toThrow(/no suite files/);
  });
});
