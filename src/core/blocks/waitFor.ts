import { requireSessionTab } from '../session';
import { PAGE_ACCENT, PAGE_TIMEOUT_SECONDS, inPage, locatorField, pageWaitMs, tabField } from './pageCommon';
import type { WaitState } from '../page';
import type { BlockDefinition, ConfigProblem } from '../types';

/** Agent wait states plus the modes handled by the host's tab APIs (url, load, networkidle, response, request). */
export type WaitMode = WaitState | 'url' | 'load' | 'networkidle' | 'response' | 'request';

/** Wait For settings. Which of `locator` / `text` / `url` / `status` matter depends on `mode`. */
export interface WaitForConfig {
  tab: string;
  mode: WaitMode;
  locator: string;
  text: string;
  url: string;
  status: string;
  /** For response / request: "POST", "get,post", or empty for any. */
  method: string;
  /** For response: also read the body (Chromium, debugger permission). */
  captureBody: boolean;
}

/** Wait For "response" also accepts a response that finished just before (during the Click before it). */
const RESPONSE_LOOK_BACK_MS = 10_000;

/** Modes that are meaningless without a locator (checked before calling the agent). */
const NEEDS_ELEMENT: WaitMode[] = ['visible', 'hidden', 'attached', 'detached', 'enabled'];

/**
 * Wait For — the answer to "the page changes after I click" (a new page, or a single-page app
 * re-rendering). Page actions already wait for their own element; use this for everything else.
 */
export const waitForBlock: BlockDefinition<WaitForConfig> = {
  type: 'wait-for',
  label: 'Wait For',
  description: 'Wait until an element appears or goes, some text shows, the URL changes, or the page settles.',
  icon: '⏳',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: 'main', mode: 'visible', locator: '', text: '', url: '', status: '', method: '', captureBody: false },
  timeoutSeconds: PAGE_TIMEOUT_SECONDS,
  permissions: (config) => (config.mode === 'response' && config.captureBody ? ['debugger'] : []),
  fields: [
    {
      key: 'mode',
      label: 'Wait until',
      kind: 'select',
      options: [
        { value: 'visible', label: 'an element is visible' },
        { value: 'hidden', label: 'an element is hidden or gone' },
        { value: 'attached', label: 'an element exists (visible or not)' },
        { value: 'detached', label: 'an element is removed' },
        { value: 'enabled', label: 'an element is enabled' },
        { value: 'text', label: 'some text appears' },
        { value: 'no-text', label: 'some text disappears' },
        { value: 'url', label: 'the URL matches (new page or SPA route)' },
        { value: 'load', label: 'the page has loaded' },
        { value: 'networkidle', label: 'the network is quiet' },
        { value: 'response', label: 'a network request finishes (API call)' },
        { value: 'request', label: 'the page sends a request' },
      ],
    },
    { ...locatorField('locator', 'Element', false), help: 'For the element modes. For text: only look inside this element (optional).' },
    { key: 'text', label: 'Text', kind: 'text', templated: true, placeholder: 'Thanks for signing up  ·  /order #\\d+/i' },
    {
      key: 'url',
      label: 'URL pattern',
      kind: 'text',
      templated: true,
      placeholder: '/welcome  ·  https://shop.test/order/*  ·  /\\/order\\/\\d+/',
      help: 'Plain text: the URL contains it. * matches any part between slashes, ** anything. /…/ is a regular expression. Also the request address for the network modes.',
    },
    { key: 'status', label: 'Status (optional)', kind: 'text', placeholder: '200  ·  2xx  ·  200,201', help: 'For "a network request finishes".' },
    { key: 'method', label: 'Method (optional)', kind: 'text', placeholder: 'POST  ·  GET,POST', help: 'For the network modes. Empty = any.' },
    {
      key: 'captureBody',
      label: 'Capture the response body',
      kind: 'boolean',
      help: 'For "a network request finishes". Chrome, Edge, Brave only (debugger permission). Only responses that start after this block starts can be read, so it suits slow or later requests.',
    },
    tabField,
  ],
  summary: (config) => {
    if (config.mode === 'url') return `URL ~ ${config.url || '…'}`;
    if (config.mode === 'response') return `response ${config.method ? `${config.method} ` : ''}${config.url || '…'}${config.status ? ` ${config.status}` : ''}${config.captureBody ? ' + body' : ''}`;
    if (config.mode === 'request') return `request ${config.method ? `${config.method} ` : ''}${config.url || '…'}`;
    if (config.mode === 'text' || config.mode === 'no-text') return `${config.mode === 'text' ? '' : 'no '}text "${config.text}"`;
    if (config.mode === 'load' || config.mode === 'networkidle') return config.mode === 'load' ? 'page loaded' : 'network quiet';
    return `${config.mode}: ${config.locator || 'pick an element'}`;
  },
  validate: (config) => {
    const problems: ConfigProblem[] = [];
    if (NEEDS_ELEMENT.includes(config.mode) && !String(config.locator ?? '').trim()) {
      problems.push({ key: 'locator', code: 'config.required', message: `Element is required for mode "${config.mode}"` });
    }
    if ((config.mode === 'text' || config.mode === 'no-text') && !String(config.text ?? '').trim()) {
      problems.push({ key: 'text', code: 'config.required', message: `Text is required for mode "${config.mode}"` });
    }
    if ((config.mode === 'url' || config.mode === 'response' || config.mode === 'request') && !String(config.url ?? '').trim()) {
      problems.push({ key: 'url', code: 'config.required', message: `URL pattern is required for mode "${config.mode}"` });
    }
    return problems;
  },
  outputs: [
    { key: 'url', description: "The tab's URL when the wait ended." },
    { key: 'response', description: 'For "a network request finishes": {url, status, method}, plus body (or bodyBase64) with "Capture the response body".' },
    { key: 'request', description: 'For "the page sends a request": {url, method, type, postData}.' },
  ],

  async run(ctx, input) {
    const { mode, locator, text, url } = ctx.config;
    const tabId = requireSessionTab(input, ctx.config.tab);
    const timeoutMs = pageWaitMs(ctx);
    const started = Date.now();
    if (mode === 'url') {
      if (!url.trim()) throw new Error('URL pattern is required for "the URL matches"');
      const now = await ctx.host.tabs.waitForUrl(tabId, url, timeoutMs);
      ctx.log('info', `URL is ${now}`);
      return { ...input, url: now };
    }
    if (mode === 'response') {
      if (!url.trim()) throw new Error('URL pattern is required for "a network request finishes"');
      const method = ctx.config.method.trim();
      const captureBody = Boolean(ctx.config.captureBody);
      const response = await ctx.host.tabs.waitForResponse(tabId, url, ctx.config.status, RESPONSE_LOOK_BACK_MS, timeoutMs, {
        ...(method ? { method } : {}),
        ...(captureBody ? { captureBody } : {}),
      });
      ctx.log('info', `${response.method} ${response.url} → ${response.status}`);
      return { ...input, response };
    }
    if (mode === 'request') {
      if (!url.trim()) throw new Error('URL pattern is required for "the page sends a request"');
      const request = await ctx.host.tabs.waitForRequest(tabId, url, ctx.config.method.trim(), RESPONSE_LOOK_BACK_MS, timeoutMs);
      ctx.log('info', `${request.method} ${request.url}`);
      return { ...input, request };
    }
    if (mode === 'load' || mode === 'networkidle') {
      await ctx.host.tabs.waitForLoad(tabId, mode, timeoutMs);
    } else {
      if (NEEDS_ELEMENT.includes(mode) && !locator.trim()) throw new Error(`Element is required for "${mode}"`);
      if ((mode === 'text' || mode === 'no-text') && !text.trim()) throw new Error('Text is required for the text modes');
      await inPage(ctx, input, {
        op: 'wait',
        state: mode,
        ...(locator.trim() ? { locator } : {}),
        ...(text ? { text } : {}),
      });
    }
    const info = await ctx.host.tabs.info(tabId);
    ctx.log('info', `Done waiting (${mode}) after ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return { ...input, url: info?.url ?? '' };
  },
};
