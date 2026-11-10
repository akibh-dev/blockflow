import { browser } from 'wxt/browser';
import { CodedError } from '../core/errors';
import type { ConsoleEntry, HarLog, HarResult } from '../core/network';
import type { StepTrace } from '../core/runs';
import type { CdpSend } from './cdpSessions';
import type { M3Runtime } from './m3Runtime';

export const MAX_CONSOLE_ENTRIES = 200;
export const MAX_STEP_CONSOLE_ENTRIES = 50;
export const MAX_HAR_ENTRIES = 500;
/** M5.1: requests one traced step keeps for its network summary, and how many slowest it names. */
export const MAX_STEP_REQUESTS = 500;
export const STEP_SLOWEST = 3;
const MAX_TEXT = 2000;
const cut = (value: unknown, max = MAX_TEXT) => String(value ?? '').slice(0, max);
const finite = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

type Data = Record<string, any>;
interface Pending { request: Data; response?: Data; timestamp: number; wallTime: number }
interface Recording { recording: boolean; entries: Record<string, unknown>[]; pending: Map<string, Pending>; truncated: boolean }
/** M5.1: requests seen while one traced step ran (metadata only). */
interface StepNetwork {
  started: Map<string, { url: string; method: string; timestamp: number; status?: number }>;
  finished: { url: string; method: string; status?: number; ms: number }[];
  requests: number;
  failed: number;
}

/** HAR metadata excludes headers, cookies and bodies. Credentials in URLs are removed too. */
function safeUrl(raw: unknown): string {
  try {
    const url = new URL(String(raw));
    if (!/^https?:$/.test(url.protocol)) return '';
    url.username = ''; url.password = ''; url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/token|password|authorization|secret|session|api[-_]?key|access[-_]?key/i.test(key)) url.searchParams.set(key, '[redacted]');
    }
    return url.href.slice(0, 4096);
  } catch { return ''; }
}
function remoteValue(arg: Data): string {
  if ('value' in arg) {
    if (typeof arg.value === 'string') return cut(arg.value);
    try { return cut(JSON.stringify(arg.value)); } catch { return '[unserialisable]'; }
  }
  return cut(arg.unserializableValue ?? arg.description ?? arg.type ?? 'undefined');
}
function consoleEntry(method: string, p: Data): ConsoleEntry | undefined {
  if (method === 'Runtime.consoleAPICalled') {
    const level = p.type === 'assert' ? 'error' : p.type === 'warning' ? 'warn' : cut(p.type || 'log', 24);
    const text = (Array.isArray(p.args) ? p.args.slice(0, 16).map(remoteValue).join(' ') : '').slice(0, MAX_TEXT);
    const url = safeUrl(p.stackTrace?.callFrames?.[0]?.url);
    return { level, text, timestamp: finite(p.timestamp, Date.now()), ...(url ? { url } : {}) };
  }
  if (method === 'Runtime.exceptionThrown') {
    const detail = p.exceptionDetails ?? {};
    const text = cut(detail.exception?.description || detail.text || 'Uncaught exception');
    const url = safeUrl(detail.url || detail.stackTrace?.callFrames?.[0]?.url);
    return { level: 'error', text, timestamp: finite(p.timestamp, Date.now()), ...(url ? { url } : {}) };
  }
  return undefined;
}
function entryOf(pending: Pending, timestamp: number, size = -1, failure?: string): Record<string, unknown> {
  const request = pending.request;
  const response = pending.response ?? {};
  const url = safeUrl(request.url);
  const time = Math.max(0, (timestamp - pending.timestamp) * 1000);
  return {
    startedDateTime: new Date(pending.wallTime * 1000).toISOString(), time,
    request: {
      method: cut(request.method || 'GET', 24), url, httpVersion: cut(response.protocol || 'HTTP/1.1', 24),
      headers: [], cookies: [], queryString: [...new URL(url).searchParams].map(([name, value]) => ({ name, value })),
      headersSize: -1, bodySize: -1,
    },
    response: {
      status: finite(response.status), statusText: cut(response.statusText, 160), httpVersion: cut(response.protocol || 'HTTP/1.1', 24),
      headers: [], cookies: [], content: { size: Math.max(0, size), mimeType: cut(response.mimeType || 'application/octet-stream', 160) },
      redirectURL: '', headersSize: -1, bodySize: size,
    },
    cache: {}, timings: { send: 0, wait: time, receive: 0 },
    ...(failure ? { _error: cut(failure, 300) } : {}),
  };
}

/** Per-run passive capture. It never disables shared domains or attaches/detaches independently. */
export function createTelemetry(runtime: M3Runtime) {
  const startedAt = Date.now();
  const attached = new Map<number, Promise<void>>();
  const subscriptions = new Map<number, () => void>();
  const messages = new Map<number, ConsoleEntry[]>();
  const recordings = new Map<number, Recording>();
  const frames: { nodeId: string; entries: ConsoleEntry[] }[] = [];
  /** Tabs whose run session is set up (attached by some operation of this run). */
  const ready = new Set<number>();
  /** M5.1: per tab, the traced steps watching its requests, by node id. */
  const stepNetworks = new Map<number, Map<string, StepNetwork>>();
  let closed = false;
  const unavailable = () => closed || runtime.isClosed();
  const assertOpen = () => { if (unavailable()) throw new CodedError('step.failed', 'The run has ended; telemetry is closed.'); };

  const complete = (state: Recording, id: string, timestamp: number, size?: number, failure?: string) => {
    const pending = state.pending.get(id);
    if (!pending) return;
    state.pending.delete(id);
    if (state.entries.length >= MAX_HAR_ENTRIES) { state.truncated = true; return; }
    state.entries.push(entryOf(pending, timestamp, size, failure));
  };
  const receive = (tabId: number, method: string, raw?: object) => {
    if (unavailable()) return;
    const p = (raw ?? {}) as Data;
    const entry = consoleEntry(method, p);
    // Runtime.enable can replay old buffered messages; only this run's time window is captured.
    if (entry && entry.timestamp >= startedAt) {
      const list = messages.get(tabId) ?? [];
      list.push(entry); if (list.length > MAX_CONSOLE_ENTRIES) list.shift(); messages.set(tabId, list);
      const frame = frames.at(-1);
      if (frame && frame.entries.length < MAX_STEP_CONSOLE_ENTRIES) frame.entries.push(entry);
    }
    const watching = stepNetworks.get(tabId);
    if (watching && typeof p.requestId === 'string') for (const network of watching.values()) watchStep(network, method, p);
    const state = recordings.get(tabId);
    if (!state?.recording || typeof p.requestId !== 'string') return;
    const id = p.requestId;
    if (method === 'Network.requestWillBeSent') {
      if (p.redirectResponse && state.pending.has(id)) {
        state.pending.get(id)!.response = p.redirectResponse;
        complete(state, id, finite(p.timestamp), finite(p.redirectResponse.encodedDataLength, -1));
      }
      if (!safeUrl(p.request?.url)) return;
      if (state.entries.length + state.pending.size >= MAX_HAR_ENTRIES) { state.truncated = true; return; }
      state.pending.set(id, {
        // Keep only allowlisted metadata; request bodies/headers can be arbitrarily large or secret.
        request: { url: safeUrl(p.request.url), method: cut(p.request.method, 24) },
        timestamp: finite(p.timestamp), wallTime: finite(p.wallTime, Date.now() / 1000),
      });
    } else if (method === 'Network.responseReceived') {
      const pending = state.pending.get(id);
      if (pending) {
        const response = p.response ?? {};
        pending.response = { status: finite(response.status), statusText: cut(response.statusText, 160), protocol: cut(response.protocol, 24), mimeType: cut(response.mimeType, 160) };
      }
    } else if (method === 'Network.loadingFinished') complete(state, id, finite(p.timestamp), finite(p.encodedDataLength, -1));
    else if (method === 'Network.loadingFailed') complete(state, id, finite(p.timestamp), -1, p.errorText || 'Request failed');
  };

  const watchStep = (network: StepNetwork, method: string, p: Data) => {
    const id = p.requestId as string;
    if (method === 'Network.requestWillBeSent') {
      if (network.started.has(id)) return; // a redirect of a request already counted
      const url = safeUrl(p.request?.url);
      if (!url || network.requests >= MAX_STEP_REQUESTS) return;
      network.requests += 1;
      network.started.set(id, { url, method: cut(p.request?.method || 'GET', 24), timestamp: finite(p.timestamp) });
    } else if (method === 'Network.responseReceived') {
      const started = network.started.get(id);
      if (started) started.status = finite(p.response?.status);
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      const started = network.started.get(id);
      if (!started) return;
      network.started.delete(id);
      const failed = method === 'Network.loadingFailed' || (started.status ?? 0) >= 400;
      if (failed) network.failed += 1;
      network.finished.push({ url: started.url, method: started.method, ...(started.status ? { status: started.status } : {}), ms: Math.max(0, Math.round((finite(p.timestamp) - started.timestamp) * 1000)) });
    }
  };

  const attach = (tabId: number, send: CdpSend): Promise<void> => {
    assertOpen();
    let pending = attached.get(tabId);
    if (!pending) {
      pending = (async () => {
        const unsubscribe = runtime.subscribe(tabId, (method, params) => receive(tabId, method, params));
        subscriptions.set(tabId, unsubscribe);
        try { await send('Runtime.enable', {}); assertOpen(); }
        catch (error) { unsubscribe(); subscriptions.delete(tabId); throw error; }
        ready.add(tabId);
      })();
      attached.set(tabId, pending);
      void pending.catch(() => { if (attached.get(tabId) === pending) { attached.delete(tabId); ready.delete(tabId); } });
    }
    return pending;
  };
  return {
    attach,
    beginStep(nodeId: string): void { frames.push({ nodeId, entries: [] }); },
    /** M5.1: this run already has a debugger session on the tab (tracing never attaches one itself). */
    hasSession(tabId: number): boolean { return !unavailable() && ready.has(tabId); },
    /**
     * M5.1: starts counting the requests of a traced step on `tabId`, only when the run already has a
     * debugger session there (Network.enable on that session; never attaches). False = no summary.
     */
    async beginStepNetwork(tabId: number, nodeId: string): Promise<boolean> {
      if (unavailable() || !ready.has(tabId)) return false;
      await runtime.withTab(tabId, (send) => send('Network.enable', {}));
      const watching = stepNetworks.get(tabId) ?? new Map<string, StepNetwork>();
      watching.set(nodeId, { started: new Map(), finished: [], requests: 0, failed: 0 });
      stepNetworks.set(tabId, watching);
      return true;
    },
    /** M5.1: the step's request summary (count, failed, slowest few), or undefined when it was not watched. */
    finishStepNetwork(tabId: number, nodeId: string): StepTrace['network'] | undefined {
      const watching = stepNetworks.get(tabId);
      const network = watching?.get(nodeId);
      if (!watching || !network) return undefined;
      watching.delete(nodeId);
      if (watching.size === 0) stepNetworks.delete(tabId);
      const slowest = [...network.finished].sort((a, b) => b.ms - a.ms).slice(0, STEP_SLOWEST);
      return { requests: network.requests, failed: network.failed, ...(slowest.length > 0 ? { slowest } : {}) };
    },
    finishStep(nodeId: string): ConsoleEntry[] {
      const index = frames.findLastIndex((frame) => frame.nodeId === nodeId);
      return index < 0 ? [] : frames.splice(index, 1)[0]!.entries.map((entry) => ({ ...entry }));
    },
    async console(tabId: number): Promise<ConsoleEntry[]> {
      assertOpen();
      return runtime.withTab(tabId, async () => (messages.get(tabId) ?? []).map((entry) => ({ ...entry })));
    },
    async har(tabId: number, action: 'start' | 'stop'): Promise<HarResult> {
      assertOpen();
      return runtime.withTab(tabId, async (send) => {
        if (action === 'start') {
          if (recordings.get(tabId)?.recording) throw new CodedError('config.invalid', 'HAR recording is already running for this tab. Stop it before starting another.');
          const state: Recording = { recording: true, entries: [], pending: new Map(), truncated: false };
          recordings.set(tabId, state);
          try { await send('Network.enable', {}); }
          catch (error) { recordings.delete(tabId); throw error; }
          return { recording: true };
        }
        const state = recordings.get(tabId);
        if (!state?.recording) throw new CodedError('config.invalid', 'No HAR recording is running for this tab. Add HAR Record (start) first.');
        state.recording = false;
        for (const [id, pending] of state.pending) complete(state, id, pending.timestamp, -1, 'Recording stopped before request completed');
        const har: HarLog = { log: { version: '1.2', creator: { name: 'BlockFlow', version: browser.runtime?.getManifest?.().version ?? '' }, entries: state.entries } };
        recordings.delete(tabId);
        return { recording: false, har, ...(state.truncated ? { truncated: true } : {}) };
      });
    },
    async finish(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear(); attached.clear(); recordings.clear(); messages.clear(); frames.length = 0; ready.clear(); stepNetworks.clear();
    },
  };
}
