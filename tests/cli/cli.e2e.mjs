// End-to-end check of the `blockflow` CLI against a real browser: starts the fixture server
// (tests/e2e/server.mjs), writes a passing and a failing workflow script, runs
// `node packages/cli/cli.mjs run <dir> --report junit,json --out <dir>` and checks the exit code,
// the console summary and the JUnit file. The passing workflow logs in with a secret from
// BLOCKFLOW_SECRET_LOGIN_PASSWORD (→ {{secret.loginPassword}}).
//
//   BF_OUT_DIR=.output-cli BF_AUTOMATION=1 npx wxt build     (or: npm run build:automation)
//   node tests/cli/cli.e2e.mjs [--extension .output-cli/chrome-mv3] [--headed]
//
// BLOCKFLOW_BROWSER / BF_BROWSER pick the browser, as for the CLI. Exits 0 when every check passed.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASSWORD, startServer } from '../e2e/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const extensionAt = args.indexOf('--extension');
const extension = extensionAt >= 0 ? args[extensionAt + 1] : (process.env.BLOCKFLOW_EXTENSION ?? '.output-automation/chrome-mv3');
const headed = args.includes('--headed');

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
const work = mkdtempSync(path.join(os.tmpdir(), 'blockflow-cli-e2e-'));
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

/** Runs the CLI; resolves with its exit code and output. */
function cli(argv, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'packages/cli/cli.mjs'), ...argv], { cwd: work, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

try {
  const flows = path.join(work, 'flows');
  mkdirSync(flows, { recursive: true });
  const write = (name, value) => writeFileSync(path.join(flows, name), JSON.stringify(value, null, 2));
  write('1-login.script.json', {
    format: 'blockflow-script',
    version: 1,
    name: 'CLI login passes',
    steps: [
      { id: 'open', open: { url: `${base}/login.html`, where: 'new' } },
      { id: 'form', 'fill-form': { fields: [{ locator: 'label=Email', value: 'cli@example.com' }, { locator: 'label=Password', value: '{{secret.loginPassword}}' }], submit: 'role=button[name="Sign in"]' } },
      { id: 'landed', 'wait-for': { mode: 'url', url: '/welcome.html' }, step: { timeoutSeconds: 15 } },
      { id: 'greets', assert: { locator: 'role=heading[level=1]', expected: 'Welcome' } },
    ],
  });
  write('2-broken.script.json', {
    format: 'blockflow-script',
    version: 1,
    name: 'CLI heading fails',
    steps: [
      { id: 'open', open: { url: `${base}/login.html`, where: 'new' } },
      { id: 'heading', assert: { locator: 'role=heading[level=1]', operator: 'equals', expected: 'Not this heading' }, step: { timeoutSeconds: 3 } },
    ],
  });

  console.log('blockflow validate');
  const validate = await cli(['validate', 'flows', '--extension', path.resolve(root, extension), ...(headed ? ['--headed'] : [])]);
  check('validate exits 0 for valid files', validate.code === 0, `exit ${validate.code}\n${validate.stdout}${validate.stderr}`);

  console.log('blockflow run (one passing, one failing workflow)');
  const run = await cli(['run', 'flows', '--extension', path.resolve(root, extension), '--report', 'junit,json', '--out', 'out', '--timeout', '180', ...(headed ? ['--headed'] : [])], {
    BLOCKFLOW_SECRET_LOGIN_PASSWORD: PASSWORD,
  });
  check('run exits 1 (a workflow failed)', run.code === 1, `exit ${run.code}\n${run.stdout}${run.stderr}`);
  check('summary shows the passing workflow', /✓ CLI login passes/.test(run.stdout), run.stdout);
  check('summary shows the failing workflow and its step', /✗ CLI heading fails/.test(run.stdout) && /step "heading" \(assert\)/.test(run.stdout), run.stdout);
  const junitFile = path.join(work, 'out/junit.xml');
  const junit = existsSync(junitFile) ? readFileSync(junitFile, 'utf8') : '';
  check('junit.xml written', junit.length > 0, run.stderr);
  check('junit has two testcases and one failure', (junit.match(/<testcase\b/g) ?? []).length === 2 && (junit.match(/<failure\b/g) ?? []).length === 1, junit.slice(0, 600));
  check('report.json written', existsSync(path.join(work, 'out/report.json')));
  console.log(`\n--- CLI output (run) ---\n${run.stdout}${run.stderr}`);
} finally {
  server.close();
  rmSync(work, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll CLI checks passed');
process.exit(failures ? 1 : 0);
