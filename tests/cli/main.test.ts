import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT, InfraError, main } from '../../packages/cli/index.mjs';
import type { BridgeClient, BridgeSession, Deps, StartOptions } from '../../packages/cli/index.mjs';

type Call = { method: string; params: any; options?: any };

const run = (name: string, status: string, steps: any[] = []) => ({
  id: `run-${name}`,
  workflowId: name,
  workflowName: name,
  trigger: 'manual',
  status,
  startedAt: '2026-11-10T10:00:00.000Z',
  endedAt: '2026-11-10T10:00:01.500Z',
  steps,
});
const failedStep = { nodeId: 'n3', sourceId: 'landed', blockType: 'wait-for', status: 'failed', startedAt: '', attempts: 1, code: 'timeout', error: 'URL did not match /dashboard', locator: 'role=button', url: 'http://x/login' };

function suiteResult(runs: any[], skipped: string[] = []) {
  return {
    name: 'BlockFlow CLI',
    status: runs.every((r) => r.status === 'passed') ? 'passed' : 'failed',
    startedAt: '2026-11-10T10:00:00.000Z',
    finishedAt: '2026-11-10T10:00:03.000Z',
    runs,
    skipped,
  };
}

/** A fake bridge: answers hello/validate/suite.run from `handlers`, records calls and whether it was closed. */
function fakeBridge(handlers: Record<string, (params: any, options?: any) => any> = {}) {
  const calls: Call[] = [];
  const state = { closed: false, startOptions: undefined as StartOptions | undefined };
  const client: BridgeClient = {
    async call(method, params, options) {
      calls.push({ method, params, options });
      const handler = handlers[method];
      if (handler) return handler(params, options);
      if (method === 'hello') return { protocol: 1, extensionVersion: '0.4.0', browser: 'Chromium', extensionId: 'a'.repeat(32) };
      if (method === 'validate') return { ok: true, issues: [], workflows: [{ name: 'w', nodes: 3 }] };
      throw new Error(`unexpected ${method}`);
    },
    close() {},
  };
  const startBridge = async (options: StartOptions): Promise<BridgeSession> => {
    state.startOptions = options;
    return { client, info: { browser: '/usr/bin/chromium', extension: '/ext', extensionId: 'a'.repeat(32) }, close: async () => void (state.closed = true) };
  };
  return { calls, state, startBridge };
}

let dir: string;
let out: string[];
let err: string[];
const script = (name: string) => ({ format: 'blockflow-script', version: 1, name, steps: [] });
const deps = (startBridge: Deps['startBridge'], env: Record<string, string> = {}): Deps => ({
  env,
  cwd: dir,
  stdout: (line) => out.push(line),
  stderr: (line) => err.push(line),
  startBridge,
  onInterrupt: () => () => {},
});

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bf-cli-main-'));
  out = [];
  err = [];
  writeFileSync(path.join(dir, 'pass.script.json'), JSON.stringify(script('pass')));
  writeFileSync(path.join(dir, 'fail.script.json'), JSON.stringify(script('fail')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('blockflow run', () => {
  it('exits 0 when everything passed, sends one inline suite with secrets and formats, writes the reports', async () => {
    const bridge = fakeBridge({
      'suite.run': (_params, options) => {
        options.onNotification({ method: 'suite.progress', params: { requestId: 1, index: 0, total: 1, workflowName: 'pass', status: 'passed' } });
        options.onNotification({ method: 'run.step', params: {} });
        return { result: suiteResult([run('pass', 'passed')]), reports: { junit: '<testsuite/>', html: '<html></html>' } };
      },
    });
    const code = await main(['run', 'pass.script.json', '--report', 'junit,html', '--secret', 'pw=flag', '--timeout', '60'], deps(bridge.startBridge, { BLOCKFLOW_SECRET_API_TOKEN: 'tok' }));
    expect(code).toBe(EXIT.passed);
    const suiteCall = bridge.calls.find((c) => c.method === 'suite.run')!;
    expect(suiteCall.params).toEqual({
      suite: { name: 'BlockFlow CLI', sources: [script('pass')] },
      secrets: { API_TOKEN: 'tok', apiToken: 'tok', pw: 'flag' },
      formats: ['junit', 'html'],
    });
    expect(suiteCall.options.timeoutMs).toBeGreaterThanOrEqual(60_000);
    expect(bridge.calls.map((c) => c.method)).toEqual(['hello', 'validate', 'suite.run']);
    expect(readFileSync(path.join(dir, 'blockflow-report/junit.xml'), 'utf8')).toBe('<testsuite/>');
    expect(readFileSync(path.join(dir, 'blockflow-report/report.html'), 'utf8')).toBe('<html></html>');
    expect(existsSync(path.join(dir, 'blockflow-report/report.json'))).toBe(false);
    expect(out).toContain('  [1/1] pass: passed');
    expect(out).toContain('✓ pass  1.5 s');
    expect(out.at(-3)).toMatch(/^PASSED BlockFlow CLI: 1 passed, 0 failed in 3\.0 s$/);
    expect(bridge.state.closed).toBe(true);
    expect(bridge.state.startOptions).toMatchObject({ headed: false });
  });

  it('exits 1 when a workflow failed and prints the failing step', async () => {
    const bridge = fakeBridge({
      'suite.run': () => ({ result: suiteResult([run('pass', 'passed'), run('fail', 'failed', [failedStep])], ['later']), reports: { junit: '<testsuite failures="1"/>' } }),
    });
    const code = await main(['run', dir, '--report', 'junit', '--out', 'reports'], deps(bridge.startBridge));
    expect(code).toBe(EXIT.failed);
    expect(out).toContain('✗ fail  1.5 s  (failed)');
    expect(out).toContain('    step "landed" (wait-for) timeout: URL did not match /dashboard');
    expect(out).toContain('    locator: role=button');
    expect(out).toContain('- later  (skipped)');
    expect(out.some((line) => line.startsWith('FAILED BlockFlow CLI: 1 passed, 1 failed, 1 skipped'))).toBe(true);
    expect(readFileSync(path.join(dir, 'reports/junit.xml'), 'utf8')).toContain('failures="1"');
    expect(bridge.state.closed).toBe(true);
  });

  it('fetches a suite result that came back as a blob', async () => {
    const payload = Buffer.from(JSON.stringify({ result: suiteResult([run('pass', 'passed')]), reports: { json: '{"big":true}' } }));
    const half = Math.floor(payload.length / 2);
    const bridge = fakeBridge({
      'suite.run': () => ({ blobId: 'b1', size: payload.length }),
      'blob.get': ({ offset }) => {
        const end = offset === 0 ? half : payload.length;
        return { data: payload.subarray(offset, end).toString('base64'), offset, size: payload.length, done: end >= payload.length };
      },
    });
    expect(await main(['run', 'pass.script.json', '--report', 'json'], deps(bridge.startBridge))).toBe(EXIT.passed);
    expect(bridge.calls.filter((c) => c.method === 'blob.get').map((c) => c.params.offset)).toEqual([0, half]);
    expect(readFileSync(path.join(dir, 'blockflow-report/report.json'), 'utf8')).toBe('{"big":true}');
  });

  it('exits 1 without running when a file does not validate, printing path and hint', async () => {
    const bridge = fakeBridge({
      validate: (params) =>
        params.source.name === 'fail'
          ? { ok: false, issues: [{ level: 'error', code: 'config.key.unknown', path: '/steps/0/click/locater', message: 'Unknown setting "locater".', hint: 'Did you mean "locator"?' }], workflows: [] }
          : { ok: true, issues: [{ level: 'warning', code: 'w.x', path: '', message: 'Just a warning.' }], workflows: [] },
    });
    const code = await main(['run', 'pass.script.json', 'fail.script.json'], deps(bridge.startBridge));
    expect(code).toBe(EXIT.failed);
    expect(err).toContain('fail.script.json: error config.key.unknown at /steps/0/click/locater: Unknown setting "locater". (Did you mean "locator"?)');
    expect(out).toContain('pass.script.json: warning w.x: Just a warning.');
    expect(bridge.calls.some((c) => c.method === 'suite.run')).toBe(false);
    expect(bridge.state.closed).toBe(true);
  });

  it('exits 1 for a file that is not JSON, before starting a browser', async () => {
    writeFileSync(path.join(dir, 'broken.json'), '{');
    const bridge = fakeBridge();
    expect(await main(['run', 'broken.json'], deps(bridge.startBridge))).toBe(EXIT.failed);
    expect(bridge.state.startOptions).toBeUndefined();
    expect(err[0]).toMatch(/^broken\.json: error file\.json: not valid JSON/);
  });

  it('exits 1 when suite.run answers invalidWorkflow', async () => {
    const error = Object.assign(new Error('A source did not validate'), { code: -32005, data: { issues: [{ level: 'error', code: 'x', path: '/a', message: 'bad' }] } });
    const bridge = fakeBridge({ 'suite.run': () => Promise.reject(error) });
    expect(await main(['run', 'pass.script.json'], deps(bridge.startBridge))).toBe(EXIT.failed);
    expect(err).toContain('BlockFlow CLI: error x at /a: bad');
  });

  it('exits 2 for usage errors without starting a browser', async () => {
    const bridge = fakeBridge();
    expect(await main(['run', '--report', 'pdf', 'pass.script.json'], deps(bridge.startBridge))).toBe(EXIT.error);
    expect(await main(['run', 'missing.json'], deps(bridge.startBridge))).toBe(EXIT.error);
    expect(err.some((line) => line.includes('--help'))).toBe(true);
    expect(bridge.state.startOptions).toBeUndefined();
  });

  it('exits 2 when the browser or bridge cannot start', async () => {
    const startBridge = async () => {
      throw new InfraError('BlockFlow extension build not found. Build it first: npm run build:automation');
    };
    expect(await main(['run', 'pass.script.json'], deps(startBridge))).toBe(EXIT.error);
    expect(err.at(-1)).toMatch(/npm run build:automation/);
  });

  it('exits 2 on a bridge error and on --timeout, closing the browser', async () => {
    const broken = fakeBridge({ 'suite.run': () => Promise.reject(Object.assign(new Error('Allow outside control is off'), { code: -32002 })) });
    expect(await main(['run', 'pass.script.json'], deps(broken.startBridge))).toBe(EXIT.error);
    expect(broken.state.closed).toBe(true);
    const slow = fakeBridge({ 'suite.run': () => new Promise(() => {}) });
    expect(await main(['run', 'pass.script.json', '--timeout', '0.05'], deps(slow.startBridge))).toBe(EXIT.error);
    expect(err.at(-1)).toMatch(/did not finish within 0.05 s/);
    expect(slow.state.closed).toBe(true);
  });

  it('passes --headed, --browser and --extension to the launcher', async () => {
    const bridge = fakeBridge({ 'suite.run': () => ({ result: suiteResult([run('pass', 'passed')]) }) });
    await main(['run', 'pass.script.json', '--headed', '--browser', '/b', '--extension', 'e'], deps(bridge.startBridge));
    expect(bridge.state.startOptions).toMatchObject({ headed: true, browser: '/b', extension: 'e', cwd: dir });
  });

  it('runs a suite file with stopOnFailure', async () => {
    writeFileSync(path.join(dir, 'smoke.json'), JSON.stringify({ format: 'blockflow-suite', version: 1, name: 'Smoke', stopOnFailure: true, workflows: ['pass.script.json'] }));
    const bridge = fakeBridge({ 'suite.run': () => ({ result: { ...suiteResult([run('pass', 'passed')]), name: 'Smoke' } }) });
    expect(await main(['run', '--suite', 'smoke.json'], deps(bridge.startBridge))).toBe(EXIT.passed);
    expect(bridge.calls.find((c) => c.method === 'suite.run')!.params.suite).toEqual({ name: 'Smoke', sources: [script('pass')], stopOnFailure: true });
  });
});

describe('blockflow validate', () => {
  it('exits 0 when all files validate and 1 when one has errors', async () => {
    const ok = fakeBridge();
    expect(await main(['validate', 'pass.script.json'], deps(ok.startBridge))).toBe(EXIT.passed);
    expect(out).toContain('pass.script.json: ok (w, 3 blocks)');
    const bad = fakeBridge({ validate: () => ({ ok: false, issues: [{ level: 'error', code: 'c', path: '/x', message: 'm', hint: 'h' }], workflows: [] }) });
    expect(await main(['validate', 'pass.script.json'], deps(bad.startBridge))).toBe(EXIT.failed);
    expect(err).toContain('pass.script.json: error c at /x: m (h)');
    expect(bad.calls.some((c) => c.method === 'suite.run')).toBe(false);
  });
});

describe('help', () => {
  it('prints usage with exit 0', async () => {
    expect(await main(['--help'], deps(fakeBridge().startBridge))).toBe(EXIT.passed);
    expect(out[0]).toMatch(/^Usage:/);
  });
});

describe('secret warnings', () => {
  it('drops "secret does not exist yet" warnings for secrets the run brings', async () => {
    const warning = (name: string) => ({ level: 'warning', code: 'secret.unknown', path: '/s', message: `uses the secret "${name}", which does not exist yet.` });
    const bridge = fakeBridge({
      validate: () => ({ ok: true, issues: [warning('loginPassword'), warning('other')], workflows: [] }),
      'suite.run': () => ({ result: suiteResult([run('pass', 'passed')]) }),
    });
    expect(await main(['run', 'pass.script.json'], deps(bridge.startBridge, { BLOCKFLOW_SECRET_LOGIN_PASSWORD: 'x' }))).toBe(EXIT.passed);
    expect(out.filter((line) => line.includes('secret.unknown'))).toEqual(['pass.script.json: warning secret.unknown at /s: uses the secret "other", which does not exist yet.']);
  });
});
