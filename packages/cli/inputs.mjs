// Turns the CLI's file, directory and --suite arguments into one inline suite (name + workflow sources).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { UsageError } from './args.mjs';

export const SUITE_FORMAT = 'blockflow-suite';
/** Suite file looked up in the working directory when `--suite <name>` is given without a suite file. */
export const DEFAULT_SUITES_FILE = 'blockflow.suites.json';
/** Name of the inline suite when plain workflow files are run. */
export const DEFAULT_SUITE_NAME = 'BlockFlow CLI';

/**
 * @typedef {{ path: string, display: string, source?: unknown, parseError?: string }} InputFile
 *   `source` is the parsed JSON; `parseError` is set instead when the file is not valid JSON.
 * @typedef {{ name: string, stopOnFailure?: boolean, files: InputFile[] }} CollectedSuite
 * @typedef {{ name: string, workflows: string[], stopOnFailure?: boolean }} SuiteEntry
 */

/** True for a parsed file that BlockFlow can import: a script, a graph file or one workflow. */
export function isWorkflowSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const format = /** @type {{format?: unknown}} */ (value).format;
  if (format === 'blockflow-script' || format === 'blockflow-workflows') return true;
  return format === undefined && Array.isArray(/** @type {any} */ (value).nodes);
}

/** True for a parsed suite file (`"format": "blockflow-suite"`). */
export function isSuiteFile(value) {
  return !!value && typeof value === 'object' && /** @type {{format?: unknown}} */ (value).format === SUITE_FORMAT;
}

/** @param {string} file */
function readJson(file) {
  const text = readFileSync(file, 'utf8');
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: `not valid JSON: ${/** @type {Error} */ (error).message}` };
  }
}

/**
 * Workflow files inside `dir`, recursively, sorted: every `*.script.json` and `*.blockflow.json`, plus other
 * `*.json` files that look like a workflow (a script, a graph file or one workflow). `node_modules` and
 * dot-folders are skipped; suite files and unrelated JSON (package.json, reports) are ignored.
 * @param {string} dir
 * @returns {string[]}
 */
export function findWorkflowFiles(dir) {
  /** @type {string[]} */
  const found = [];
  const walk = (/** @type {string} */ current) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        if (entry.name.endsWith('.script.json') || entry.name.endsWith('.blockflow.json')) {
          found.push(full);
          continue;
        }
        const { value } = readJson(full);
        if (isWorkflowSource(value)) found.push(full);
      }
    }
  };
  walk(dir);
  return found;
}

/**
 * Expands files and directories into workflow files (in argument order, directories sorted).
 * @param {string[]} items absolute or relative to `base`
 * @param {string} base
 * @param {string} cwd for the `display` paths
 * @returns {InputFile[]}
 */
function expand(items, base, cwd) {
  /** @type {InputFile[]} */
  const files = [];
  const seen = new Set();
  for (const item of items) {
    const full = path.resolve(base, item);
    if (!existsSync(full)) throw new UsageError(`No such file or directory: ${item}`);
    const list = statSync(full).isDirectory() ? findWorkflowFiles(full) : [full];
    if (list.length === 0) throw new UsageError(`No workflow files (*.script.json, *.blockflow.json, *.json) in ${item}`);
    for (const file of list) {
      if (seen.has(file)) continue;
      seen.add(file);
      const { value, error } = readJson(file);
      files.push({ path: file, display: path.relative(cwd, file) || file, ...(error ? { parseError: error } : { source: value }) });
    }
  }
  return files;
}

/**
 * The suites in a suite file: either one suite (`{format, version, name, workflows, stopOnFailure?}`) or
 * several (`{format, version, suites: [...]}`).
 * @param {any} value
 * @param {string} file for messages
 * @returns {SuiteEntry[]}
 */
export function suitesIn(value, file) {
  const list = Array.isArray(value.suites) ? value.suites : [value];
  return list.map((/** @type {any} */ entry, /** @type {number} */ index) => {
    const where = Array.isArray(value.suites) ? `${file} suites[${index}]` : file;
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) throw new UsageError(`${where}: a suite needs a "name".`);
    if (!Array.isArray(entry.workflows) || entry.workflows.length === 0 || entry.workflows.some((/** @type {unknown} */ w) => typeof w !== 'string')) {
      throw new UsageError(`${where}: "workflows" must be a non-empty list of file or directory paths (relative to the suite file).`);
    }
    if (entry.stopOnFailure !== undefined && typeof entry.stopOnFailure !== 'boolean') throw new UsageError(`${where}: "stopOnFailure" must be true or false.`);
    return { name: entry.name, workflows: entry.workflows, ...(entry.stopOnFailure !== undefined ? { stopOnFailure: entry.stopOnFailure } : {}) };
  });
}

/** @param {string} file */
function loadSuiteFile(file) {
  const { value, error } = readJson(file);
  if (error) throw new UsageError(`${file}: ${error}`);
  if (!isSuiteFile(value)) throw new UsageError(`${file} is not a suite file (it needs "format": "${SUITE_FORMAT}").`);
  return suitesIn(value, file);
}

/**
 * Resolves the CLI inputs into one suite.
 *
 * - Plain files and directories: one inline suite named `BlockFlow CLI` with every workflow file found.
 * - `--suite <file>`: the suite in that suite file (`<file>#<name>` picks one when it holds several).
 * - `--suite <name>`: the suite of that name in the suite files given as inputs, else in `./blockflow.suites.json`.
 * - One suite file as the only input: its suite (it must hold exactly one).
 * Workflow paths in a suite file are relative to the suite file. Throws `UsageError` for anything ambiguous.
 * @param {{ inputs: string[], suite?: string, cwd: string }} options
 * @returns {CollectedSuite}
 */
export function collectInputs({ inputs, suite, cwd }) {
  // Split explicit suite files from workflow inputs.
  /** @type {{ file: string, suites: SuiteEntry[] }[]} */
  const suiteFiles = [];
  /** @type {string[]} */
  const workflowInputs = [];
  for (const item of inputs) {
    const full = path.resolve(cwd, item);
    if (existsSync(full) && statSync(full).isFile()) {
      const { value } = readJson(full);
      if (isSuiteFile(value)) {
        suiteFiles.push({ file: full, suites: suitesIn(value, item) });
        continue;
      }
    }
    workflowInputs.push(item);
  }

  /** @type {{ entry: SuiteEntry, file: string } | undefined} */
  let chosen;
  if (suite !== undefined) {
    if (workflowInputs.length > 0) {
      throw new UsageError(`With --suite, the workflows come from the suite file; remove ${workflowInputs.join(', ')} (or list them in the suite).`);
    }
    const hash = suite.lastIndexOf('#');
    const [fileArg, nameArg] = hash > 0 ? [suite.slice(0, hash), suite.slice(hash + 1)] : [suite, undefined];
    const asFile = path.resolve(cwd, fileArg);
    if (existsSync(asFile) && statSync(asFile).isFile()) {
      const suites = loadSuiteFile(asFile);
      const entry = nameArg !== undefined ? suites.find((s) => s.name === nameArg) : suites.length === 1 ? suites[0] : undefined;
      if (!entry) {
        const names = suites.map((s) => `"${s.name}"`).join(', ');
        throw new UsageError(nameArg !== undefined ? `No suite "${nameArg}" in ${fileArg} (it has ${names}).` : `${fileArg} holds several suites (${names}): pick one with --suite ${fileArg}#<name>.`);
      }
      chosen = { entry, file: asFile };
    } else {
      const pool = suiteFiles.length > 0 ? suiteFiles : existsSync(path.join(cwd, DEFAULT_SUITES_FILE)) ? [{ file: path.join(cwd, DEFAULT_SUITES_FILE), suites: loadSuiteFile(path.join(cwd, DEFAULT_SUITES_FILE)) }] : [];
      if (pool.length === 0) throw new UsageError(`--suite ${suite}: no such suite file, and no suite files to look the name up in (pass one, or create ${DEFAULT_SUITES_FILE}).`);
      for (const { file, suites } of pool) {
        const entry = suites.find((s) => s.name === suite);
        if (entry) {
          chosen = { entry, file };
          break;
        }
      }
      if (!chosen) {
        const names = pool.flatMap(({ suites }) => suites.map((s) => `"${s.name}"`)).join(', ');
        throw new UsageError(`No suite named "${suite}" (found ${names || 'none'}).`);
      }
    }
  } else if (suiteFiles.length > 0) {
    if (suiteFiles.length > 1 || workflowInputs.length > 0) throw new UsageError('A suite file runs on its own: run one suite at a time, or pick one with --suite <name>.');
    const [{ file, suites }] = suiteFiles;
    if (suites.length !== 1) throw new UsageError(`${path.relative(cwd, file)} holds several suites: pick one with --suite <name>.`);
    chosen = { entry: suites[0], file };
  }

  if (chosen) {
    const files = expand(chosen.entry.workflows, path.dirname(chosen.file), cwd);
    return { name: chosen.entry.name, ...(chosen.entry.stopOnFailure !== undefined ? { stopOnFailure: chosen.entry.stopOnFailure } : {}), files };
  }
  return { name: DEFAULT_SUITE_NAME, files: expand(workflowInputs, cwd, cwd) };
}
