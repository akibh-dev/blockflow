import { browser } from 'wxt/browser';
import { createAgent } from '../dom/agent';
import type { PageWindow } from '../dom/agent';
import type { AgentRequest } from '../core/page';

/**
 * Scraping HTML without a tab: parse it with DOMParser and point the page agent at the parsed
 * document. Firefox's background page has a DOM; Chrome's service worker does not, so there the
 * work happens in an offscreen document (src/entrypoints/offscreen).
 */

/** Runs where a DOM exists (offscreen document, or Firefox's background page). */
export async function runOnHtml(html: string, baseUrl: string, request: AgentRequest): Promise<Record<string, unknown>> {
  const base = baseUrl ? `<base href="${baseUrl.replace(/"/g, '&quot;')}">` : '';
  const doc = new DOMParser().parseFromString(base + html, 'text/html');
  const response = await createAgent(window as PageWindow, doc).run({ request, budgetMs: 0 });
  if (response.status === 'done') return response.result;
  if (response.status === 'error') throw new Error(response.message);
  if (response.status === 'frame') throw new Error('Frames cannot be read from HTML in the data; open the page in a tab instead');
  throw new Error(response.reason.replace(/^waiting for /, 'Nothing matches: '));
}

const OFFSCREEN_URL = '/offscreen.html';
let creating: Promise<void> | null = null;

/** Opens the offscreen parser document if none exists. Concurrent callers share one `createDocument`. */
async function ensureOffscreen(): Promise<void> {
  const offscreen = browser.offscreen;
  if (await offscreen.hasDocument?.()) return;
  creating ??= offscreen
    .createDocument({ url: OFFSCREEN_URL, reasons: ['DOM_PARSER'], justification: 'Parse fetched HTML for Extract blocks' })
    .catch((error: unknown) => {
      // Created by a parallel call in the meantime: fine.
      if (!String(error).includes('single offscreen')) throw error;
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

/**
 * `Host.html.act`: runs an agent request on an HTML string. Parses here when a DOM exists (Firefox),
 * otherwise sends `bf:parse-html` to the offscreen document (Chrome).
 */
export async function actOnHtml(html: string, baseUrl: string, request: AgentRequest): Promise<Record<string, unknown>> {
  if (typeof DOMParser !== 'undefined') return runOnHtml(html, baseUrl, request);
  await ensureOffscreen();
  const answer = (await browser.runtime.sendMessage({ type: 'bf:parse-html', html, baseUrl, request })) as
    | { ok: true; result: Record<string, unknown> }
    | { ok: false; error: string }
    | undefined;
  if (!answer) throw new Error('The HTML parser did not answer');
  if (!answer.ok) throw new Error(answer.error);
  return answer.result;
}
