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
}

export interface NodeDef {
  id: string;
  /** Block type, e.g. "timer". Looked up in the BlockRegistry. */
  type: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  step?: StepSettings;
}

/** A connection: the output of `source` feeds the input of `target`. */
export interface EdgeDef {
  id: string;
  source: string;
  target: string;
  /** Which output of `source`, e.g. "true" on an If block. Missing = the block's first output. */
  sourcePort?: string;
}

export interface Workflow {
  schemaVersion: 1;
  id: string;
  name: string;
  /** Enabled workflows run in the background. */
  enabled: boolean;
  nodes: NodeDef[];
  edges: EdgeDef[];
}

export interface LogEntry {
  /** ISO timestamp. */
  ts: string;
  workflowId: string;
  nodeId?: string;
  level: LogLevel;
  message: string;
}

export type LogSink = (entry: LogEntry) => void;

// ---------------------------------------------------------------------------
// Block definition (what a block type is)
// ---------------------------------------------------------------------------

interface FieldBase {
  key: string;
  label: string;
  help?: string;
  required?: boolean;
}

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
  /** For kind "selector": config key the picker also fills with the page URL. */
  pickerUrlKey?: string;
}

export interface NumberField extends FieldBase {
  kind: 'number';
  min?: number;
  max?: number;
  step?: number;
}

export interface BooleanField extends FieldBase {
  kind: 'boolean';
}

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

export type FieldSpec = TextField | NumberField | BooleanField | SelectField | RowsField | WorkflowField;

export type Row = Record<string, string>;

export interface OutputSpec {
  key: string;
  description: string;
}

export type BlockConfig = Record<string, unknown>;

export interface TimerOptions {
  delayMs: number;
  /** When set, the timer repeats at this interval after the first delay. */
  periodMs?: number;
}

export interface BlockContext<C extends object = BlockConfig> {
  workflowId: string;
  workflowName: string;
  nodeId: string;
  /** Config with defaults applied and templated fields rendered against the input payload. */
  config: C;
  /** True when no other block feeds this one, so it starts the flow. */
  isRoot: boolean;
  /** How long this step may take (its step settings). Page blocks give their waits a little less. */
  timeoutMs: number;
  /** Id of the run this step belongs to ('' for start blocks between runs). */
  runId: string;
  /**
   * Marks this step and the run as failed but keeps going (a "soft" assertion). The block still
   * returns its output normally.
   */
  softFail(message: string): void;
  /**
   * Runs another saved workflow with `input` as its data, like calling a function, and resolves
   * with the data its last block produced. Throws when that run fails.
   */
  callWorkflow(workflowId: string, input: Payload): Promise<Payload>;
  host: Host;
  /** Send a payload to every block connected to one of this block's outputs (default "out"). */
  emit(payload: Payload, port?: string): Promise<void>;
  log(level: LogLevel, message: string): void;
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

export type BlockCategory = 'start' | 'browser' | 'page' | 'read' | 'test' | 'logic' | 'data' | 'output';

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

export interface TimerRecord {
  data?: Payload;
  periodic: boolean;
}

export interface Scheduler {
  set(key: string, options: TimerOptions, data?: Payload): Promise<void>;
  clear(key: string): Promise<void>;
  clearPrefix(prefix: string): Promise<void>;
  /**
   * Called when a timer fires. Returns the stored record, and removes it if the timer was
   * one-shot. Returns undefined for stale or cleared timers, which the engine then ignores.
   */
  take(key: string): Promise<TimerRecord | undefined>;
}

export interface StateStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

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

export interface NavigateOptions {
  action: 'goto' | 'back' | 'forward' | 'reload';
  url?: string;
  waitUntil: WaitUntil;
  timeoutMs: number;
}

export interface TabInfo {
  url: string;
  title: string;
  loading: boolean;
}

export interface ReadElementOptions {
  url: string;
  selector: string;
  /** Default `{ kind: 'text' }`. `name` is the attribute or class name. */
  read?: { kind: ReadKind; name?: string };
  /** Reload the page before reading so server-side changes show up. */
  reload: boolean;
}

export interface ReadElementResult {
  found: boolean;
  /** The value that was read, as text ("true"/"false" for has-class and exists). */
  text: string;
  /** Number of elements the selector matched. */
  count?: number;
  /** Set when the read itself failed, e.g. an invalid selector. */
  error?: string;
}

export interface HttpRequestOptions {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResult {
  status: number;
  ok: boolean;
  /** Response body as text, cut to a safe size. */
  body: string;
}

export interface NotifyOptions {
  title: string;
  message: string;
}

export interface Host {
  /** Wait without blocking. Used for step timeouts and retry backoff. */
  sleep(ms: number): Promise<void>;
  http: {
    fetch(options: HttpRequestOptions): Promise<HttpResult>;
  };
  notify(options: NotifyOptions): Promise<void>;
  tabs: {
    open(options: OpenTabOptions): Promise<{ tabId: number }>;
    navigate(tabId: number, options: NavigateOptions): Promise<{ url: string }>;
    close(tabId: number): Promise<void>;
    /** null when the tab no longer exists. */
    info(tabId: number): Promise<TabInfo | null>;
    waitForLoad(tabId: number, until: WaitUntil, timeoutMs: number): Promise<void>;
    /** Resolves with the URL once it matches `pattern` (see urlPattern.ts). */
    waitForUrl(tabId: number, pattern: string, timeoutMs: number): Promise<string>;
  };
  page: {
    /** Watch Element / Read Element without a tab: BlockFlow's own background tab per URL. */
    readElement(options: ReadElementOptions): Promise<ReadElementResult>;
    /**
     * Runs one request in a tab through the page agent, waiting until it can be done (element
     * present, visible, enabled...) or `timeoutMs` passes. Throws with the reason.
     */
    act(tabId: number, request: AgentRequest, timeoutMs: number): Promise<Record<string, unknown>>;
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
  now(): Date;
}
