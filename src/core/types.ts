/**
 * Shared types for the BlockFlow engine.
 *
 * Nothing in src/core touches browser APIs. Everything the engine needs from the
 * outside world (tabs, page reads, timers, storage) comes in through `Host`, so the
 * whole engine can be unit-tested in plain Node.
 */

import type { AgentRequest, ReadKind, WaitUntil } from './page';
import type { Routed } from './ports';

export type { ReadKind } from './page';

/** Data passed from one block to the next. Must stay JSON-serialisable. */
export type Payload = Record<string, unknown>;

/** Severity of a run-log line. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// ---------------------------------------------------------------------------
// Workflow model (what gets saved)
// ---------------------------------------------------------------------------

/**
 * Settings every block has, handled by the engine rather than by each block:
 * how long it may take, how often to retry, and what a failure does to the run.
 */
export interface StepSettings {
  /** Seconds before the step fails. Default DEFAULT_TIMEOUT_SECONDS in engine.ts. */
  timeoutSeconds?: number;
  /** Extra attempts after a failure (0 to 5). */
  retries?: number;
  /**
   * stop: this path stops and the run fails (default).
   * continue: log it and pass the input on as if nothing happened.
   * port: send the input plus `error` out of the block's "error" output.
   */
  onError?: 'stop' | 'continue' | 'port';
  /** Skip this block: its input is passed straight on. */
  disabled?: boolean;
  /** Free text shown on the block. */
  note?: string;
  /** Screenshot of the run's tab: on error (default), always, or never. */
  screenshot?: 'error' | 'always' | 'never';
  /**
   * Page actions with real mouse and keyboard events through the browser's debugger (Chromium only;
   * shows a "started debugging this browser" bar). For sites that ignore synthetic events.
   */
  realInput?: boolean;
}

/** One block placed in a workflow (a React Flow node when edited). */
export interface NodeDef {
  id: string;
  /** Block type, e.g. "timer". Looked up in the BlockRegistry. */
  type: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  step?: StepSettings;
  /**
   * The node's id in the file it was imported from (import gives every node a fresh id). Run reports
   * carry it as `StepRecord.sourceId`, so a result maps back to the author's script.
   */
  origin?: string;
}

/** A connection: the output of `source` feeds the input of `target`. */
export interface EdgeDef {
  id: string;
  source: string;
  target: string;
  /** Which output of `source`, e.g. "true" on an If block. Missing = the block's first output. */
  sourcePort?: string;
}

/** A saved workflow: a graph of blocks and connections. Stored as a list under `bf:workflows`. */
export interface Workflow {
  /** See migrate.ts. Loaded and imported workflows are migrated to the current version. */
  schemaVersion: 2;
  id: string;
  name: string;
  /** Enabled workflows run in the background. */
  enabled: boolean;
  nodes: NodeDef[];
  edges: EdgeDef[];
}

/** One line of the run log. */
export interface LogEntry {
  /** ISO timestamp. */
  ts: string;
  workflowId: string;
  nodeId?: string;
  level: LogLevel;
  message: string;
}

/** Receives every log line a runner writes (already secret-masked). */
export type LogSink = (entry: LogEntry) => void;

// ---------------------------------------------------------------------------
// Block definition (what a block type is)
// ---------------------------------------------------------------------------

/** Properties shared by every setting field kind. */
interface FieldBase {
  key: string;
  label: string;
  help?: string;
  required?: boolean;
}

/** A one-line or multi-line text setting (also URLs, selectors and locators). */
export interface TextField extends FieldBase {
  /**
   * "selector" (CSS) and "locator" (any locator syntax, see src/dom/locator.ts) render a
   * "pick on page" button in the editor. "url" is validated as http(s).
   */
  kind: 'text' | 'url' | 'selector' | 'locator';
  placeholder?: string;
  /** Several lines (CSV data, scripts, long messages). */
  multiline?: boolean;
  /** When true, `{{value}}` placeholders are filled from the incoming payload at run time. */
  templated?: boolean;
  /**
   * With `templated`: the block renders the value itself, once per list item (with `{{item}}` in
   * scope), so the engine leaves it as typed. The editor still offers and checks `{{…}}`.
   */
  perItem?: boolean;
  /** For kind "selector": config key the picker also fills with the page URL. */
  pickerUrlKey?: string;
  /**
   * What "Pick on page" puts in: a readable locator (role=…, label=…; default, best for actions) or
   * a structural CSS selector ("stable": keeps working when the element's text changes, for watching).
   */
  pickPrefers?: 'readable' | 'stable';
}

/** A numeric setting; numeric strings are coerced by `withDefaults`. */
export interface NumberField extends FieldBase {
  kind: 'number';
  min?: number;
  max?: number;
  step?: number;
}

/** An on/off setting. */
export interface BooleanField extends FieldBase {
  kind: 'boolean';
}

/** A choice from fixed options; the stored value must be one of `options[].value`. */
export interface SelectField extends FieldBase {
  kind: 'select';
  options: { value: string; label: string }[];
}

/** A table of rows, e.g. Fill Form's "field → value" list. Stored as an array of objects of strings. */
export interface RowsField extends FieldBase {
  kind: 'rows';
  columns: {
    key: string;
    label: string;
    placeholder?: string;
    /** Renders a "pick on page" button for this column. */
    locator?: boolean;
    templated?: boolean;
  }[];
  /** Shows a "Detect fields" button that fills the rows from a form picked on the page. */
  detectForm?: boolean;
}

/** Pick another saved workflow (stores its id). */
export interface WorkflowField extends FieldBase {
  kind: 'workflow';
}

/** Every setting kind a block can declare; the editor renders a control per kind. */
export type FieldSpec = TextField | NumberField | BooleanField | SelectField | RowsField | WorkflowField;

/** One row of a `rows` field. */
export type Row = Record<string, string>;

/** Documents one key a block adds to its output payload. */
export interface OutputSpec {
  key: string;
  description: string;
}

/** Untyped block settings, as stored in `NodeDef.config`. */
export type BlockConfig = Record<string, unknown>;

/** When a block timer fires: once after `delayMs`, then every `periodMs` if set. */
export interface TimerOptions {
  delayMs: number;
  /** When set, the timer repeats at this interval after the first delay. */
  periodMs?: number;
}

/**
 * What the engine hands a block on every call (`start`, `trigger`, `run`, `onTimer`).
 * Built per call by `WorkflowRunner.makeContext`; never keep it between calls.
 */
export interface BlockContext<C extends object = BlockConfig> {
  workflowId: string;
  workflowName: string;
  /** Id of this block's node in the workflow. */
  nodeId: string;
  /** Config with defaults applied and templated fields rendered against the input payload. */
  config: C;
  /** True when no other block feeds this one, so it starts the flow. */
  isRoot: boolean;
  /** How long this step may take (its step settings). Page blocks give their waits a little less. */
  timeoutMs: number;
  /** Step setting: use real (debugger) input for page actions. */
  realInput: boolean;
  /** Id of the run this step belongs to ('' for start blocks between runs). */
  runId: string;
  /**
   * True once this step should give up: its run was stopped, the workflow was switched off, or the
   * step timed out. Long waits inside a block (`host.sleep` in slices) should check it.
   */
  aborted(): boolean;
  /**
   * Marks this step and the run as failed but keeps going (a "soft" assertion). The block still
   * returns its output normally. Pass a `CodedError` (src/core/errors.ts) to record its code.
   */
  softFail(failure: string | Error): void;
  /**
   * Runs another saved workflow with `input` as its data, like calling a function, and resolves
   * with the data its last block produced. Throws when that run fails.
   */
  callWorkflow(workflowId: string, input: Payload): Promise<Payload>;
  host: Host;
  /** Send a payload to every block connected to one of this block's outputs (default "out"). */
  emit(payload: Payload, port?: string): Promise<void>;
  /** Writes a run-log line tagged with this block. */
  log(level: LogLevel, message: string): void;
  /** Timers scoped to this block (keyed by workflow, node and `name`). Fire `onTimer`. */
  timers: {
    set(name: string, options: TimerOptions, data?: Payload): Promise<void>;
    clear(name: string): Promise<void>;
  };
  /** Small per-block key/value store that survives restarts of the background worker. */
  state: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
  };
}

/** Palette group of a block. */
export type BlockCategory = 'start' | 'browser' | 'page' | 'read' | 'test' | 'logic' | 'data' | 'output';

/** Palette heading for each category. */
export const CATEGORY_LABELS: Record<BlockCategory, string> = {
  start: 'Start',
  browser: 'Tabs',
  page: 'Page actions',
  read: 'Read & scrape',
  test: 'Test',
  logic: 'Logic & loops',
  data: 'Data',
  output: 'Send & log',
};

/** A block type: its settings, editor metadata and lifecycle hooks. `C` is its config shape. */
export interface BlockDefinition<C extends object = BlockConfig> {
  type: string;
  label: string;
  /** Palette group; set when registered (see BLOCK_GROUPS in blocks/index.ts). */
  category?: BlockCategory;
  description: string;
  icon: string;
  /** Accent colour used by the editor. */
  accent: string;
  defaultConfig: C;
  fields: FieldSpec[];
  /** What this block puts in its output payload (shown in the editor to help wiring). */
  outputs: OutputSpec[];
  /** One short line shown on the block in the editor. */
  summary?(config: C): string;

  /**
   * Named outputs. Default ['out']. A block picks one by returning `routeTo(port, payload)`.
   * The engine adds an "error" output when the block's step settings ask for it.
   */
  ports?: string[];

  /** Default timeout for this kind of block, in seconds (engine default: 60). Page actions use 30. */
  timeoutSeconds?: number;

  /**
   * Its page actions honour the step setting "Use real mouse and keyboard" (`StepSettings.realInput`,
   * handed to `Host.page.act`). The editor offers that setting only on these blocks.
   */
  realInput?: boolean;

  /** Optional browser permissions this block needs (the editor offers a Grant button). */
  permissions?: ('debugger' | 'userScripts')[];

  /**
   * Called when the workflow starts, for blocks that nothing else feeds ("root" blocks).
   * Long-running sources (timers, watchers) schedule themselves here. If a root block has
   * no `start`, its `run` is called once with an empty payload instead.
   */
  start?(ctx: BlockContext<C>): Promise<void> | void;

  /**
   * For start blocks: what to send when the user presses Run instead of waiting for the
   * schedule, e.g. a Timer fires once right away. Return null to send nothing.
   * Start blocks without `trigger` but with `run` are run with an empty payload.
   */
  trigger?(ctx: BlockContext<C>): Promise<Payload | null>;

  /**
   * Called when an upstream block emits. Return a payload to continue the flow, or
   * null/undefined to stop it here.
   */
  run?(ctx: BlockContext<C>, input: Payload): Promise<RunOutput>;

  /** Called when a timer this block scheduled via ctx.timers.set fires. */
  onTimer?(ctx: BlockContext<C>, name: string, data: Payload | undefined): Promise<void> | void;
}

/** What `run` returns: a payload (sent out of the first output), a routed payload, or nothing (stop). */
export type RunOutput = Payload | Routed | null | undefined | void;

// The registry stores heterogeneous blocks, so config types are erased there.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBlockDefinition = BlockDefinition<any>;

// ---------------------------------------------------------------------------
// Host: everything the engine needs from the outside world
// ---------------------------------------------------------------------------

/** What the scheduler stored for a timer, handed back by `Scheduler.take`. */
export interface TimerRecord {
  data?: Payload;
  periodic: boolean;
}

/** Durable timers keyed by `makeTimerKey(...)`. Implemented by `HybridScheduler` in the browser. */
export interface Scheduler {
  /** Creates or replaces the timer `key`, storing `data` with it (must be JSON-serialisable). */
  set(key: string, options: TimerOptions, data?: Payload): Promise<void>;
  /** Removes one timer; unknown keys are ignored. */
  clear(key: string): Promise<void>;
  /** Removes every timer whose key starts with `prefix` (a workflow's timers on start/stop). */
  clearPrefix(prefix: string): Promise<void>;
  /**
   * Called when a timer fires. Returns the stored record, and removes it if the timer was
   * one-shot. Returns undefined for stale or cleared timers, which the engine then ignores.
   */
  take(key: string): Promise<TimerRecord | undefined>;
}

/** Durable key/value store behind `ctx.state` (keys come from `stateKey(...)`). */
export interface StateStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** Options for `Host.tabs.open` (Open Tab block). */
export interface OpenTabOptions {
  url: string;
  /** false = navigate the current tab instead of opening a new one. */
  newTab: boolean;
  active: boolean;
  /** Navigate this tab instead, if it still exists (a workflow's own tab, reused between runs). */
  reuseTabId?: number;
  /** Open in a new window (tests: a visible window is not throttled like a background tab). */
  newWindow?: boolean;
  /** Default 'none': do not wait. */
  waitUntil?: WaitUntil;
  timeoutMs?: number;
}

/** Options for `Host.tabs.navigate` (Navigate block). */
export interface NavigateOptions {
  action: 'goto' | 'back' | 'forward' | 'reload';
  url?: string;
  waitUntil: WaitUntil;
  timeoutMs: number;
}

/** What `Host.tabs.info` / `current` report about a tab. */
export interface TabInfo {
  url: string;
  title: string;
  loading: boolean;
}

/** Options for `Host.page.readElement` (reading a URL in BlockFlow's own background tab). */
export interface ReadElementOptions {
  url: string;
  selector: string;
  /** Default `{ kind: 'text' }`. `name` is the attribute or class name. */
  read?: { kind: ReadKind; name?: string };
  /** Reload the page before reading so server-side changes show up. */
  reload: boolean;
}

/** Answer of `Host.page.readElement`. */
export interface ReadElementResult {
  found: boolean;
  /** The value that was read, as text ("true"/"false" for has-class and exists). */
  text: string;
  /** Number of elements the selector matched. */
  count?: number;
  /** Set when the read itself failed, e.g. an invalid selector. */
  error?: string;
}

/** Request for `Host.http.fetch` (HTTP Request block). */
export interface HttpRequestOptions {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Response of `Host.http.fetch`. */
export interface HttpResult {
  status: number;
  ok: boolean;
  /** Response body as text, cut to a safe size. */
  body: string;
}

/** A desktop notification. */
export interface NotifyOptions {
  title: string;
  message: string;
}

/**
 * Everything the engine and blocks may do outside pure computation. Implemented by
 * `src/browser/host.ts` with extension APIs and by `tests/helpers/fakeHost.ts` in memory.
 */
export interface Host {
  /** Wait without blocking. Used for step timeouts and retry backoff. */
  sleep(ms: number): Promise<void>;
  http: {
    fetch(options: HttpRequestOptions): Promise<HttpResult>;
    /** A file, as base64 (Upload File from a URL). */
    download(url: string): Promise<{ base64: string; mime: string; name: string }>;
  };
  notify(options: NotifyOptions): Promise<void>;
  tabs: {
    open(options: OpenTabOptions): Promise<{ tabId: number }>;
    navigate(tabId: number, options: NavigateOptions): Promise<{ url: string }>;
    close(tabId: number): Promise<void>;
    /** null when the tab no longer exists. */
    info(tabId: number): Promise<TabInfo | null>;
    /** The web page tab the user is looking at (not the editor), or null. */
    current(): Promise<(TabInfo & { tabId: number }) | null>;
    waitForLoad(tabId: number, until: WaitUntil, timeoutMs: number): Promise<void>;
    /** Resolves with the URL once it matches `pattern` (see urlPattern.ts). */
    waitForUrl(tabId: number, pattern: string, timeoutMs: number): Promise<string>;
    /** A tab opened by `openerTabId` (window.open, target=_blank) in the last `lookBackMs`, or the next one. */
    waitForPopup(openerTabId: number, lookBackMs: number, timeoutMs: number): Promise<number>;
    /**
     * A finished network request of the tab whose URL matches `pattern` (and status, if given:
     * "200", "2xx"), from the last `lookBackMs`, or the next one.
     */
    waitForResponse(tabId: number, pattern: string, status: string, lookBackMs: number, timeoutMs: number): Promise<{ url: string; status: number; method: string }>;
  };
  page: {
    /** Watch Element / Read Element without a tab: BlockFlow's own background tab per URL. */
    readElement(options: ReadElementOptions): Promise<ReadElementResult>;
    /**
     * Runs one request in a tab through the page agent, waiting until it can be done (element
     * present, visible, enabled...) or `timeoutMs` passes. Throws with the reason.
     */
    act(tabId: number, request: AgentRequest, timeoutMs: number, options?: { realInput?: boolean }): Promise<Record<string, unknown>>;
    /**
     * alert/confirm/prompt in the tab's current page: answer them from now on (accept or dismiss,
     * with text for prompt), or read the ones shown so far.
     */
    dialogs(tabId: number, options: { mode: 'accept' | 'dismiss'; text: string } | { read: true }): Promise<{ type: string; message: string }[]>;
    /** Runs the user's own JavaScript in the page (Chrome's userScripts API). Resolves with its return value. */
    runScript(tabId: number, code: string, data: Payload): Promise<unknown>;
  };
  scheduler: Scheduler;
  state: StateStore;
  /** Saved workflows, for Run Workflow. */
  workflows: {
    get(id: string): Promise<Workflow | undefined>;
  };
  /** Named secret values, used as {{secret.name}} and masked in logs and run records. */
  secrets: {
    all(): Promise<Record<string, string>>;
  };
  /** Screenshot of a tab's visible area; resolves with an id to show it later, or null if not possible. */
  screenshots: {
    capture(tabId: number, runId: string): Promise<string | null>;
  };
  /** Named lists of rows kept between runs (scraped data, test results). */
  datasets: {
    read(name: string): Promise<unknown[]>;
    /** Resolves with the dataset's size afterwards. */
    write(name: string, rows: unknown[], mode: 'append' | 'replace'): Promise<number>;
  };
  /** Saves a file to the user's Downloads folder. */
  downloads: {
    save(filename: string, content: string, mime: string): Promise<void>;
  };
  /** Runs a page-agent request against HTML that was fetched, not shown in a tab (Extract from HTML). */
  html: {
    act(html: string, baseUrl: string, request: AgentRequest): Promise<Record<string, unknown>>;
  };
  /** Ask the user to do something and confirm (Manual Step). Resolves true = continue, false = fail. */
  prompt: {
    ask(options: { runId: string; workflowName: string; message: string; timeoutMs: number }): Promise<boolean>;
  };
  /** Current time; blocks and the engine use this instead of `new Date()` so tests can fake it. */
  now(): Date;
}
