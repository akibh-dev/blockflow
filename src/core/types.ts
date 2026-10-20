/**
 * Shared types for the BlockFlow engine.
 *
 * Nothing in src/core touches browser APIs. Everything the engine needs from the
 * outside world (tabs, page reads, timers, storage) comes in through `Host`, so the
 * whole engine can be unit-tested in plain Node.
 */

/** Data passed from one block to the next. Must stay JSON-serialisable. */
export type Payload = Record<string, unknown>;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// ---------------------------------------------------------------------------
// Workflow model (what gets saved)
// ---------------------------------------------------------------------------

export interface NodeDef {
  id: string;
  /** Block type, e.g. "timer". Looked up in the BlockRegistry. */
  type: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

/** A connection: the output of `source` feeds the input of `target`. */
export interface EdgeDef {
  id: string;
  source: string;
  target: string;
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
  /** "selector" renders a "pick on page" button in the editor. "url" is validated as http(s). */
  kind: 'text' | 'url' | 'selector';
  placeholder?: string;
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

export type FieldSpec = TextField | NumberField | BooleanField | SelectField;

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
  nodeId: string;
  /** Config with defaults applied and templated fields rendered against the input payload. */
  config: C;
  /** True when no other block feeds this one, so it starts the flow. */
  isRoot: boolean;
  host: Host;
  /** Send a payload to every block connected to this block's output. */
  emit(payload: Payload): Promise<void>;
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

export interface BlockDefinition<C extends object = BlockConfig> {
  type: string;
  label: string;
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
   * Called when the workflow starts, for blocks that nothing else feeds ("root" blocks).
   * Long-running sources (timers, watchers) schedule themselves here. If a root block has
   * no `start`, its `run` is called once with an empty payload instead.
   */
  start?(ctx: BlockContext<C>): Promise<void> | void;

  /**
   * Called when an upstream block emits. Return a payload to continue the flow, or
   * null/undefined to stop it here.
   */
  run?(ctx: BlockContext<C>, input: Payload): Promise<Payload | null | undefined | void>;

  /** Called when a timer this block scheduled via ctx.timers.set fires. */
  onTimer?(ctx: BlockContext<C>, name: string, data: Payload | undefined): Promise<void> | void;
}

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
}

export interface ReadElementOptions {
  url: string;
  selector: string;
  /** Reload the page before reading so server-side changes show up. */
  reload: boolean;
}

export interface ReadElementResult {
  found: boolean;
  text: string;
  /** Set when the read itself failed, e.g. an invalid selector. */
  error?: string;
}

export interface Host {
  tabs: {
    open(options: OpenTabOptions): Promise<{ tabId: number }>;
  };
  page: {
    readElement(options: ReadElementOptions): Promise<ReadElementResult>;
  };
  scheduler: Scheduler;
  state: StateStore;
  now(): Date;
}
