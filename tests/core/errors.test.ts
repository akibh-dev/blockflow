import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CodedError, ERROR_CODES, errorDetails } from '../../src/core/errors';
import { REPORT_SCHEMA_VERSION, toJsonReport, toJUnitXml } from '../../src/core/report';
import { FakeHost, flow, harness } from '../helpers/fakeHost';

const start = { id: 's', type: 'start', config: {} };
const open = { id: 'o', type: 'open-url', config: { url: 'https://shop.test/' } };

describe('errorDetails', () => {
  it('reads coded errors, also across bundles (duck-typed), and defaults to step.failed', () => {
    expect(errorDetails(new CodedError('locator.strict', 'two', { locator: 'button', matches: ['a', 'b', 'c', 'd', 'e', 'f'] }))).toEqual({
      code: 'locator.strict',
      locator: 'button',
      matches: ['a', 'b', 'c', 'd', 'e'],
    });
    expect(errorDetails(Object.assign(new Error('x'), { code: 'http.status', url: 'https://a.test' }))).toEqual({ code: 'http.status', url: 'https://a.test' });
    expect(errorDetails(Object.assign(new Error('x'), { code: 'ENOENT' }))).toEqual({ code: 'step.failed' });
    expect(errorDetails('plain')).toEqual({ code: 'step.failed' });
  });

  it('documents every code', () => {
    for (const [code, entry] of Object.entries(ERROR_CODES)) {
      expect(code).toMatch(/^[a-z]+(\.[a-z-]+)?$/);
      expect(entry.meaning.length).toBeGreaterThan(10);
      expect(entry.fix.length).toBeGreaterThan(5);
    }
  });

  it('every code has a row in the usage guide and in Troubleshooting', () => {
    const guide = readFileSync('docs/guide/README.md', 'utf8');
    const troubleshooting = readFileSync('docs/wiki/Troubleshooting.md', 'utf8');
    for (const code of Object.keys(ERROR_CODES)) {
      expect(guide, `docs/guide/README.md error-code table: ${code}`).toContain(`| \`${code}\` |`);
      expect(troubleshooting, `docs/wiki/Troubleshooting.md: ${code}`).toContain(`\`${code}\``);
    }
  });
});

describe('StepRecord error fields', () => {
  it('records code, locator, url and matches of a page error', async () => {
    const host = new FakeHost();
    host.agent = async () => {
      throw new CodedError('locator.strict', 'button matches 2 elements', { locator: 'button', url: 'https://shop.test/', matches: ['button#a "Save"', 'button#b "Save draft"'] });
    };
    const h = harness(flow([start, open, { id: 'c', type: 'click', config: { locator: 'button' } }], [['s', 'o'], ['o', 'c']]), host);
    const run = await h.runner.runOnce();
    const step = run.steps.find((candidate) => candidate.nodeId === 'c');
    expect(step).toMatchObject({
      status: 'failed',
      code: 'locator.strict',
      locator: 'button',
      url: 'https://shop.test/',
      matches: ['button#a "Save"', 'button#b "Save draft"'],
    });
    expect(run.steps.find((candidate) => candidate.nodeId === 'o')?.code).toBeUndefined();
  });

  it('codes failed asserts (soft ones too), HTTP status, missing tabs, timeouts and other errors', async () => {
    const host = new FakeHost();
    host.httpHandler = async () => ({ status: 404, ok: false, body: 'nope' });
    host.agent = async () => ({ found: true, text: 'Hello', count: 1 });
    const h = harness(
      flow(
        [
          start,
          { id: 'tab', type: 'click', config: { locator: '#x' } },
          { id: 'http', type: 'http-request', config: { url: 'https://api.test/', failOnError: true }, step: { onError: 'continue' } },
          open,
          { id: 'soft', type: 'assert', config: { subject: 'text', locator: '#greeting', operator: 'equals', expected: 'Bye', soft: true } },
          { id: 'hard', type: 'assert', config: { subject: 'value', value: '1', operator: 'equals', expected: '2' }, step: { onError: 'port' } },
          { id: 'after', type: 'log', config: { message: '{{errorCode}}' } },
        ],
        [['s', 'tab'], ['s', 'http'], ['http', 'o'], ['o', 'soft'], ['soft', 'hard'], ['hard', 'after', 'error']],
      ),
      host,
    );
    const run = await h.runner.runOnce();
    const step = (id: string) => run.steps.find((candidate) => candidate.nodeId === id);
    expect(step('tab')).toMatchObject({ status: 'failed', code: 'tab.missing' });
    expect(step('http')).toMatchObject({ status: 'handled', code: 'http.status', url: 'https://api.test/' });
    expect(step('soft')).toMatchObject({ status: 'failed', code: 'assert.failed', locator: '#greeting' });
    expect(step('hard')).toMatchObject({ status: 'handled', code: 'assert.failed' });
    expect(step('hard')?.locator).toBeUndefined();
    expect(step('after')?.output).toMatchObject({ errorCode: 'assert.failed' });
  });

  it('codes a step timeout and an uncoded error', async () => {
    const host = new FakeHost();
    host.httpHandler = () => new Promise(() => {});
    const timeout = await harness(flow([start, { id: 'h', type: 'http-request', config: { url: 'https://a.test' }, step: { timeoutSeconds: 1 } }], [['s', 'h']]), host).runner.runOnce();
    expect(timeout.steps[1]).toMatchObject({ status: 'failed', code: 'timeout' });

    const broken = new FakeHost();
    broken.agent = async () => {
      throw new Error('something odd');
    };
    const other = await harness(flow([start, open, { id: 'c', type: 'click', config: { locator: '#a' } }], [['s', 'o'], ['o', 'c']]), broken).runner.runOnce();
    expect(other.steps[2]).toMatchObject({ status: 'failed', code: 'step.failed', error: 'Click: something odd' });
  });

  it('maps steps back to the author\'s node ids (origin → sourceId)', async () => {
    const wf = flow([start, { id: 'n2', type: 'log', config: { message: 'hi' } }], [['s', 'n2']]);
    wf.nodes[1] = { ...wf.nodes[1]!, origin: 'say-hello' };
    const run = await harness(wf).runner.runOnce();
    expect(run.steps[1]?.sourceId).toBe('say-hello');
    expect(run.steps[0]?.sourceId).toBeUndefined();
  });

  it('masks secrets in the details', async () => {
    const host = new FakeHost();
    host.secretValues = { token: 'sekrit-value' };
    host.agent = async (_tab, request) => {
      throw new CodedError('locator.not-found', 'none', { locator: 'locator' in request ? String(request.locator) : '' });
    };
    const run = await harness(flow([start, open, { id: 'c', type: 'click', config: { locator: 'text={{secret.token}}' } }], [['s', 'o'], ['o', 'c']]), host).runner.runOnce();
    expect(run.steps[2]?.locator).toBe('text=•••');
  });
});

describe('JSON report', () => {
  it('is versioned and keeps the step details; JUnit shows the code', async () => {
    const host = new FakeHost();
    host.agent = async () => {
      throw new CodedError('locator.not-found', 'Timed out after 9s: waiting for #x: no element matches', { locator: '#x' });
    };
    const run = await harness(flow([start, open, { id: 'c', type: 'click', config: { locator: '#x' } }], [['s', 'o'], ['o', 'c']]), host).runner.runOnce();
    const report = toJsonReport([run], new Date('2026-11-06T10:00:00Z'));
    expect(report).toMatchObject({ schemaVersion: REPORT_SCHEMA_VERSION, generatedAt: '2026-11-06T10:00:00.000Z', summary: { total: 1, failed: 1 } });
    expect(report.$schema).toMatch(/report\.schema\.json$/);
    expect(report.runs[0]?.steps[2]).toMatchObject({ code: 'locator.not-found', locator: '#x' });
    expect(toJUnitXml([run], { blockLabel: (type) => type })).toContain('[locator.not-found]');
  });
});
