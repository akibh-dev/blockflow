import type {
  CookieInfo,
  CookieSetOptions,
  DownloadInfo,
  Host,
  ScreenshotOptions,
  HttpRequestOptions,
  HttpResult,
  NavigateOptions,
  NotifyOptions,
  LogEntry,
  OpenTabOptions,
  Payload,
  ReadElementOptions,
  ReadElementResult,
  Scheduler,
  StateStore,
  StepSettings,
  TabInfo,
  TimerOptions,
  TimerRecord,
  Workflow,
} from '../../src/core/types';
import { WorkflowRunner } from '../../src/core/engine';
import { urlMatches } from '../../src/core/urlPattern';
import type { AgentRequest, WaitUntil } from '../../src/core/page';
import type { RunRecord } from '../../src/core/runs';
import type { ClearSiteDataOptions, ConsoleEntry, EmulateOptions, HarResult, RouteOptions, RouteResult } from '../../src/core/network';
import { createDefaultRegistry } from '../../src/core/blocks';

/** What FakeScheduler keeps per key: the timer options plus the JSON payload stored with it. */
interface StoredTimer extends TimerOptions {
  data?: Payload;
}

/** In-memory scheduler. Tests "fire" timers by calling runner.handleTimer(key) themselves. */
export class FakeScheduler implements Scheduler {
  readonly timers = new Map<string, StoredTimer>();

  /** Stores (or replaces) the timer. Nothing fires by itself: call `harness.fire(name)` or `runner.handleTimer(key)`. */
  async set(key: string, options: TimerOptions, data?: Payload): Promise<void> {
    this.timers.set(key, { ...options, ...(data ? { data } : {}) });
  }

  async clear(key: string): Promise<void> {
    this.timers.delete(key);
  }

  async clearPrefix(prefix: string): Promise<void> {
    for (const key of [...this.timers.keys()]) {
      if (key.startsWith(prefix)) this.timers.delete(key);
    }
  }

  /** Like the real scheduler: returns the timer's record, deleting one-shot timers and keeping periodic ones. */
  async take(key: string): Promise<TimerRecord | undefined> {
    const timer = this.timers.get(key);
    if (!timer) return undefined;
    const periodic = timer.periodMs !== undefined;
    if (!periodic) this.timers.delete(key);
    return { periodic, ...(timer.data ? { data: timer.data } : {}) };
  }

  /** Keys of timers whose name (last part of the key) starts with `name`. */
  keysNamed(name: string): string[] {
    return [...this.timers.keys()].filter((key) => key.split('::').slice(3).join('::').startsWith(name));
  }
}

/** In-memory `StateStore` (block state, run records' per-node state). Inspect `data` in assertions. */
export class MemoryState implements StateStore {
  readonly data = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    return this.data.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

/** Signature of `FakeHost.pageReader`, which answers `host.page.readElement` (Watch Element, Read Element). */
export type PageReader = (options: ReadElementOptions) => Promise<ReadElementResult>;

/**
 * A complete in-memory `Host` for engine and block tests. Every capability records what it was asked to
 * do in a public array (`opened`, `actions`, `requests`, `notifications`, `sleeps`, …) and answers through
 * a replaceable hook (`pageReader`, `agent`, `httpHandler`, `htmlAgent`, `scriptResult`, `promptAnswer`, …).
 * Time is virtual: `now()` starts at 2026-01-01T00:00:00Z and moves only with `advance(ms)`.
 */
export class FakeHost implements Host {
  readonly routeCalls: { tabId: number; options: RouteOptions }[] = [];
  readonly emulations: { tabId: number; options: EmulateOptions }[] = [];
  readonly clearedSites: ClearSiteDataOptions[] = [];
  readonly harCalls: { tabId: number; action: 'start' | 'stop' }[] = [];
  consoleEntries: ConsoleEntry[] = [];
  harResult: HarResult = { recording: false, har: { log: { version: '1.2', creator: { name: 'BlockFlow', version: '0.4.0' }, entries: [] } } };
  network = {
    route: async (tabId: number, options: RouteOptions): Promise<RouteResult> => {
      this.routeCalls.push({ tabId, options });
      return { rules: options.action === 'clear' ? 0 : options.rules.length, backend: options.backend === 'dnr' ? 'dnr' : 'cdp' };
    },
    har: async (tabId: number, action: 'start' | 'stop'): Promise<HarResult> => {
      this.harCalls.push({ tabId, action });
      return action === 'start' ? { recording: true } : this.harResult;
    },
    console: async (_tabId: number): Promise<ConsoleEntry[]> => this.consoleEntries,
  };
  environment = {
    emulate: async (tabId: number, options: EmulateOptions): Promise<void> => { this.emulations.push({ tabId, options }); },
    clearSiteData: async (options: ClearSiteDataOptions): Promise<void> => { this.clearedSites.push(options); },
  };
  readonly scheduler = new FakeScheduler();
  readonly state = new MemoryState();
  readonly opened: OpenTabOptions[] = [];
  readonly reads: ReadElementOptions[] = [];
  readonly requests: HttpRequestOptions[] = [];
  readonly notifications: NotifyOptions[] = [];
  private clock = Date.parse('2026-01-01T00:00:00.000Z');
  private nextTabId = 100;

  /** Replace to control what the "page" contains. */
  pageReader: PageReader = async () => ({ found: true, text: '' });

  /** Replace to control what the "server" answers. */
  httpHandler: (options: HttpRequestOptions) => Promise<HttpResult> = async () => ({
    status: 200,
    ok: true,
    body: '',
  });

  /** Records each request in `requests` and answers with `httpHandler`; `download` returns a fake PNG. */
  http = {
    fetch: async (options: HttpRequestOptions) => {
      this.requests.push(options);
      return this.httpHandler(options);
    },
    download: async (url: string) => ({ base64: btoa(`file at ${url}`), mime: 'image/png', name: url.split('/').pop() ?? 'file' }),
  };

  /** Records each notification in `notifications`. */
  notify = async (options: NotifyOptions) => {
    this.notifications.push(options);
  };

  /** Open tabs: id → current URL. Closed tabs are removed. */
  readonly tabUrls = new Map<number, string>();
  /** Popups pages "opened", for Wait for Popup. */
  readonly popups: { openerTabId: number; tabId: number; url: string }[] = [];
  /** Network responses tabs "received", for Wait For response (`body` is returned with captureBody). */
  readonly responses: { tabId: number; url: string; status: number; method?: string; body?: string }[] = [];
  /** Requests tabs "sent", for Wait For request. */
  readonly sentRequests: { tabId: number; url: string; method: string; type?: string; postData?: string }[] = [];
  /** Options Wait For response passed, in order. */
  readonly responseOptions: ({ method?: string; captureBody?: boolean } | undefined)[] = [];
  /** Dialog settings sent per tab, and what dialogs "were shown". */
  readonly dialogSettings: { tabId: number; options: unknown }[] = [];
  shownDialogs: { type: string; message: string }[] = [];
  /** Scripts run (Run Script); `scriptResult` is what they return. */
  readonly scripts: { tabId: number; code: string; data: Payload }[] = [];
  scriptResult: unknown = null;
  /** realInput flags seen by page.act, in order. */
  readonly realInputs: boolean[] = [];
  /** The tab "the user is looking at" (Run button on Page Visited / Context Menu). */
  currentTab: { tabId: number; url: string } | null = null;
  /** Every request sent to the page agent. */
  readonly actions: { tabId: number; request: AgentRequest; timeoutMs: number }[] = [];
  readonly navigations: { tabId: number; options: NavigateOptions }[] = [];
  readonly loads: { tabId: number; until: WaitUntil }[] = [];

  /** Replace to control what the page agent answers (throw to simulate a failure). */
  agent: (tabId: number, request: AgentRequest) => Promise<Record<string, unknown>> = async () => ({});

  /**
   * Fake tabs backed by `tabUrls`. New tabs get ids from 100 up; `reuseTabId` reuses an open tab.
   * Navigating or acting on a closed tab throws "The tab was closed". `waitForPopup` / `waitForResponse`
   * consume entries a test pushed into `popups` / `responses`, and throw a timeout error when none match.
   */
  tabs = {
    open: async (options: OpenTabOptions) => {
      this.opened.push(options);
      const tabId = options.reuseTabId !== undefined && this.tabUrls.has(options.reuseTabId) ? options.reuseTabId : this.nextTabId++;
      this.tabUrls.set(tabId, options.url);
      if (options.waitUntil && options.waitUntil !== 'none') this.loads.push({ tabId, until: options.waitUntil });
      return { tabId };
    },
    navigate: async (tabId: number, options: NavigateOptions) => {
      this.navigations.push({ tabId, options });
      if (!this.tabUrls.has(tabId)) throw new Error('The tab was closed');
      if (options.action === 'goto' && options.url) this.tabUrls.set(tabId, options.url);
      return { url: this.tabUrls.get(tabId) ?? '' };
    },
    close: async (tabId: number) => {
      this.tabUrls.delete(tabId);
    },
    info: async (tabId: number): Promise<TabInfo | null> => {
      const url = this.tabUrls.get(tabId);
      return url === undefined ? null : { url, title: '', loading: false };
    },
    current: async () => (this.currentTab ? { ...this.currentTab, title: '', loading: false } : null),
    waitForLoad: async (tabId: number, until: WaitUntil) => {
      this.loads.push({ tabId, until });
    },
    waitForPopup: async (openerTabId: number) => {
      const popup = this.popups.find((candidate) => candidate.openerTabId === openerTabId);
      if (!popup) throw new Error('Timed out: no new tab was opened by this page');
      this.popups.splice(this.popups.indexOf(popup), 1);
      this.tabUrls.set(popup.tabId, popup.url);
      return popup.tabId;
    },
    waitForResponse: async (tabId: number, pattern: string, status: string, _lookBackMs: number, _timeoutMs: number, options?: { method?: string; captureBody?: boolean }) => {
      this.responseOptions.push(options);
      const method = (options?.method ?? '').toUpperCase();
      const found = this.responses.find(
        (response) => response.tabId === tabId && urlMatches(response.url, pattern) && (!status || String(response.status) === status) && (!method || (response.method ?? 'GET') === method),
      );
      if (!found) throw new Error(`Timed out waiting for a response from ${pattern}`);
      return { url: found.url, status: found.status, method: found.method ?? 'GET', ...(options?.captureBody ? { body: found.body ?? '' } : {}) };
    },
    waitForRequest: async (tabId: number, pattern: string, method: string) => {
      const found = this.sentRequests.find((request) => request.tabId === tabId && urlMatches(request.url, pattern) && (!method || request.method === method.toUpperCase()));
      if (!found) throw new Error(`Timed out waiting for a request to ${pattern}`);
      this.sentRequests.splice(this.sentRequests.indexOf(found), 1);
      return { url: found.url, method: found.method, type: found.type ?? 'xmlhttprequest', ...(found.postData !== undefined ? { postData: found.postData } : {}) };
    },
    waitForUrl: async (tabId: number, pattern: string, timeoutMs: number) => {
      const url = this.tabUrls.get(tabId) ?? '';
      if (!urlMatches(url, pattern)) throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for the URL to match ${pattern} (it is ${url})`);
      return url;
    },
  };

  /** Page access: `readElement` goes to `pageReader`, `act` to `agent` (after recording it in `actions`). */
  page = {
    readElement: async (options: ReadElementOptions) => {
      this.reads.push(options);
      return this.pageReader(options);
    },
    act: async (tabId: number, request: AgentRequest, timeoutMs: number, options?: { realInput?: boolean }) => {
      this.actions.push({ tabId, request, timeoutMs });
      this.realInputs.push(options?.realInput === true);
      if (!this.tabUrls.has(tabId)) throw new Error('The tab was closed');
      return this.agent(tabId, request);
    },
    dialogs: async (tabId: number, options: unknown) => {
      this.dialogSettings.push({ tabId, options });
      return this.shownDialogs;
    },
    runScript: async (tabId: number, code: string, data: Payload) => {
      this.scripts.push({ tabId, code, data });
      return this.scriptResult;
    },
  };

  /** Saved workflows, for Run Workflow. */
  readonly savedWorkflows = new Map<string, Workflow>();
  workflows = {
    get: async (id: string) => this.savedWorkflows.get(id),
  };

  secretValues: Record<string, string> = {};
  secrets = {
    all: async () => ({ ...this.secretValues }),
  };

  /** Screenshots taken: tab ids, in order. Return null from `screenshotResult` to simulate failure. */
  readonly screenshotsTaken: { tabId: number; runId: string }[] = [];
  /** Screenshot block requests, in order. */
  readonly screenshotRequests: { tabId: number; options: ScreenshotOptions }[] = [];
  screenshots = {
    capture: async (tabId: number, runId: string) => {
      this.screenshotsTaken.push({ tabId, runId });
      return `shot-${this.screenshotsTaken.length}`;
    },
    take: async (tabId: number, options: ScreenshotOptions) => {
      if (!this.tabUrls.has(tabId)) throw new Error('The tab was closed');
      this.screenshotRequests.push({ tabId, options });
      return { id: `block-shot-${this.screenshotRequests.length}`, width: 800, height: options.area === 'full' ? 2400 : 600 };
    },
  };

  /** The cookie jar: cookies by URL origin (a simple model: a cookie belongs to the origin it was set for). */
  readonly cookieJar: (CookieInfo & { origin: string })[] = [];
  cookies = {
    get: async (url: string, name?: string): Promise<CookieInfo[]> =>
      this.cookieJar.filter((cookie) => cookie.origin === new URL(url).origin && (!name || cookie.name === name)).map(({ origin: _origin, ...cookie }) => cookie),
    set: async (options: CookieSetOptions): Promise<CookieInfo> => {
      const origin = new URL(options.url).origin;
      const cookie: CookieInfo = {
        name: options.name,
        value: options.value,
        domain: options.domain ?? new URL(options.url).hostname,
        path: options.path ?? '/',
        expires: options.expires ?? -1,
        httpOnly: options.httpOnly ?? false,
        secure: options.secure ?? false,
        sameSite: options.sameSite ?? '',
      };
      const existing = this.cookieJar.findIndex((candidate) => candidate.origin === origin && candidate.name === options.name);
      if (existing >= 0) this.cookieJar.splice(existing, 1);
      this.cookieJar.push({ ...cookie, origin });
      return cookie;
    },
    remove: async (url: string, name?: string) => {
      const origin = new URL(url).origin;
      const gone = this.cookieJar.filter((cookie) => cookie.origin === origin && (!name || cookie.name === name));
      for (const cookie of gone) this.cookieJar.splice(this.cookieJar.indexOf(cookie), 1);
      return gone.length;
    },
  };

  /** Datasets by name; `write` appends or replaces and returns the new row count. */
  readonly datasetRows = new Map<string, unknown[]>();
  datasets = {
    read: async (name: string) => [...(this.datasetRows.get(name) ?? [])],
    write: async (name: string, rows: unknown[], mode: 'append' | 'replace') => {
      const next = [...(mode === 'append' ? (this.datasetRows.get(name) ?? []) : []), ...rows];
      this.datasetRows.set(name, next);
      return next.length;
    },
  };

  /** Files "saved" by Download, in order. */
  readonly downloaded: { filename: string; content: string; mime: string }[] = [];
  /** Downloads the "page" made, for Wait for Download (consumed in order), with their content. */
  readonly pageDownloads: (DownloadInfo & { content?: string })[] = [];
  /** readText calls: download id and the tab id passed. */
  readonly downloadReads: { downloadId: number; tabId?: number }[] = [];
  downloads = {
    save: async (filename: string, content: string, mime: string) => {
      this.downloaded.push({ filename, content, mime });
    },
    waitFor: async (pattern: string) => {
      const found = this.pageDownloads.find((download) => !pattern || urlMatches(download.url, pattern) || urlMatches(download.filename, pattern));
      if (!found) throw new Error(`Timed out: no download${pattern ? ` matching ${pattern}` : ''} started`);
      this.pageDownloads.splice(this.pageDownloads.indexOf(found), 1);
      const { content: _content, ...info } = found;
      this.readable.set(found.downloadId, found.content ?? '');
      return info;
    },
    readText: async (download: DownloadInfo, tabId?: number) => {
      this.downloadReads.push({ downloadId: download.downloadId, ...(tabId !== undefined ? { tabId } : {}) });
      return this.readable.get(download.downloadId) ?? '';
    },
  };
  private readonly readable = new Map<number, string>();

  /** HTML scraping runs the real page agent on jsdom-free input: tests replace this. */
  htmlAgent: (html: string, baseUrl: string, request: AgentRequest) => Promise<Record<string, unknown>> = async () => ({});
  html = {
    act: (html: string, baseUrl: string, request: AgentRequest) => this.htmlAgent(html, baseUrl, request),
  };

  /** What the "user" answers to Manual Step (default: continue). */
  readonly prompts: string[] = [];
  promptAnswer = true;
  prompt = {
    ask: async (options: { message: string }) => {
      this.prompts.push(options.message);
      return this.promptAnswer;
    },
  };

  /** Every sleep asked for (timeouts, retry backoff, Assert polling), in ms. */
  readonly sleeps: number[] = [];
  private sleepers: { at: number; resolve: () => void }[] = [];
  private virtualMs = 0;
  private pumping = false;

  /**
   * Virtual time: sleeps finish in the order they would in real time (a 250 ms poll before a 10 s
   * timeout), one per macrotask, without actually waiting.
   */
  sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      this.sleeps.push(ms);
      this.sleepers.push({ at: this.virtualMs + ms, resolve });
      this.pump();
    });

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    setTimeout(() => {
      this.pumping = false;
      this.sleepers.sort((a, b) => a.at - b.at);
      const next = this.sleepers.shift();
      if (!next) return;
      this.virtualMs = Math.max(this.virtualMs, next.at);
      next.resolve();
      if (this.sleepers.length > 0) this.pump();
    }, 0);
  }

  /** The fake clock (starts at 2026-01-01T00:00:00Z). */
  now(): Date {
    return new Date(this.clock);
  }

  /** Moves `now()` forward. Does not fire timers or finish sleeps: those are separate on purpose. */
  advance(ms: number): void {
    this.clock += ms;
  }

  /** Make the page return these texts, one per read (the last one repeats). */
  pageTexts(...texts: string[]): void {
    let index = 0;
    this.pageReader = async () => {
      const text = texts[Math.min(index, texts.length - 1)] ?? '';
      index += 1;
      return { found: true, text };
    };
  }
}

/** What `harness()` returns: a runner wired to a FakeHost, with its logs and run records collected. */
export interface Harness {
  host: FakeHost;
  logs: LogEntry[];
  /** Latest copy of every run, by id, in the order runs started. */
  runs: Map<string, RunRecord>;
  runner: WorkflowRunner;
  /** The most recently started run. */
  lastRun(): RunRecord | undefined;
  /** New runner for the same workflow and host, like the background worker after a restart. */
  restart(): WorkflowRunner;
  /** Fires the first timer whose name starts with `name`. */
  fire(name: string): Promise<void>;
  /** Logged messages, optionally only those of one level. */
  messages(level?: LogEntry['level']): string[];
}

/**
 * Builds a `WorkflowRunner` for `workflow` with the default block registry and `host` (a new FakeHost
 * unless given). Logs and run records are collected; `maxSteps` caps steps per run (loop tests).
 *
 * ```ts
 * const h = harness(flow([{ id: 't', type: 'timer', config: { seconds: 10, repeat: true } }, { id: 'o', type: 'open-url', config: { url: 'https://example.com/{{tick}}' } }], [['t', 'o']]));
 * await h.runner.start();
 * await h.fire('tick');
 * expect(h.host.opened[0].url).toBe('https://example.com/1');
 * ```
 */
export function harness(workflow: Workflow, host: FakeHost = new FakeHost(), maxSteps?: number): Harness {
  const logs: LogEntry[] = [];
  const runs = new Map<string, RunRecord>();
  const registry = createDefaultRegistry();
  const make = () =>
    new WorkflowRunner({
      workflow,
      registry,
      host,
      log: (entry) => logs.push(entry),
      onRun: (run) => runs.set(run.id, run),
      ...(maxSteps !== undefined ? { maxSteps } : {}),
    });
  const runner = make();
  return {
    host,
    logs,
    runs,
    runner,
    lastRun: () => [...runs.values()].at(-1),
    restart: make,
    async fire(name: string) {
      const [key] = host.scheduler.keysNamed(name);
      if (!key) throw new Error(`No timer named "${name}" is scheduled`);
      await runner.handleTimer(key);
    },
    messages(level) {
      return logs.filter((entry) => !level || entry.level === level).map((entry) => entry.message);
    },
  };
}

let counter = 0;

/** Compact way to build a workflow in tests. Edges are [fromId, toId] or [fromId, toId, port]. */
export function flow(
  nodes: { id: string; type: string; config?: Record<string, unknown>; step?: StepSettings }[],
  edges: ([string, string] | [string, string, string])[],
): Workflow {
  counter += 1;
  return {
    schemaVersion: 2,
    id: `wf${counter}`,
    name: `Test flow ${counter}`,
    enabled: true,
    nodes: nodes.map((node, index) => ({
      id: node.id,
      type: node.type,
      position: { x: index * 100, y: 0 },
      config: node.config ?? {},
      ...(node.step ? { step: node.step } : {}),
    })),
    edges: edges.map(([source, target, sourcePort]) => ({
      id: `${source}-${sourcePort ?? ''}-${target}`,
      source,
      target,
      ...(sourcePort ? { sourcePort } : {}),
    })),
  };
}
