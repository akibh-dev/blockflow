// The `blockflow` commands. Everything outside (environment, output, the browser + bridge) is injected,
// so tests/cli runs the whole flow with a fake bridge and no browser.
import path from 'node:path';
import { BRIDGE_PROTOCOL_VERSION, RPC_ERRORS } from 'blockflow-bridge/protocol';
import { HELP, UsageError, parseCliArgs } from './args.mjs';
import { InfraError, startBridge as realStartBridge } from './browser.mjs';
import { collectInputs } from './inputs.mjs';
import { issueLines, resolveBlob, summaryLines, writeReports } from './reports.mjs';
import { collectSecrets } from './secrets.mjs';

export const EXIT = Object.freeze({ passed: 0, failed: 1, error: 2 });
export const VERSION = '1.0.0';

/**
 * @typedef {import('./browser.mjs').BridgeSession} BridgeSession
 * @typedef {import('./browser.mjs').StartOptions} StartOptions
 * @typedef {{
 *   env?: Record<string, string | undefined>,
 *   cwd?: string,
 *   stdout?: (line: string) => void,
 *   stderr?: (line: string) => void,
 *   startBridge?: (options: StartOptions) => Promise<BridgeSession>,
 *   onInterrupt?: (handler: (signal: string) => void) => () => void,
 * }} Deps
 *   `onInterrupt` registers a Ctrl-C / SIGTERM handler and returns a function that removes it.
 */

/** @param {(signal: string) => void} handler */
function processInterrupts(handler) {
  const onInt = () => handler('SIGINT');
  const onTerm = () => handler('SIGTERM');
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  return () => {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  };
}

/** @param {unknown} error */
const isRpcError = (error) => !!error && typeof error === 'object' && typeof (/** @type {any} */ (error).code) === 'number';

/**
 * Runs the CLI and resolves with the exit code (0 passed, 1 failed or invalid, 2 usage or infrastructure).
 * @param {string[]} argv
 * @param {Deps} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const out = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const startBridge = deps.startBridge ?? realStartBridge;
  const onInterrupt = deps.onInterrupt ?? processInterrupts;

  /** @type {import('./args.mjs').CliOptions} */
  let options;
  /** @type {import('./inputs.mjs').CollectedSuite} */
  let collected;
  try {
    options = parseCliArgs(argv);
    if (options.command === 'help') {
      out(HELP);
      return EXIT.passed;
    }
    if (options.command === 'version') {
      out(`blockflow ${VERSION}`);
      return EXIT.passed;
    }
    collected = collectInputs({ inputs: options.inputs, suite: options.suite, cwd });
  } catch (error) {
    if (error instanceof UsageError) {
      err(`blockflow: ${error.message}`);
      err('Run "blockflow --help" for usage.');
      return EXIT.error;
    }
    throw error;
  }

  // Files that are not JSON fail before a browser is started.
  const unreadable = collected.files.filter((file) => file.parseError);
  for (const file of unreadable) err(`${file.display}: error file.json: ${file.parseError}`);
  if (unreadable.length > 0) return EXIT.failed;

  /** @type {BridgeSession | undefined} */
  let session;
  let interrupted = false;
  const removeInterrupt = onInterrupt((signal) => {
    if (interrupted) return;
    interrupted = true;
    err(`blockflow: ${signal}, closing the browser`);
    // Cleanup, then exit with the conventional 128 + signal number.
    void Promise.resolve(session?.close()).finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  });

  try {
    session = await startBridge({ headed: options.headed, browser: options.browser, extension: options.extension, env, cwd, log: err });
    const { client } = session;
    const hello = await client.call('hello', { protocol: BRIDGE_PROTOCOL_VERSION, client: 'blockflow-runner' });
    err(`BlockFlow ${hello?.extensionVersion ?? '?'} in ${hello?.browser ?? path.basename(session.info.browser)}`);

    // Validate every file first, so problems point at the file they are in. The checker does not know the
    // secrets this run brings, so its "secret does not exist yet" warnings for those are dropped.
    const secrets = options.command === 'run' ? collectSecrets(env, options.secrets) : {};
    let invalid = false;
    for (const file of collected.files) {
      const report = await client.call('validate', { source: file.source });
      const issues = (report?.issues ?? []).filter((issue) => !(issue.code === 'secret.unknown' && Object.keys(secrets).some((name) => issue.message?.includes(`"${name}"`))));
      for (const issue of issues) (issue.level === 'error' ? err : out)(issueLines(file.display, [issue])[0]);
      if (!report?.ok) invalid = true;
      else if (options.command === 'validate') out(`${file.display}: ok (${(report.workflows ?? []).map((w) => `${w.name}, ${w.nodes} blocks`).join('; ')})`);
    }
    if (options.command === 'validate') return invalid ? EXIT.failed : EXIT.passed;
    if (invalid) {
      err('Not run: fix the validation errors above.');
      return EXIT.failed;
    }

    out(`Running suite "${collected.name}" (${collected.files.length} file${collected.files.length === 1 ? '' : 's'})`);
    const timeoutMs = options.timeoutSeconds * 1000;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new InfraError(`The run did not finish within ${options.timeoutSeconds} s (--timeout).`)), timeoutMs);
    });
    let raw;
    try {
      raw = await Promise.race([
        client.call(
          'suite.run',
          {
            suite: { name: collected.name, sources: collected.files.map((file) => file.source), ...(collected.stopOnFailure !== undefined ? { stopOnFailure: collected.stopOnFailure } : {}) },
            ...(Object.keys(secrets).length ? { secrets } : {}),
            ...(options.reports.length ? { formats: options.reports } : {}),
          },
          {
            timeoutMs: timeoutMs + 5_000,
            onNotification: (notification) => {
              if (notification.method !== 'suite.progress') return;
              const p = notification.params;
              out(`  [${p.index + 1}/${p.total}] ${p.workflowName}: ${p.status}`);
            },
          },
        ),
        timedOut,
      ]);
    } finally {
      clearTimeout(timer);
    }
    const { result, reports } = await resolveBlob(client, raw);

    for (const line of summaryLines(result)) out(line);
    const { written, missing } = writeReports(path.resolve(cwd, options.out), reports, options.reports);
    for (const file of written) out(`report: ${path.relative(cwd, file) || file}`);
    if (missing.length) err(`blockflow: the extension returned no ${missing.join(', ')} report`);
    return result.status === 'passed' ? EXIT.passed : EXIT.failed;
  } catch (error) {
    if (interrupted) return EXIT.error;
    if (isRpcError(error) && /** @type {any} */ (error).code === RPC_ERRORS.invalidWorkflow) {
      const issues = /** @type {any} */ (error).data?.issues ?? [];
      err(`blockflow: ${/** @type {Error} */ (error).message}`);
      for (const line of issueLines(collected.name, issues)) err(line);
      return EXIT.failed;
    }
    const message = /** @type {Error} */ (error)?.message ?? String(error);
    err(`blockflow: ${message}`);
    if (!(error instanceof InfraError) && !isRpcError(error) && env.BLOCKFLOW_DEBUG) err(String(/** @type {Error} */ (error).stack));
    return EXIT.error;
  } finally {
    removeInterrupt();
    if (!interrupted) await session?.close();
  }
}
