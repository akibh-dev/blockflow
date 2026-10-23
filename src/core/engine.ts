import { resolveConfig } from './config';
import { uid } from './id';
import { DEFAULT_PORT, ERROR_PORT, Routed, edgePort, nodePorts } from './ports';
import { MAX_STEPS_KEPT, compactPayload } from './runs';
import type { RunObserver, RunRecord, RunTrigger, StepRecord } from './runs';
import { makeTimerKey, parseTimerKey, stateKey, workflowTimerPrefix } from './timerKey';
import type { BlockRegistry } from './registry';
import type {
  AnyBlockDefinition,
  BlockContext,
  Host,
  LogLevel,
  LogSink,
  NodeDef,
  Payload,
  RunOutput,
  Workflow,
} from './types';

/** Most blocks one run may pass through. Stops accidental infinite loops. */
export const DEFAULT_MAX_STEPS = 1000;
/** A step that takes longer than this fails, unless its step settings say otherwise. */
export const DEFAULT_TIMEOUT_SECONDS = 60;
export const MAX_RETRIES = 5;

export interface RunnerOptions {
  workflow: Workflow;
  registry: BlockRegistry;
  host: Host;
  log?: LogSink;
  maxSteps?: number;
  /** Called with a copy of a run after every change (step started, step finished, run ended). */
  onRun?: RunObserver;
  /** Asked before every step; true stops the run (the Stop button). */
  isCancelled?: (runId: string) => boolean;
}

/** Book-keeping for one run while it is going. */
interface ActiveRun {
  record: RunRecord;
  steps: number;
  failed: boolean;
  cancelled: boolean;
  budgetHit: boolean;
}

type Invoke = (ctx: BlockContext<never>, input: Payload) => Promise<RunOutput>;

/**
 * Runs one workflow.
 *
 * Model (same idea as n8n / node-RED):
 *  - Blocks are nodes, connections are edges. A block's result goes out of one of its outputs
 *    ("out", or "true"/"false" on If, or "error") to every block connected to that output.
 *  - Blocks with nothing connected to their input are "root" blocks. They start the flow
 *    when the workflow is enabled (`start()`), or once when the user presses Run (`runOnce()`).
 *  - Each trip of data through the workflow is a run. Every block it passes is a step, with
 *    timeout, retries and error handling applied here, not in the blocks.
 *  - Anything time-based goes through the host scheduler, never through setTimeout, so a
 *    freshly created runner (after the background worker slept) can pick the flow back up
 *    via `handleTimer()`.
 */
export class WorkflowRunner {
  private readonly workflow: Workflow;
  private readonly registry: BlockRegistry;
  private readonly host: Host;
  private readonly sink: LogSink | undefined;
  private readonly maxSteps: number;
  private readonly observer: RunObserver | undefined;
  private readonly isCancelled: (runId: string) => boolean;
  private readonly nodesById = new Map<string, NodeDef>();
  private readonly hasIncoming = new Set<string>();
  private stopped = false;

  constructor(options: RunnerOptions) {
    this.workflow = options.workflow;
    this.registry = options.registry;
    this.host = options.host;
    this.sink = options.log;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.observer = options.onRun;
    this.isCancelled = options.isCancelled ?? (() => false);
    for (const node of this.workflow.nodes) this.nodesById.set(node.id, node);
    for (const edge of this.workflow.edges) this.hasIncoming.add(edge.target);
  }

  get workflowId(): string {
    return this.workflow.id;
  }

  /** Blocks that nothing feeds. These start the flow. */
  rootNodes(): NodeDef[] {
    return this.workflow.nodes.filter((node) => !this.hasIncoming.has(node.id));
  }

  /** (Re)starts the workflow in the background: clears old timers, then starts every root block. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.host.scheduler.clearPrefix(workflowTimerPrefix(this.workflow.id));

    const roots = this.rootNodes();
    if (roots.length === 0) {
      this.log('warn', undefined, 'Nothing to start: every block has an input.');
      return;
    }
    this.log('info', undefined, `Workflow "${this.workflow.name}" started`);
    for (const node of roots) await this.startRoot(node);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.host.scheduler.clearPrefix(workflowTimerPrefix(this.workflow.id));
    this.log('info', undefined, `Workflow "${this.workflow.name}" stopped`);
  }

  /**
   * Runs the workflow once, now (the Run button). Works whether or not the workflow is on, and
   * schedules nothing: a Timer start block fires once immediately instead of starting its schedule.
   */
  async runOnce(): Promise<RunRecord> {
    this.stopped = false;
    return this.inRun('manual', async (run) => {
      const roots = this.rootNodes();
      if (roots.length === 0) {
        run.failed = true;
        run.record.error = 'Nothing to start: every block has an input.';
        return;
      }
      for (const node of roots) {
        const def = this.registry.get(node.type);
        if (def?.trigger) {
          const trigger = def.trigger;
          await this.runStep(node, {}, run, (ctx) => trigger(ctx));
        } else {
          await this.runStep(node, {}, run);
        }
      }
    });
  }

  /** Called by the host when a scheduled timer fires. Safe on a runner that was never started. */
  async handleTimer(key: string): Promise<void> {
    if (this.stopped) return;
    const parsed = parseTimerKey(key);
    if (!parsed || parsed.workflowId !== this.workflow.id) return;

    const record = await this.host.scheduler.take(key);
    if (!record) return; // cleared or stale

    const node = this.nodesById.get(parsed.nodeId);
    const def = node ? this.registry.get(node.type) : undefined;
    if (!node || !def || !def.onTimer) return;

    const resolved = resolveConfig(def, node.config, {});
    if (resolved.errors.length > 0) {
      this.log('error', node.id, `${def.label}: ${resolved.errors.join('; ')}`);
      return;
    }
    const ctx = this.makeContext(node, resolved.config, undefined, 'timer');
    await this.guard(node, def, async () => {
      await def.onTimer?.(ctx, parsed.name, record.data);
    });
  }

  // -------------------------------------------------------------------------
  // Starting

  private async startRoot(node: NodeDef): Promise<void> {
    const def = this.registry.get(node.type);
    if (!def) {
      this.log('error', node.id, `Unknown block type "${node.type}"`);
      return;
    }
    if (!def.start) {
      // A plain block at the start (e.g. HTTP Request) runs once when the workflow is turned on.
      if (def.run) await this.inRun('start', (run) => this.runStep(node, {}, run));
      return;
    }
    const resolved = resolveConfig(def, node.config, {});
    if (resolved.errors.length > 0) {
      this.log('error', node.id, `${def.label}: ${resolved.errors.join('; ')}`);
      return;
    }
    const ctx = this.makeContext(node, resolved.config, undefined, 'start');
    await this.guard(node, def, async () => {
      await def.start?.(ctx);
    });
  }

  // -------------------------------------------------------------------------
  // Runs and steps

  private async inRun(trigger: RunTrigger, body: (run: ActiveRun) => Promise<void>): Promise<RunRecord> {
    const run: ActiveRun = {
      record: {
        id: uid(),
        workflowId: this.workflow.id,
        workflowName: this.workflow.name,
        trigger,
        status: 'running',
        startedAt: this.host.now().toISOString(),
        steps: [],
      },
      steps: 0,
      failed: false,
      cancelled: false,
      budgetHit: false,
    };
    this.publish(run);
    try {
      await body(run);
    } catch (error) {
      run.failed = true;
      run.record.error ??= errorMessage(error);
    }
    if (run.cancelled || this.isCancelled(run.record.id)) {
      run.record.status = 'cancelled';
      run.record.error ??= 'Stopped by the user.';
    } else {
      run.record.status = run.failed ? 'failed' : 'passed';
    }
    run.record.endedAt = this.host.now().toISOString();
    this.publish(run);
    return snapshot(run.record);
  }

  /**
   * Runs one block as one step of `run`: disabled check, settings, timeout, retries, error
   * handling, then passes the result on. `invoke` defaults to the block's `run`.
   */
  private async runStep(node: NodeDef, input: Payload, run: ActiveRun, invoke?: Invoke): Promise<void> {
    if (this.stopped || run.cancelled || this.isCancelled(run.record.id)) {
      run.cancelled = true;
      return;
    }
    if (run.steps >= this.maxSteps) {
      if (!run.budgetHit) {
        run.budgetHit = true;
        run.failed = true;
        run.record.error = `Stopped: this run went through more than ${this.maxSteps} blocks. Is there a loop?`;
        this.log('error', node.id, run.record.error);
      }
      return;
    }
    run.steps += 1;

    const def = this.registry.get(node.type);
    const step = this.beginStep(run, node, input);
    if (!def) {
      this.failStep(run, step, node, `Unknown block type "${node.type}"`);
      return;
    }
    const blockRun = def.run;
    const call: Invoke | undefined = invoke ?? (blockRun ? (ctx, data) => blockRun(ctx, data) : undefined);
    if (!call) {
      this.log('warn', node.id, `${def.label} cannot take input, so it was skipped`);
      this.endStep(run, step, 'skipped');
      return;
    }

    const settings = node.step ?? {};
    const ports = nodePorts(def, node);
    if (settings.disabled) {
      this.endStep(run, step, 'skipped', { output: input, port: ports[0] });
      await this.emitFrom(node.id, input, ports[0] ?? DEFAULT_PORT, run);
      return;
    }

    const outcome = await this.attempt(node, def, input, run, call, step);
    if (!outcome.ok) {
      await this.handleFailure(run, step, node, def, input, outcome.error, ports);
      return;
    }

    const { output } = outcome;
    if (!output) {
      this.endStep(run, step, 'passed');
      return;
    }
    const port = output instanceof Routed ? output.port : (ports[0] ?? DEFAULT_PORT);
    const payload = output instanceof Routed ? output.payload : output;
    if (!ports.includes(port)) {
      await this.handleFailure(run, step, node, def, input, `sent data to an output it does not have: "${port}"`, ports);
      return;
    }
    this.endStep(run, step, 'passed', { output: payload, port });
    await this.emitFrom(node.id, payload, port, run);
  }

  /** Resolves settings and calls the block, with timeout and retries. */
  private async attempt(
    node: NodeDef,
    def: AnyBlockDefinition,
    input: Payload,
    run: ActiveRun,
    call: Invoke,
    step: StepRecord,
  ): Promise<{ ok: true; output: RunOutput } | { ok: false; error: string }> {
    const resolved = resolveConfig(def, node.config, input);
    if (resolved.errors.length > 0) return { ok: false, error: resolved.errors.join('; ') };

    const settings = node.step ?? {};
    const retries = clamp(settings.retries ?? 0, 0, MAX_RETRIES);
    const timeoutSeconds = settings.timeoutSeconds && settings.timeoutSeconds > 0 ? settings.timeoutSeconds : DEFAULT_TIMEOUT_SECONDS;
    const ctx = this.makeContext(node, resolved.config, run);

    for (let attempt = 1; ; attempt += 1) {
      step.attempts = attempt;
      try {
        const output = await this.withTimeout(call(ctx, input), timeoutSeconds);
        return { ok: true, output };
      } catch (error) {
        const message = errorMessage(error);
        if (attempt > retries || run.cancelled || this.stopped || this.isCancelled(run.record.id)) {
          return { ok: false, error: message };
        }
        const waitMs = Math.min(1000 * 2 ** (attempt - 1), 10_000);
        this.log('warn', node.id, `${def.label}: ${message}. Retrying in ${waitMs / 1000}s (attempt ${attempt + 1} of ${retries + 1})`);
        this.publish(run);
        await this.host.sleep(waitMs);
      }
    }
  }

  private async handleFailure(
    run: ActiveRun,
    step: StepRecord,
    node: NodeDef,
    def: AnyBlockDefinition,
    input: Payload,
    error: string,
    ports: string[],
  ): Promise<void> {
    const message = `${def.label}: ${error}`;
    switch (node.step?.onError) {
      case 'continue': {
        this.log('warn', node.id, `${message} (continuing)`);
        const port = ports[0] ?? DEFAULT_PORT;
        this.endStep(run, step, 'handled', { error: message, output: input, port });
        await this.emitFrom(node.id, input, port, run);
        return;
      }
      case 'port': {
        this.log('warn', node.id, `${message} (sent to the error output)`);
        const payload = { ...input, error, errorBlock: def.label };
        this.endStep(run, step, 'handled', { error: message, output: payload, port: ERROR_PORT });
        await this.emitFrom(node.id, payload, ERROR_PORT, run);
        return;
      }
      default:
        this.failStep(run, step, node, message);
    }
  }

  private failStep(run: ActiveRun, step: StepRecord, node: NodeDef, message: string): void {
    this.log('error', node.id, message);
    run.failed = true;
    run.record.error ??= message;
    this.endStep(run, step, 'failed', { error: message });
  }

  /** Sends `payload` out of `port` of `nodeId`, to every block connected there. */
  private async emitFrom(nodeId: string, payload: Payload, port: string, run: ActiveRun): Promise<void> {
    if (this.stopped) return;
    const source = this.nodesById.get(nodeId);
    const ports = nodePorts(source ? this.registry.get(source.type) : undefined, source ?? {});
    for (const edge of this.workflow.edges) {
      if (edge.source !== nodeId || edgePort(edge, ports) !== port) continue;
      const target = this.nodesById.get(edge.target);
      if (!target) continue;
      // Each branch gets its own copy so one block cannot change another's input.
      await this.runStep(target, { ...payload }, run);
    }
  }

  private withTimeout<T>(promise: Promise<T>, seconds: number): Promise<T> {
    const timeout = this.host.sleep(seconds * 1000).then(() => {
      throw new Error(`Timed out after ${seconds}s`);
    });
    return Promise.race([promise, timeout]);
  }

  private beginStep(run: ActiveRun, node: NodeDef, input: Payload): StepRecord {
    const step: StepRecord = {
      nodeId: node.id,
      blockType: node.type,
      status: 'running',
      startedAt: this.host.now().toISOString(),
      attempts: 0,
      input: compactPayload(input),
    };
    if (run.record.steps.length < MAX_STEPS_KEPT) run.record.steps.push(step);
    else run.record.droppedSteps = (run.record.droppedSteps ?? 0) + 1;
    this.publish(run);
    return step;
  }

  private endStep(
    run: ActiveRun,
    step: StepRecord,
    status: StepRecord['status'],
    extra: { output?: Payload; port?: string; error?: string } = {},
  ): void {
    step.status = status;
    step.durationMs = this.host.now().getTime() - Date.parse(step.startedAt);
    if (extra.output) step.output = compactPayload(extra.output);
    if (extra.port) step.port = extra.port;
    if (extra.error) step.error = extra.error;
    this.publish(run);
  }

  private publish(run: ActiveRun): void {
    this.observer?.(snapshot(run.record));
  }

  // -------------------------------------------------------------------------

  private async guard(node: NodeDef, def: AnyBlockDefinition, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.log('error', node.id, `${def.label}: ${errorMessage(error)}`);
    }
  }

  /**
   * `run` is set for blocks running as a step. Start blocks (start / onTimer) have none: their
   * `emit` begins a new run, with `trigger` saying what started it.
   */
  private makeContext(node: NodeDef, config: object, run: ActiveRun | undefined, trigger: RunTrigger = 'start'): BlockContext<never> {
    const workflowId = this.workflow.id;
    const emit = async (payload: Payload, port: string = DEFAULT_PORT): Promise<void> => {
      if (run) {
        await this.emitFrom(node.id, payload, port, run);
        return;
      }
      await this.inRun(trigger, async (fresh) => {
        // The start block's firing is the run's first step, so the run shows what it sent.
        fresh.steps += 1;
        const step = this.beginStep(fresh, node, {});
        step.attempts = 1;
        this.endStep(fresh, step, 'passed', { output: payload, port });
        await this.emitFrom(node.id, payload, port, fresh);
      });
    };
    const ctx: BlockContext<object> = {
      workflowId,
      nodeId: node.id,
      config,
      isRoot: !this.hasIncoming.has(node.id),
      host: this.host,
      emit,
      log: (level, message) => this.log(level, node.id, message),
      timers: {
        set: (name, options, data) =>
          this.host.scheduler.set(makeTimerKey(workflowId, node.id, name), options, data),
        clear: (name) => this.host.scheduler.clear(makeTimerKey(workflowId, node.id, name)),
      },
      state: {
        get: async <T>(key: string) =>
          (await this.host.state.get(stateKey(workflowId, node.id, key))) as T | undefined,
        set: (key, value) => this.host.state.set(stateKey(workflowId, node.id, key), value),
      },
    };
    // Blocks are generic over their own config type; the registry erases it.
    return ctx as BlockContext<never>;
  }

  private log(level: LogLevel, nodeId: string | undefined, message: string): void {
    this.sink?.({
      ts: this.host.now().toISOString(),
      workflowId: this.workflow.id,
      ...(nodeId ? { nodeId } : {}),
      level,
      message,
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(Number.isFinite(value) ? value : min)));
}

function snapshot(record: RunRecord): RunRecord {
  return { ...record, steps: record.steps.map((step) => ({ ...step })) };
}
