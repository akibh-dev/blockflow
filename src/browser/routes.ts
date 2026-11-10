import { browser } from 'wxt/browser';
import { CodedError } from '../core/errors';
import type { RouteOptions, RouteResult, RouteRule } from '../core/network';
import { urlMatches } from '../core/urlPattern';
import { dnrCompatible, MAX_ROUTE_RULES, parseRouteRules } from '../core/blocks/route';
import type { CdpSend } from './cdpSessions';
import type { M3Runtime } from './m3Runtime';

/** Session rule IDs reserved exclusively for BlockFlow's Route feature. */
const FIRST_ID = 1_000_000;
const LAST_ID = 1_099_999;
let nextId = FIRST_ID;
const METHODS = new Set(['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'other']);
const RESOURCE_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'];

type DnrRule = { id: number; priority: number; action: { type: 'block' | 'redirect'; redirect?: { url: string } }; condition: { regexFilter: string; isUrlFilterCaseSensitive: boolean; tabIds: number[]; resourceTypes: string[]; requestMethods?: string[] } };
/** An injectable boundary for tests; the production port uses browser session rules only. */
export interface DnrPort {
  available(): Promise<boolean>;
  getSessionRules(): Promise<{ id: number }[]>;
  updateSessionRules(options: { removeRuleIds?: number[]; addRules?: DnrRule[] }): Promise<void>;
  isRegexSupported?(options: { regex: string; isCaseSensitive: boolean }): Promise<{ isSupported: boolean; reason?: string }>;
}
const browserDnr: DnrPort = {
  available: async () => Boolean(browser.declarativeNetRequest) && await browser.permissions.contains({ permissions: ['declarativeNetRequest'] }).catch(() => false),
  getSessionRules: () => browser.declarativeNetRequest.getSessionRules(),
  updateSessionRules: (options) => browser.declarativeNetRequest.updateSessionRules(options as never),
  isRegexSupported: (options) => browser.declarativeNetRequest.isRegexSupported(options),
};
const initialisation = new WeakMap<DnrPort, Promise<void>>();
/** Worker restarts interrupt old runs: do not leave their browser session rules installed. */
export async function initialiseRoutes(port: DnrPort = browserDnr): Promise<void> {
  if (!(await port.available())) return;
  let pending = initialisation.get(port);
  if (!pending) {
    pending = port.getSessionRules().then(async (rules) => {
      const stale = rules.filter((rule) => rule.id >= FIRST_ID && rule.id <= LAST_ID).map((rule) => rule.id);
      if (stale.length) await port.updateSessionRules({ removeRuleIds: stale });
    });
    initialisation.set(port, pending);
    void pending.catch(() => { if (initialisation.get(port) === pending) initialisation.delete(port); });
  }
  await pending;
}

const closedError = () => new CodedError('step.failed', 'This run has ended; its routes are closed.');
const requestGone = (error: unknown) => /invalid (?:interceptionid|requestid)|no resource with given identifier/i.test(String(error));
const isDetached = (error: unknown) => /debugger.*not attached|detached|tab.*closed|no tab with (?:given )?id|no target with given id/i.test(String(error));
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function headers(source: Record<string, string>, overrides: Record<string, string> = {}, bodyChanged = false) {
  const merged = new Map<string, { name: string; value: string }>();
  for (const [name, value] of Object.entries({ ...source, ...overrides })) merged.set(name.toLowerCase(), { name, value });
  // A new body has a different byte length; let the browser recompute this header.
  if (bodyChanged) merged.delete('content-length');
  return [...merged.values()];
}
function pattern(rule: RouteRule): { regex: string; isCaseSensitive: boolean } {
  const value = rule.url.trim();
  const match = /^\/(.+)\/([dgimsuyv]*)$/s.exec(value);
  if (match) {
    if (match[2] && match[2] !== 'i') throw new CodedError('config.invalid', 'Browser route rules support only the i regex flag; use CDP for other flags');
    return { regex: match[1]!, isCaseSensitive: !match[2] };
  }
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (value.includes('*')) return { regex: `^${value.split('**').map((part) => part.split('*').map(escape).join('[^/]*')).join('.*')}$`, isCaseSensitive: true };
  return { regex: escape(value), isCaseSensitive: true };
}
interface Paused { requestId: string; request: { url: string; method: string; headers?: Record<string, string> } }
interface Pending { cancel(): void; task: Promise<void> }
interface TabRoutes {
  backend: 'cdp' | 'dnr';
  rules: RouteRule[];
  ids: number[];
  active: boolean;
  acquired?: boolean;
  pending: Map<string, Pending>;
  closingTasks: Set<Promise<unknown>>;
  unsubscribe?: () => void;
  error?: unknown;
}

/** Route state is per run; rules are scoped to one browser tab and newest matching rule wins. */
export function createRoutes(runtime: M3Runtime, dnr: DnrPort = browserDnr) {
  const tabs = new Map<number, TabRoutes>();
  const queues = new Map<number, Promise<unknown>>();
  let closing = false;
  let finishing: Promise<void> | undefined;
  const unavailable = () => closing || runtime.isClosed();
  const serial = <T>(tabId: number, fn: () => Promise<T>): Promise<T> => {
    const task = (queues.get(tabId) ?? Promise.resolve()).catch(() => {}).then(fn);
    queues.set(tabId, task);
    void task.finally(() => { if (queues.get(tabId) === task) queues.delete(tabId); }).catch(() => {});
    return task;
  };
  const handle = async (state: TabRoutes, event: Paused, send: CdpSend, wake: { cancel: () => void }) => {
    if (!state.active || unavailable()) return;
    const rule = [...state.rules].reverse().find((candidate) => urlMatches(event.request.url, candidate.url) && (!candidate.method || candidate.method === event.request.method.toUpperCase()));
    if (rule?.delayMs) await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, rule.delayMs);
      wake.cancel = () => { clearTimeout(timer); resolve(); };
    });
    if (!state.active || unavailable()) return;
    const requestId = event.requestId;
    if (!rule || rule.action === 'continue') await send('Fetch.continueRequest', { requestId });
    else if (rule.action === 'abort') await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    else if (rule.action === 'redirect') await send('Fetch.continueRequest', { requestId, url: rule.redirectUrl });
    else if (rule.action === 'fulfill') {
      const responseHeaders = headers({ 'Content-Type': 'text/plain; charset=utf-8' }, rule.headers, true);
      await send('Fetch.fulfillRequest', { requestId, responseCode: rule.status ?? 200, responseHeaders, body: base64(rule.body ?? '') });
    } else {
      await send('Fetch.continueRequest', {
        requestId,
        ...(rule.headers ? { headers: headers(event.request.headers ?? {}, rule.headers, rule.body !== undefined) } : {}),
        ...(rule.body !== undefined ? { postData: base64(rule.body) } : {}),
      });
    }
  };
  const install = async (tabId: number, state: TabRoutes) => runtime.withTab(tabId, async (send) => {
    state.acquired = true;
    state.unsubscribe = runtime.subscribe(tabId, (method, params) => {
      if (method !== 'Fetch.requestPaused' || !params) return;
      const event = params as Paused;
      if (!event.requestId || !event.request) return;
      if (!state.active || unavailable()) {
        const task = runtime.cleanupTab(tabId, (cleanupSend) => cleanupSend('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' }))
          .catch((error) => { if (!isDetached(error) && !requestGone(error)) state.error ??= error; })
          .finally(() => { state.closingTasks.delete(task); });
        state.closingTasks.add(task);
        return;
      }
      if (state.pending.size >= 256) {
        state.error ??= new CodedError('step.failed', 'Too many paused route requests (maximum 256); reduce route delays or narrow the URL pattern');
        void send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
        return;
      }
      const wake = { cancel: () => {} };
      const task = handle(state, event, send, wake).catch(async (error) => {
        if (!state.active || unavailable() || isDetached(error)) return;
        state.error ??= error;
        // Never continue an intended mock/modified write to the real server after an interception error.
        await send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' }).catch(() => {});
      }).finally(() => { state.pending.delete(event.requestId); });
      state.pending.set(event.requestId, { task, cancel: () => wake.cancel() });
    });
    try { await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }); }
    catch (error) { state.unsubscribe(); state.unsubscribe = undefined; throw error; }
  });
  const clear = async (tabId: number, state: TabRoutes) => {
    state.active = false;
    const paused = [...state.pending.entries()];
    for (const [, pending] of paused) pending.cancel();
    try {
      if (state.backend === 'dnr') {
        if (state.ids.length) await dnr.updateSessionRules({ removeRuleIds: [...state.ids] });
      } else await runtime.cleanupTab(tabId, async (send) => {
        // Fetch.disable resumes requests. Abort intended mocks/writes before disabling interception.
        const aborts = await Promise.allSettled(paused.map(async ([requestId]) => {
          try { await send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }); }
          catch (error) { if (!requestGone(error) && !isDetached(error)) throw error; }
        }));
        await Promise.allSettled(state.closingTasks);
        await send('Fetch.disable');
        const failure = aborts.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      });
    } catch (error) { if (!isDetached(error)) throw error; }
    finally {
      state.unsubscribe?.();
      await Promise.allSettled([...paused.map(([, pending]) => pending.task), ...state.closingTasks]);
    }
    state.ids = []; state.rules = [];
    if (state.error) throw state.error;
  };
  return {
    async apply(tabId: number, options: RouteOptions): Promise<RouteResult> {
      if (unavailable()) throw closedError();
      if (!['auto', 'cdp', 'dnr'].includes(options.backend) || !['add', 'clear'].includes(options.action)) throw new CodedError('config.invalid', 'Invalid route backend/action');
      runtime.claim(tabId, 'route');
      return serial(tabId, async () => {
        if (unavailable()) throw closedError();
        let old = tabs.get(tabId);
        if (old && !old.active && options.action === 'add') { await clear(tabId, old); tabs.delete(tabId); old = undefined; }
        if (options.action === 'clear') {
          if (old) { await clear(tabId, old); tabs.delete(tabId); }
          return { rules: 0, backend: old?.backend ?? (options.backend === 'cdp' ? 'cdp' : 'dnr') };
        }
        const rules = parseRouteRules(options.rules);
        const backend = options.backend === 'auto' ? (old?.backend ?? (dnrCompatible(rules) ? 'dnr' : 'cdp')) : options.backend;
        if (old && old.backend !== backend) throw new CodedError('config.invalid', 'Clear this tab’s routes before switching between CDP and browser rules');
        if ((old?.rules.length ?? 0) + rules.length > MAX_ROUTE_RULES) throw new CodedError('config.invalid', `A tab can have at most ${MAX_ROUTE_RULES} route rules`);
        if (backend === 'dnr' && !dnrCompatible(rules)) throw new CodedError('config.invalid', 'Browser rules support only abort/redirect without delays; use Chromium CDP');
        const state = old ?? { backend, rules: [], ids: [], active: true, pending: new Map<string, Pending>(), closingTasks: new Set<Promise<unknown>>() };
        if (backend === 'dnr') {
          if (!(await dnr.available())) throw new CodedError('permission.missing', 'Browser route rules need the "declarativeNetRequest" permission. Grant it on the Route block; this browser must support session rules.');
          await initialiseRoutes(dnr);
          const addRules: DnrRule[] = [];
          for (const rule of rules) {
            if (rule.method && !METHODS.has(rule.method.toLowerCase())) throw new CodedError('config.invalid', 'Browser route rules support standard HTTP methods only; use CDP for a custom method');
            const condition = pattern(rule);
            if (dnr.isRegexSupported && !(await dnr.isRegexSupported(condition)).isSupported) throw new CodedError('config.invalid', `This browser cannot use route URL pattern: ${rule.url}`);
            if (nextId > LAST_ID) throw new CodedError('config.invalid', 'Route rule IDs are exhausted for this worker; reload the extension');
            addRules.push({ id: nextId++, priority: state.rules.length + addRules.length + 1,
              action: rule.action === 'abort' ? { type: 'block' } : { type: 'redirect', redirect: { url: rule.redirectUrl! } },
              condition: { regexFilter: condition.regex, isUrlFilterCaseSensitive: condition.isCaseSensitive, tabIds: [tabId], resourceTypes: RESOURCE_TYPES, ...(rule.method ? { requestMethods: [rule.method.toLowerCase()] } : {}) },
            });
          }
          if (unavailable()) throw closedError();
          await dnr.updateSessionRules({ addRules });
          state.ids.push(...addRules.map((rule) => rule.id));
        } else if (!old) {
          // Track before enabling: cleanup must also handle a partial installation.
          tabs.set(tabId, state);
          try { await install(tabId, state); } catch (error) { state.active = false; if (!state.acquired) tabs.delete(tabId); throw error; }
        }
        state.rules.push(...rules);
        tabs.set(tabId, state);
        return { rules: state.rules.length, backend };
      });
    },
    finish(): Promise<void> {
      if (finishing) return finishing;
      closing = true;
      finishing = (async () => {
        await Promise.allSettled(queues.values());
        const results = await Promise.allSettled([...tabs].map(([tabId, state]) => clear(tabId, state)));
        tabs.clear();
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      })();
      return finishing;
    },
  };
}
