// M3 groundwork: actual Chromium debugger ownership across steps and all run exits.
/** @param {import('../harness.mjs').Harness} h */
export default async function (h) {
  const { base, check, workflow, run, step, summary, worker } = h;
  console.log('M3 groundwork: run-scoped debugger sessions');
  const poll = async (read, timeout = 12_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for debugger session check');
  };
  const records = async (id) => (await worker.evaluate(() => chrome.storage.local.get('bf:runs')))['bf:runs']?.filter((r) => r.workflowId === id) ?? [];
  const hasSession = (tabId) => worker.evaluate(async (id) => {
    try { await chrome.debugger.sendCommand({ tabId: id }, 'Page.getLayoutMetrics'); return true; }
    catch { return false; }
  }, tabId);
  const opened = [];
  try {
    const success = workflow('M3 scoped CDP success', [
      { id: 'open', type: 'open-url', config: { url: `${base}/trusted.html`, active: false } },
      { id: 'first', type: 'click', config: { locator: '#press' }, step: { realInput: true } },
      { id: 'pause', type: 'timer', config: { seconds: 2 } },
      { id: 'fill', type: 'fill', config: { locator: '#name', value: 'shared session' }, step: { realInput: true } },
      { id: 'shot', type: 'screenshot', config: { area: 'full' } },
      { id: 'trusted', type: 'assert', config: { subject: 'text', locator: '#result', operator: 'equals', expected: 'trusted' } },
    ]);
    const completing = run(success);
    const live = await poll(async () => (await records(success.id)).find((r) => r.status === 'running' && step(r, 'pause')?.status === 'running'));
    const tabId = step(live, 'open')?.output?.tabId; opened.push(tabId);
    check('the debugger remains attached between real-input steps', await hasSession(tabId));
    const passed = await completing;
    check('real input and full-page screenshot work in the retained session', passed.status === 'passed' && Boolean(step(passed, 'shot')?.output?.screenshotId), summary(passed));
    check('successful run reports CDP usage and has released its attachment', passed.usedDebugger === true && !(await hasSession(tabId)), JSON.stringify(passed));

    const failing = await run(workflow('M3 scoped CDP failure', [
      { id: 'open', type: 'open-url', config: { url: `${base}/trusted.html`, active: false } },
      { id: 'click', type: 'click', config: { locator: '#press' }, step: { realInput: true } },
      { id: 'fail', type: 'assert', config: { subject: 'value', value: 'actual', operator: 'equals', expected: 'different' }, step: { screenshot: 'never' } },
    ]));
    const failedTab = step(failing, 'open')?.output?.tabId; opened.push(failedTab);
    check('a failed run releases its debugger attachment', failing.status === 'failed' && failing.usedDebugger === true && !(await hasSession(failedTab)), summary(failing));

    const stopping = workflow('M3 scoped CDP cancellation', [
      { id: 'open', type: 'open-url', config: { url: `${base}/trusted.html`, active: false } },
      { id: 'click', type: 'click', config: { locator: '#press' }, step: { realInput: true } },
      { id: 'pause', type: 'timer', config: { seconds: 30 } },
      { id: 'never', type: 'click', config: { locator: '#press' }, step: { realInput: true } },
    ]);
    const cancelledRun = run(stopping);
    const waiting = await poll(async () => (await records(stopping.id)).find((r) => r.status === 'running' && step(r, 'pause')?.status === 'running'));
    const stoppedTab = step(waiting, 'open')?.output?.tabId; opened.push(stoppedTab);
    await h.editor.evaluate((runId) => chrome.runtime.sendMessage({ type: 'bf:stop-run', runId }), waiting.id);
    const cancelled = await cancelledRun;
    check('Stop closes the session before the cancelled record is published', cancelled.status === 'cancelled' && cancelled.usedDebugger === true && !step(cancelled, 'never') && !(await hasSession(stoppedTab)), summary(cancelled));

    const lost = workflow('M3 user detaches CDP', [
      { id: 'open', type: 'open-url', config: { url: `${base}/trusted.html`, active: false } },
      { id: 'click', type: 'click', config: { locator: '#press' }, step: { realInput: true } },
      { id: 'pause', type: 'timer', config: { seconds: 2 } },
      { id: 'again', type: 'click', config: { locator: '#press' }, step: { realInput: true, screenshot: 'never' } },
    ]);
    const losing = run(lost);
    const beforeDetach = await poll(async () => (await records(lost.id)).find((r) => r.status === 'running' && step(r, 'pause')?.status === 'running'));
    const lostTab = step(beforeDetach, 'open')?.output?.tabId; opened.push(lostTab);
    await worker.evaluate((id) => chrome.debugger.detach({ tabId: id }), lostTab);
    const ended = await losing;
    check('a detached session fails clearly without silently reattaching', ended.status === 'failed' && /detached|closed/i.test(step(ended, 'again')?.error ?? '') && !(await hasSession(lostTab)), summary(ended));

    const plain = await run(workflow('M3 no CDP needed', [{ id: 'log', type: 'log', config: { message: 'plain run' } }]));
    check('ordinary workflows do not claim debugger usage', plain.status === 'passed' && plain.usedDebugger === undefined, summary(plain));
  } finally {
    for (const tabId of opened.filter(Number.isInteger)) await worker.evaluate((id) => chrome.tabs.remove(id).catch(() => {}), tabId);
  }
}
