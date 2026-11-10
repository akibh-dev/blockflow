import { describe, expect, it } from 'vitest';
import { harRecordBlock } from '../../src/core/blocks/harRecord';
import { assertBlock } from '../../src/core/blocks/assert';
import { CodedError } from '../../src/core/errors';
import { toHtmlReport, toJsonReport } from '../../src/core/report';
import { FakeHost, flow, harness } from '../helpers/fakeHost';
import type { RunRecord } from '../../src/core/runs';

const chain = (...nodes: { id: string; type: string; config?: Record<string, unknown> }[]) => {
  const all = [{ id: 'open', type: 'open-url', config: { url: 'https://example.test' } }, ...nodes];
  return flow(all, all.slice(1).map((node, index) => [all[index]!.id, node.id]));
};

describe('HAR Record block', () => {
  it('starts, stops, returns the HAR and optionally saves/downloads its metadata', async () => {
    const host = new FakeHost();
    host.harResult = { recording: false, truncated: true, har: { log: { version: '1.2', creator: { name: 'BlockFlow', version: '0.4.0' }, entries: [{ request: { url: 'https://example.test/api' }, response: { status: 200 } }] } } };
    const result = await harness(chain(
      { id: 'start', type: 'har-record' },
      { id: 'stop', type: 'har-record', config: { action: 'stop', dataset: 'network', filename: 'network.har' } },
    ), host).runner.runOnce();
    expect(result.status).toBe('passed');
    expect(host.harCalls).toEqual([{ tabId: 100, action: 'start' }, { tabId: 100, action: 'stop' }]);
    expect(result.steps.find((step) => step.nodeId === 'stop')?.output).toMatchObject({ recording: false, truncated: true, datasetSize: 1, har: host.harResult.har });
    expect(host.datasetRows.get('network')).toEqual(host.harResult.har?.log.entries);
    expect(host.downloaded[0]).toMatchObject({ filename: 'network.har', mime: 'application/json' });
    expect(JSON.parse(host.downloaded[0]!.content)).toEqual(host.harResult.har);
  });

  it('rejects misleading export destinations on start instead of silently ignoring them', async () => {
    expect(harRecordBlock.validate?.({ ...harRecordBlock.defaultConfig, dataset: 'data' })).toEqual([expect.objectContaining({ key: 'action' })]);
    const result = await harness(chain({ id: 'start', type: 'har-record', config: { filename: 'bad.har' } })).runner.runOnce();
    expect(result.status).toBe('failed'); expect(result.steps.at(-1)?.code).toBe('config.invalid');
  });

  it('masks configured secrets before saving a dataset or downloading a HAR', async () => {
    const host = new FakeHost(); host.secretValues = { api: 'private-path-token' };
    host.harResult = { recording: false, har: { log: { version: '1.2', creator: { name: 'BlockFlow', version: '0.4.0' }, entries: [{ request: { url: 'https://example.test/private-path-token' } }] } } };
    const result = await harness(chain({ id: 'stop', type: 'har-record', config: { action: 'stop', dataset: 'safe', filename: 'safe.har' } }), host).runner.runOnce();
    expect(result.status).toBe('passed');
    expect(JSON.stringify(host.datasetRows.get('safe'))).not.toContain('private-path-token');
    expect(host.downloaded[0]?.content).not.toContain('private-path-token');
    expect(host.downloaded[0]?.content).toContain('•••');
  });

  it('propagates an unsupported-browser/permission error clearly', async () => {
    const host = new FakeHost();
    host.network.har = async () => { throw new CodedError('permission.missing', 'Chromium debugger is unavailable'); };
    const result = await harness(chain({ id: 'start', type: 'har-record' }), host).runner.runOnce();
    expect(result.steps.at(-1)).toMatchObject({ status: 'failed', code: 'permission.missing' });
  });
});

describe('Assert console-errors', () => {
  it('counts console errors/exceptions, requires no locator and declares its optional permission', async () => {
    const host = new FakeHost();
    host.consoleEntries = [{ level: 'warn', text: 'warning', timestamp: 1 }, { level: 'error', text: 'failed', timestamp: 2 }];
    const result = await harness(chain({ id: 'assert', type: 'assert', config: { subject: 'console-errors', operator: 'equals', expected: '1' } }), host).runner.runOnce();
    expect(result.status).toBe('passed'); expect(result.steps.at(-1)?.output?.actual).toBe('1');
    expect(assertBlock.validate?.({ ...assertBlock.defaultConfig, subject: 'console-errors' })).toEqual([]);
    expect(typeof assertBlock.permissions === 'function' && assertBlock.permissions({ ...assertBlock.defaultConfig, subject: 'console-errors' })).toEqual(['debugger']);
  });

  it('fails a mismatched count with assert.failed and no element locator detail', async () => {
    const host = new FakeHost();
    host.consoleEntries = [{ level: 'error', text: 'failed', timestamp: 2 }];
    const result = await harness(chain({ id: 'assert', type: 'assert', config: { subject: 'console-errors', operator: 'equals', expected: '0', locator: '#irrelevant' } }), host).runner.runOnce();
    expect(result.status).toBe('failed'); expect(result.steps.at(-1)?.code).toBe('assert.failed'); expect(result.steps.at(-1)?.locator).toBeUndefined();
  });
});

describe('console report export', () => {
  it('includes structured console data in JSON and safely escapes it in the HTML report', () => {
    const run: RunRecord = {
      id: 'r', workflowId: 'w', workflowName: 'console test', status: 'passed', trigger: 'manual', startedAt: '2026-01-01T00:00:00Z',
      steps: [{ nodeId: 'n', blockType: 'click', status: 'passed', startedAt: '2026-01-01T00:00:00Z', attempts: 1, console: [{ level: 'error', text: '<script>alert("bad")</script>', timestamp: 1, url: 'https://example.test/?x=<img>' }] }],
    };
    expect(toJsonReport([run]).runs[0]?.steps[0]?.console).toEqual(run.steps[0]?.console);
    const html = toHtmlReport([run], { blockLabel: () => 'Click' });
    expect(html).toContain('Console (1)'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toContain('<img>');
  });
});
