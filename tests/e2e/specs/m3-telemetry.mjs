/** @param {import('../harness.mjs').Harness} h */
export default async function (h) {
  const { base, check, run, step, summary, workflow, worker } = h;
  console.log('M3: HAR metadata, per-step console and exception capture');
  const result = await run(workflow('M3 telemetry', [
    { id: 'open', type: 'open-url', config: { url: `${base}/m3-telemetry.html`, active: false } },
    { id: 'start', type: 'har-record' },
    { id: 'error', type: 'click', config: { locator: '#console' } },
    { id: 'exception', type: 'click', config: { locator: '#exception' } },
    { id: 'wait', type: 'timer', config: { seconds: 1 } },
    { id: 'count', type: 'assert', config: { subject: 'console-errors', operator: 'greater-equal', expected: '2' } },
    { id: 'fetch', type: 'click', config: { locator: '#fetch' } },
    { id: 'response', type: 'wait-for', config: { mode: 'text', locator: '#status', text: 'Fetched 200' } },
    { id: 'stop', type: 'har-record', config: { action: 'stop', dataset: 'm3-network-metadata' } },
    { id: 'close', type: 'close-tab' },
  ]));
  check('HAR start/stop and console assertion pass in a real tab', result.status === 'passed', summary(result));
  const messages = result.steps.flatMap((record) => record.console ?? []);
  check('console.error and an uncaught exception are recorded per step', messages.some((entry) => entry.text.includes('fixture console error')) && messages.some((entry) => entry.text.includes('fixture uncaught exception')), JSON.stringify(messages));
  const entries = step(result, 'stop')?.output?.har?.log?.entries ?? [];
  const request = entries.find((entry) => entry.request?.url?.includes('/export.csv'));
  check('HAR 1.2 contains the completed request metadata', step(result, 'stop')?.output?.har?.log?.version === '1.2' && request?.response?.status === 200 && request?.request?.method === 'GET', JSON.stringify(step(result, 'stop')?.output));
  const encoded = JSON.stringify(entries);
  check('HAR omits auth headers/body/cookies and redacts sensitive URL query values', Boolean(request) && !encoded.includes('private-token') && !encoded.includes('private-authorization') && request.request.headers.length === 0 && request.response.headers.length === 0 && request.request.cookies.length === 0, encoded);
  check('HAR entries can be saved as a dataset', step(result, 'stop')?.output?.datasetSize >= 1, summary(result));

  const failed = await run(workflow('M3 console assertion failure', [
    { id: 'open', type: 'open-url', config: { url: `${base}/m3-telemetry.html`, active: false } },
    { id: 'attach', type: 'har-record' },
    { id: 'error', type: 'click', config: { locator: '#console' } },
    { id: 'wait', type: 'timer', config: { seconds: 1 } },
    { id: 'assert', type: 'assert', config: { subject: 'console-errors', operator: 'equals', expected: '0' }, step: { timeoutSeconds: 2, screenshot: 'never' } },
  ]));
  check('console errors fail an expectation that requires zero', failed.status === 'failed' && step(failed, 'assert')?.code === 'assert.failed', summary(failed));
  const tabId = step(failed, 'open')?.output?.tabId;
  if (Number.isInteger(tabId)) await worker.evaluate((id) => chrome.tabs.remove(id).catch(() => {}), tabId);
}
