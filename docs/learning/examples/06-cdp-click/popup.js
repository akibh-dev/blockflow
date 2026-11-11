const out = document.getElementById('out');

/** The tab to act on. `popup.html?tabId=7` (used by tests, where the popup is a normal tab) wins. */
async function targetTab() {
  const wanted = Number(new URLSearchParams(location.search).get('tabId'));
  if (wanted) return wanted;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab.id;
}

/**
 * Attach the debugger, run `work(send)`, and always detach (the yellow bar goes away).
 * `send('Domain.method', params)` resolves with the protocol's `result`.
 */
async function withDebugger(tabId, work) {
  await chrome.debugger.attach({ tabId }, '1.3'); // 1.3 = protocol version
  try {
    return await work((method, params) => chrome.debugger.sendCommand({ tabId }, method, params));
  } finally {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

/** Runs an expression in the page and returns its value (`returnByValue` = JSON, not an object handle). */
async function evaluate(send, expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true });
  // `text` is just "Uncaught"; the exception object's description has the real message.
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

async function realClick(send) {
  // Where is the button? The page knows; CDP's mouse needs viewport coordinates.
  const point = await evaluate(
    send,
    `(() => { const r = document.querySelector('#target').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  // A click is two events. Both carry the button and the click count.
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }
}

async function syntheticClick(send) {
  // The lesson-3 way, run inside the page: one fake event.
  await evaluate(send, `document.querySelector('#target').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
}

async function run(click) {
  out.textContent = '…';
  try {
    const tabId = await targetTab();
    out.textContent = await withDebugger(tabId, async (send) => {
      await click(send);
      // Ask the page what it saw.
      return evaluate(send, `document.querySelector('#result')?.textContent ?? 'no #result on this page'`);
    });
  } catch (error) {
    out.textContent = `Error: ${error.message}`;
  }
}

document.getElementById('trusted').addEventListener('click', () => run(realClick));
document.getElementById('synthetic').addEventListener('click', () => run(syntheticClick));
