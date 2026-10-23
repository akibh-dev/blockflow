import type {
  Host,
  HttpRequestOptions,
  HttpResult,
  NotifyOptions,
  LogEntry,
  OpenTabOptions,
  Payload,
  ReadElementOptions,
  ReadElementResult,
  Scheduler,
  StateStore,
  StepSettings,
  TimerOptions,
  TimerRecord,
  Workflow,
} from '../../src/core/types';
import { WorkflowRunner } from '../../src/core/engine';
import type { RunRecord } from '../../src/core/runs';
import { createDefaultRegistry } from '../../src/core/blocks';

interface StoredTimer extends TimerOptions {
  data?: Payload;
}

/** In-memory scheduler. Tests "fire" timers by calling runner.handleTimer(key) themselves. */
export class FakeScheduler implements Scheduler {
  readonly timers = new Map<string, StoredTimer>();

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

export class MemoryState implements StateStore {
  readonly data = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    return this.data.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

export type PageReader = (options: ReadElementOptions) => Promise<ReadElementResult>;

export class FakeHost implements Host {
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

  http = {
    fetch: async (options: HttpRequestOptions) => {
      this.requests.push(options);
      return this.httpHandler(options);
    },
  };

  notify = async (options: NotifyOptions) => {
    this.notifications.push(options);
  };

  tabs = {
    open: async (options: OpenTabOptions) => {
      this.opened.push(options);
      return { tabId: this.nextTabId++ };
    },
  };

  page = {
    readElement: async (options: ReadElementOptions) => {
      this.reads.push(options);
      return this.pageReader(options);
    },
  };

  /** Every sleep the engine asked for (timeouts, retry backoff). Resolves on the next macrotask. */
  readonly sleeps: number[] = [];

  sleep = (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    return new Promise((resolve) => setTimeout(resolve, 0));
  };

  now(): Date {
    return new Date(this.clock);
  }

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
  messages(level?: LogEntry['level']): string[];
}

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
    schemaVersion: 1,
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
