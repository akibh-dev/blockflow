import { browser } from 'wxt/browser';
import { runOnHtml } from '../../browser/htmlParse';

/**
 * Chrome's background worker has no DOM, so fetched HTML is parsed here, in an offscreen document
 * the worker opens on demand (src/browser/htmlParse.ts). It answers one kind of message.
 */
browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as { type?: string; html?: string; baseUrl?: string; request?: never };
  if (request?.type !== 'bf:parse-html') return undefined;
  runOnHtml(request.html ?? '', request.baseUrl ?? '', request.request as never)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true; // answer asynchronously
});
