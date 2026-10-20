// Runs inside every web page. Its `window` is the page's, but its variables are private.
const OUTLINE = '3px solid #e11d48';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'count-links') {
    sendResponse({ count: document.links.length, title: document.title });
    return; // answered synchronously, nothing more to do
  }

  if (message?.type === 'highlight-links') {
    for (const link of document.links) link.style.outline = OUTLINE;
    sendResponse({ count: document.links.length });
    return;
  }

  if (message?.type === 'clear-highlight') {
    for (const link of document.links) link.style.outline = '';
    sendResponse({ ok: true });
    return;
  }
});
