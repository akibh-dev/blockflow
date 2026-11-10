// Command-line parsing for `blockflow` (node:util parseArgs, no dependencies).
import { parseArgs } from 'node:util';

/** Report formats the CLI can write, and the file each one goes to inside `--out`. */
export const REPORT_FILES = Object.freeze({ junit: 'junit.xml', json: 'report.json', html: 'report.html' });
export const DEFAULT_OUT_DIR = 'blockflow-report';
/** Default overall limit for one `blockflow run` (the whole suite), in seconds. */
export const DEFAULT_TIMEOUT_SECONDS = 1800;

/** A mistake in how the CLI was called: printed with a pointer to `--help`, exit code 2. */
export class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export const HELP = `Usage:
  blockflow run <file|dir>... [options]      run workflows in a fresh Chromium with the extension
  blockflow run --suite <file|name> [files]  run a suite file (see docs/wiki/CLI.md)
  blockflow validate <file|dir>...           check workflow files without running them

Inputs: *.script.json, *.blockflow.json and workflow *.json files; directories are searched recursively.

Options (run):
  --suite <file|name>     a suite file, or a suite name looked up in the suite files given as inputs
                          (or ./blockflow.suites.json)
  --report <format>       junit, json or html; repeat or comma-separate (default: none)
  --out <dir>             where reports go (default: ${DEFAULT_OUT_DIR})
  --secret <name=value>   a secret for this run; repeatable; wins over BLOCKFLOW_SECRET_<NAME>
  --timeout <seconds>     overall time limit for the run (default: ${DEFAULT_TIMEOUT_SECONDS})
Options (run, validate):
  --headed                show the browser window (default: headless)
  --browser <path>        Chromium-based browser to use (or BLOCKFLOW_BROWSER)
  --extension <dir>       unpacked extension build (default: .output-automation/chrome-mv3)
  -h, --help              this help
  -v, --version           print the version

Exit codes: 0 all passed, 1 a workflow failed or did not validate, 2 usage or infrastructure error.`;

/**
 * @typedef {'junit' | 'json' | 'html'} ReportFormat
 * @typedef {{
 *   command: 'run' | 'validate' | 'help' | 'version',
 *   inputs: string[],
 *   suite?: string,
 *   reports: ReportFormat[],
 *   out: string,
 *   headed: boolean,
 *   browser?: string,
 *   extension?: string,
 *   timeoutSeconds: number,
 *   secrets: Record<string, string>,
 * }} CliOptions
 */

/**
 * Parses `argv` (without `node` and the script). Throws `UsageError` for anything wrong.
 * @param {string[]} argv
 * @returns {CliOptions}
 */
export function parseCliArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        suite: { type: 'string' },
        report: { type: 'string', multiple: true },
        out: { type: 'string' },
        headed: { type: 'boolean' },
        browser: { type: 'string' },
        extension: { type: 'string' },
        timeout: { type: 'string' },
        secret: { type: 'string', multiple: true },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    throw new UsageError(/** @type {Error} */ (error).message);
  }
  const { values, positionals } = parsed;
  const base = {
    inputs: [],
    reports: /** @type {ReportFormat[]} */ ([]),
    out: DEFAULT_OUT_DIR,
    headed: false,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    secrets: {},
  };
  if (values.version) return { ...base, command: 'version' };
  const [command, ...inputs] = positionals;
  if (values.help || command === undefined || command === 'help') return { ...base, command: 'help' };
  if (command !== 'run' && command !== 'validate') throw new UsageError(`Unknown command "${command}". Use "run" or "validate".`);

  const reports = /** @type {ReportFormat[]} */ ([]);
  for (const item of (values.report ?? []).flatMap((value) => value.split(','))) {
    const format = item.trim().toLowerCase();
    if (!format) continue;
    if (!Object.hasOwn(REPORT_FILES, format)) throw new UsageError(`Unknown report format "${item}". Use junit, json or html.`);
    if (!reports.includes(/** @type {ReportFormat} */ (format))) reports.push(/** @type {ReportFormat} */ (format));
  }

  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  if (values.timeout !== undefined) {
    timeoutSeconds = Number(values.timeout);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new UsageError(`--timeout must be a positive number of seconds, got "${values.timeout}".`);
  }

  /** @type {Record<string, string>} */
  const secrets = {};
  for (const pair of values.secret ?? []) {
    const at = pair.indexOf('=');
    if (at <= 0) throw new UsageError(`--secret needs name=value, got "${pair}".`);
    secrets[pair.slice(0, at)] = pair.slice(at + 1);
  }

  if (command === 'validate') {
    for (const flag of ['suite', 'report', 'out', 'secret', 'timeout']) {
      if (values[/** @type {keyof typeof values} */ (flag)] !== undefined) throw new UsageError(`--${flag} only applies to "blockflow run".`);
    }
  }
  if (inputs.length === 0 && !(command === 'run' && values.suite)) {
    throw new UsageError(`"blockflow ${command}" needs at least one file or directory${command === 'run' ? ' (or --suite)' : ''}.`);
  }

  return {
    command,
    inputs,
    suite: values.suite,
    reports,
    out: values.out ?? DEFAULT_OUT_DIR,
    headed: values.headed ?? false,
    browser: values.browser,
    extension: values.extension,
    timeoutSeconds,
    secrets,
  };
}
