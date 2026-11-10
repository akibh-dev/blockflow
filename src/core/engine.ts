import { resolveConfig } from './config';
import { CodedError, errorDetails } from './errors';
import type { ErrorDetails } from './errors';
import type { EvalEnv } from './expression';
import { uid } from './id';
import { DEFAULT_PORT, ERROR_PORT, Routed, edgePort, nodePorts } from './ports';
import { MAX_STEPS_KEPT, compactPayload, maskPayload, maskText } from './runs';
import type { RunObserver, RunOptions, RunRecord, RunTrigger, StepRecord, StepTrace } from './runs';
import { sessionTab } from './session';
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
  TraceStepInfo,
  Workflow,
} from './types';
import { hasTemplate, render } from './template';

/** Most blocks one run may pass through. Stops accidental infinite loops. */
export const DEFAULT_MAX_STEPS = 1000;
/** A step that takes longer than this fails, unless its step settings say otherwise. */
export const DEFAULT_TIMEOUT_SECONDS = 60;
/** Upper bound for `StepSettings.retries`. */
export const MAX_RETRIES = 5;
/** Run Workflow inside Run Workflow inside…: stop at this depth (a workflow calling itself). */
export const MAX_CALL_DEPTH = 8;
const SCREENSHOT_TIMEOUT_MS = 8_000;

/** Everything a `WorkflowRunner` needs. The background builds a fresh runner per event. */
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
  /** How many Run Workflow calls deep this runner is (0 = top level). */
  callDepth?: number;
}

/** Book-keeping for one run while it is going. */
interface ActiveRun {
  record: RunRecord;
  host: Host;
  closed: boolean;
  steps: number;
  failed: boolean;
  cancelled: boolean;
  budgetHit: boolean;
  /** Secret values, for {{secret.name}} and for masking. */
  secrets: Record<string, string>;
  /** What the last block of the run produced (a called workflow's result). */
  lastOutput?: Payload;
  /** M5: trace / debug / run-from-here options of this run. */
  options?: RunOptions;
  /** M5.2: the user chose Step at the last pause, so the next step pauses too. */
  stepping?: boolean;
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
 *    timeout, retries, error handling, screenshots and secret masking applied here, not in blocks.
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
  private readonly callDepth: number;
  private readonly nodesById = new Map<string, NodeDef>();
  private readonly hasIncoming = new Set<string>();
  /** Expressions in settings read the host's clock (now(), today()). */
  private readonly evalEnv: EvalEnv = { now: () => this.host.now() };
  private stopped = false;
  /** Secret values seen by this runner, masked in every log line. */
  private secretValues: string[] = [];

  constructor(private readonly options: RunnerOptions) {
    this.workflow = options.workflow;
    this.registry = options.registry;
    this.host = options.host;
    this.sink = options.log;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.observer = options.onRun;
    this.isCancelled = options.isCancelled ?? (() => false);
    this.callDepth = options.callDepth ?? 0;
    for (const node of this.workflow.nodes) this.nodesById.set(node.id, node);
    for (const edge of this.workflow.edges) this.hasIncoming.add(edge.target);
  }

  /** Id of the workflow this runner runs. */
  get workflowId(): string {
    return this.workflow.id;
  }

  /** Blocks that nothing feeds. These start the flow. */
  rootNodes(): NodeDef[] {
    return this.workflow.nodes.filter((node) => !this.hasIncoming.has(node.id));
  }

  /**
   * (Re)starts the workflow in the background: clears old timers, then starts every root block.
   * `runPlainRoots` (default true): a root block with no trigger of its own (HTTP Request, Open Tab…)
   * runs once. Pass false when restarting after an edit or a browser start, so such workflows run
   * once when the user switches them on, not on every save or startup.
   */
  async start(options: { runPlainRoots?: boolean } = {}): Promise<void> {
    const runPlainRoots = options.runPlainRoots ?? true;
    this.stopped = false;
    await this.host.scheduler.clearPrefix(workflowTimerPrefix(this.workflow.id));

    const roots = this.rootNodes();
    if (roots.length === 0) {
      this.log('warn', undefined, 'Nothing to start: every block has an input.');
      return;
    }
    this.log('info', undefined, `Workflow "${this.workflow.name}" started`);
    for (const node of roots) await this.startRoot(node, runPlainRoots);
  }

  /** Stops the workflow: clears its timers and makes this runner ignore further timers and emits. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.host.scheduler.clearPrefix(workflowTimerPrefix(this.workflow.id));
    this.log('info', undefined, `Workflow "${this.workflow.name}" stopped`);
  }

  /**
   * Runs the workflow once, now (the Run button). Works whether or not the workflow is on, and
   * schedules nothing: a Timer start block fires once immediately instead of starting its schedule.
   */
  async runOnce(options: RunOptions = {}): Promise<RunRecord> {
    this.stopped = false;
    const { startAt } = options;
    return this.inRun('manual', (run) => (startAt ? this.runFrom(run, startAt.nodeId, startAt.input) : this.runRoots(run, {})), undefined, options);
  }

  /**
   * Runs the workflow as a function for a Run Workflow block: every start block receives `input`,
   * and the run's result is what its last block produced.
   */
  async runAsCall(input: Payload, parentRunId: string): Promise<{ record: RunRecord; output: Payload }> {
    this.stopped = false;
    let output: Payload = input;
    const record = await this.inRun(
      'call',
      async (run) => {
        await this.runRoots(run, input);
        output = run.lastOutput ?? input;
      },
      parentRunId,
    );
    return { record, output };
  }

  /**
   * An outside event for one start block (a page visit, a context-menu click): the block's
   * `run` decides what to send on, in a new run.
   */
  async handleEvent(nodeId: string, payload: Payload): Promise<RunRecord | undefined> {
    const node = this.nodesById.get(nodeId);
    if (!node) return undefined;
    this.stopped = false;
    return this.inRun('event', (run) => this.runStep(node, payload, run));
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

    const resolved = resolveConfig(def, node.config, {}, this.evalEnv);
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

  private async startRoot(node: NodeDef, runPlainRoots: boolean): Promise<void> {
    const def = this.registry.get(node.type);
    if (!def) {
      this.log('error', node.id, `Unknown block type "${node.type}"`);
      return;
    }
    if (!def.start) {
      // A plain block at the start (e.g. HTTP Request) runs once when the workflow is turned on.
      if (def.run && runPlainRoots) await this.inRun('start', (run) => this.runStep(node, {}, run));
      return;
    }
    const resolved = resolveConfig(def, node.config, {}, this.evalEnv);
    if (resolved.errors.length > 0) {
      this.log('error', node.id, `${def.label}: ${resolved.errors.join('; ')}`);
      return;
    }
    const ctx = this.makeContext(node, resolved.config, undefined, 'start');
    await this.guard(node, def, async () => {
      await def.start?.(ctx);
    });
  }

  /** M5.5 "Run from here": one block with a given input (an earlier run's input of that step), then on as usual. */
  private async runFrom(run: ActiveRun, nodeId: string, input: Payload): Promise<void> {
    const node = this.nodesById.get(nodeId);
    if (!node) {
      run.failed = true;
      run.record.error = `Run from here: the workflow has no block "${nodeId}" (was it deleted?)`;
      return;
    }
    await this.runStep(node, input, run);
  }

  /** Every start block once, with `input`: `trigger` for blocks that have one (Timer fires now). */
  private async runRoots(run: ActiveRun, input: Payload): Promise<void> {
    const roots = this.rootNodes();
    if (roots.length === 0) {
      run.failed = true;
      run.record.error = 'Nothing to start: every block has an input.';
      return;
    }
    for (const node of roots) {
      const trigger = this.registry.get(node.type)?.trigger;
      if (trigger) {
        await this.runStep(node, input, run, async (ctx) => {
          const sent = await trigger(ctx);
          return sent ? { ...input, ...sent } : sent;
        });
      } else {
        await this.runStep(node, input, run);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Runs and steps

  private async inRun(trigger: RunTrigger, body: (run: ActiveRun) => Promise<void>, parentRunId?: string, options?: RunOptions): Promise<RunRecord> {
    const mode = options && (options.trace || options.debug || options.startAt)
      ? { ...(options.trace ? { trace: true } : {}), ...(options.debug ? { debug: true } : {}), ...(options.startAt ? { startedAt: options.startAt.nodeId } : {}) }
      : undefined;
    const run: ActiveRun = {
      record: {
        id: uid(),
        workflowId: this.workflow.id,
        workflowName: this.workflow.name,
        trigger,
        status: 'running',
        startedAt: this.host.now().toISOString(),
        steps: [],
        ...(parentRunId ? { parentRunId } : {}),
        ...(mode ? { mode } : {}),
      },
      ...(options ? { options } : {}),
      steps: 0,
      host: this.host,
      closed: false,
      failed: false,
      cancelled: false,
      budgetHit: false,
      secrets: {},
    };
    this.publish(run);
    try {
      run.host = this.host.forRun?.(run.record.id) ?? this.host;
      run.secrets = await this.host.secrets.all();
      this.secretValues = Object.values(run.secrets).filter((value) => value.length >= 3);
      await body(run);
    } catch (error) {
      run.failed = true;
      run.record.error ??= this.mask(errorMessage(error));
    }
    run.closed = true;
    try {
      const resources = await run.host.finishRun?.(run.record.id);
      if (resources?.usedDebugger) run.record.usedDebugger = true;
    } catch (error) {
      run.failed = true;
      run.record.error ??= this.mask(`Run cleanup failed: ${errorMessage(error)}`);
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
   * handling, screenshots, then passes the result on. `invoke` defaults to the block's `run`.
   */
  private async runStep(node: NodeDef, input: Payload, run: ActiveRun, invoke?: Invoke): Promise<void> {
    // A branch still in flight when its run ended (after a timed-out loop, say) starts nothing new.
    if (run.closed || run.record.status !== 'running') return;
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
      await this.failStep(run, step, node, input, `Unknown block type "${node.type}"`, { code: 'config.invalid' });
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

    // M5.2: a debug run pauses at breakpoints, and before every step after the user chose Step.
    if (run.options?.debug && (run.stepping || settings.pause)) {
      if (!(await this.debugPause(run, node, input, run.stepping ? 'step' : 'breakpoint'))) {
        this.endStep(run, step, 'skipped', { error: 'Stopped' });
        return;
      }
    }
    // M5.1: screenshots around the step, the element's box, network summary.
    const traced = Boolean(run.options?.trace || settings.trace) && run.host.trace !== undefined;
    const traceInfo = traced ? this.traceInfo(run, node, input) : undefined;
    const before = traceInfo ? await this.quietly(node.id, 'Trace', () => run.host.trace!.before(traceInfo)) : undefined;

    const outcome = await this.attempt(node, def, input, run, call, step);
    if (traceInfo) {
      // A block that opened its tab (Open Tab) has it only in its output: trace the after picture there.
      if (traceInfo.tabId === undefined && outcome.ok && outcome.output) {
        const produced = outcome.output instanceof Routed ? outcome.output.payload : outcome.output;
        const tabId = this.stepTab(node, produced);
        if (tabId !== undefined) traceInfo.tabId = tabId;
      }
      const after = await this.quietly(node.id, 'Trace', () => run.host.trace!.after({ ...traceInfo, status: outcome.ok ? (outcome.softError ? 'failed' : 'passed') : 'failed', ...(before?.before ? { before: before.before } : {}) }));
      const trace: StepTrace = { ...(before?.before ? { before: before.before } : {}), ...(after ?? {}) };
      if (Object.keys(trace).length > 0) step.trace = trace;
    }
    // Stopped while the block was working (a long wait, say): nothing is passed on.
    if (this.stopped || run.cancelled || this.isCancelled(run.record.id)) {
      run.cancelled = true;
      this.endStep(run, step, 'skipped', { error: 'Stopped' });
      return;
    }
    if (!outcome.ok) {
      // M5.2 "pause on error": look at the page before the failure is handled.
      if (run.options?.debug?.pauseOnError && !(await this.debugPause(run, node, input, 'error', outcome.error))) {
        this.endStep(run, step, 'failed', { error: outcome.error, details: outcome.details });
        return;
      }
      await this.handleFailure(run, step, node, def, input, outcome.error, ports, outcome.details);
      return;
    }

    const { output } = outcome;
    const soft = outcome.softError ? { error: outcome.softError, details: outcome.softDetails } : {};
    if (!output) {
      this.endStep(run, step, outcome.softError ? 'failed' : 'passed', soft);
      await this.afterStep(run, step, node, input, Boolean(outcome.softError));
      return;
    }
    const port = output instanceof Routed ? output.port : (ports[0] ?? DEFAULT_PORT);
    const payload = output instanceof Routed ? output.payload : output;
    if (!ports.includes(port)) {
      await this.handleFailure(run, step, node, def, input, `sent data to an output it does not have: "${port}"`, ports, { code: 'step.failed' });
      return;
    }
    // A block that took a picture itself (Screenshot) shows it on its step.
    if (typeof payload.screenshotId === 'string' && payload.screenshotId !== input.screenshotId) step.screenshot = payload.screenshotId;
    this.endStep(run, step, outcome.softError ? 'failed' : 'passed', { output: payload, port, ...soft });
    await this.afterStep(run, step, node, payload, Boolean(outcome.softError));
    await this.emitFrom(node.id, payload, port, run);
  }

  /** M5.2: waits for Continue / Step / Stop from the debug channel. False = stop the run. */
  private async debugPause(run: ActiveRun, node: NodeDef, input: Payload, reason: 'breakpoint' | 'step' | 'error', error?: string): Promise<boolean> {
    const debug = run.host.debug;
    if (!debug) return true;
    const tabId = this.stepTab(node, input);
    const locator = typeof node.config.locator === 'string' && node.config.locator.trim() ? node.config.locator : undefined;
    let action: 'continue' | 'step' | 'stop';
    try {
      action = await debug.pause({
        runId: run.record.id,
        workflowId: this.workflow.id,
        nodeId: node.id,
        blockType: node.type,
        reason,
        input: compactPayload(maskPayload(input, this.secretValues)) ?? {},
        ...(error ? { error: this.mask(error) } : {}),
        ...(tabId !== undefined ? { tabId } : {}),
        ...(locator ? { locator } : {}),
      });
    } catch (failure) {
      this.log('warn', node.id, `Debugger: ${errorMessage(failure)}; continuing`);
      action = 'continue';
    }
    if (action === 'stop' || this.isCancelled(run.record.id)) {
      run.cancelled = true;
      return false;
    }
    run.stepping = action === 'step';
    return true;
  }

  /** M5.1: what the trace hooks need to know about a step. A templated locator is rendered with the step's input. */
  private traceInfo(run: ActiveRun, node: NodeDef, input: Payload): TraceStepInfo {
    const tabId = this.stepTab(node, input);
    const raw = typeof node.config.locator === 'string' ? node.config.locator.trim() : '';
    let locator: string | undefined = raw || undefined;
    if (raw && hasTemplate(raw)) {
      try {
        // Without secrets: the rendered locator leaves the engine (trace hooks).
        locator = render(raw, input, this.evalEnv).trim() || undefined;
      } catch {
        locator = undefined;
      }
    }
    return { runId: run.record.id, nodeId: node.id, blockType: node.type, ...(tabId !== undefined ? { tabId } : {}), ...(locator ? { locator } : {}) };
  }

  /** The tab a page step works on: its `tab` setting's session tab (default "main"). */
  private stepTab(node: NodeDef, input: Payload): number | undefined {
    const name = typeof node.config.tab === 'string' && node.config.tab.trim() ? node.config.tab : 'main';
    return sessionTab(input, name);
  }

  /** Runs an optional diagnostic hook; a failure is logged and never fails the step. */
  private async quietly<T>(nodeId: string, what: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      this.log('warn', nodeId, `${what}: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** Resolves settings and calls the block, with timeout and retries. */
  private async attempt(
    node: NodeDef,
    def: AnyBlockDefinition,
    input: Payload,
    run: ActiveRun,
    call: Invoke,
    step: StepRecord,
  ): Promise<{ ok: true; output: RunOutput; softError?: string; softDetails?: ErrorDetails } | { ok: false; error: string; details: ErrorDetails }> {
    // {{secret.name}} works in every templated setting, but secrets never enter the payload.
    const resolved = resolveConfig(def, node.config, Object.keys(run.secrets).length > 0 ? { ...input, secret: run.secrets } : input, this.evalEnv);
    if (resolved.errors.length > 0) return { ok: false, error: resolved.errors.join('; '), details: { code: 'config.invalid' } };

    const settings = node.step ?? {};
    const retries = clamp(settings.retries ?? 0, 0, MAX_RETRIES);
    const timeoutSeconds = stepTimeoutSeconds(node, def);

    for (let attempt = 1; ; attempt += 1) {
      step.attempts = attempt;
      const soft: { error: string; details?: ErrorDetails } = { error: '' };
      // Set when this attempt times out. A block call cannot be cancelled from outside, so the
      // abandoned call is fenced off instead: its emits, sub-workflow calls and soft failures are
      // refused, and its eventual result is ignored. Loops end at their next emit.
      const fence = { abandoned: false };
      const ctx = this.makeContext(
        node,
        resolved.config,
        run,
        'start',
        timeoutSeconds * 1000,
        (failure) => {
          if (fence.abandoned) return;
          const message = typeof failure === 'string' ? failure : failure.message;
          soft.error = soft.error ? `${soft.error}; ${message}` : message;
          // The first soft failure's details describe the step.
          soft.details ??= typeof failure === 'string' ? { code: 'step.failed' } : errorDetails(failure);
        },
        () => fence.abandoned,
      );
      try {
        const output = await this.withTimeout(call(ctx, input), timeoutSeconds, () => {
          fence.abandoned = true;
        });
        const softError = soft.error;
        if (softError) {
          run.failed = true;
          run.record.error ??= this.mask(`${def.label}: ${softError}`);
          this.log('error', node.id, `${def.label}: ${softError} (soft: continuing)`);
        }
        return softError ? { ok: true, output, softError: this.mask(softError), ...(soft.details ? { softDetails: soft.details } : {}) } : { ok: true, output };
      } catch (error) {
        const message = errorMessage(error);
        if (attempt > retries || run.cancelled || this.stopped || this.isCancelled(run.record.id)) {
          return { ok: false, error: message, details: errorDetails(error) };
        }
        const waitMs = Math.min(1000 * 2 ** (attempt - 1), 10_000);
        this.log('warn', node.id, `${def.label}: ${message}. Retrying in ${waitMs / 1000}s (attempt ${attempt + 1} of ${retries + 1})`);
        this.publish(run);
        await this.host.sleep(waitMs);
      }
    }
  }

  /** Applies the node's `onError` setting to a failed step: continue, send to the error port, or fail. */
  private async handleFailure(
    run: ActiveRun,
    step: StepRecord,
    node: NodeDef,
    def: AnyBlockDefinition,
    input: Payload,
    error: string,
    ports: string[],
    details: ErrorDetails,
  ): Promise<void> {
    const message = this.mask(`${def.label}: ${error}`);
    switch (node.step?.onError) {
      case 'continue': {
        this.log('warn', node.id, `${message} (continuing)`);
        const port = ports[0] ?? DEFAULT_PORT;
        this.endStep(run, step, 'handled', { error: message, details, output: input, port });
        await this.afterStep(run, step, node, input, true);
        await this.emitFrom(node.id, input, port, run);
        return;
      }
      case 'port': {
        this.log('warn', node.id, `${message} (sent to the error output)`);
        const payload = { ...input, error: this.mask(error), errorCode: details.code, errorBlock: def.label };
        this.endStep(run, step, 'handled', { error: message, details, output: payload, port: ERROR_PORT });
        await this.afterStep(run, step, node, input, true);
        await this.emitFrom(node.id, payload, ERROR_PORT, run);
        return;
      }
      default:
        await this.failStep(run, step, node, input, message, details);
    }
  }

  /** Marks the step and the run failed; this path ends here. */
  private async failStep(run: ActiveRun, step: StepRecord, node: NodeDef, input: Payload, message: string, details: ErrorDetails): Promise<void> {
    this.log('error', node.id, message);
    run.failed = true;
    run.record.error ??= this.mask(message);
    this.endStep(run, step, 'failed', { error: message, details });
    await this.afterStep(run, step, node, input, true);
  }

  /** Screenshot of the step's tab, by its step setting (default: only when something went wrong). */
  private async afterStep(run: ActiveRun, step: StepRecord, node: NodeDef, payload: Payload, wentWrong: boolean): Promise<void> {
    const when = node.step?.screenshot ?? 'error';
    if (when === 'never' || (when === 'error' && !wentWrong) || step.screenshot) return;
    const tabName = typeof node.config.tab === 'string' && node.config.tab.trim() ? node.config.tab : 'main';
    const tabId = sessionTab(payload, tabName);
    if (tabId === undefined) return;
    try {
      // A tab that is not rendering can make a capture hang: never let that hold up the run.
      const id = await Promise.race([run.host.screenshots.capture(tabId, run.record.id), this.host.sleep(SCREENSHOT_TIMEOUT_MS).then(() => null)]);
      if (id) {
        step.screenshot = id;
        this.publish(run);
      }
    } catch {
      // A screenshot must never change how the step went.
    }
  }

  /** Sends `payload` out of `port` of `nodeId`, to every block connected there. */
  private async emitFrom(nodeId: string, payload: Payload, port: string, run: ActiveRun): Promise<void> {
    if (this.stopped || run.closed) return;
    const source = this.nodesById.get(nodeId);
    const ports = nodePorts(source ? this.registry.get(source.type) : undefined, source ?? {});
    let sent = false;
    for (const edge of this.workflow.edges) {
      if (edge.source !== nodeId || edgePort(edge, ports) !== port) continue;
      const target = this.nodesById.get(edge.target);
      if (!target) continue;
      sent = true;
      // Each branch gets its own copy so one block cannot change another's input.
      await this.runStep(target, { ...payload }, run);
    }
    // The end of a path: remember it, so a called workflow can return it.
    if (!sent) run.lastOutput = payload;
  }

  /** Runs another saved workflow as a child run; throws (with `childRunId`) unless it passed. */
  private async callWorkflow(workflowId: string, input: Payload, run: ActiveRun): Promise<{ output: Payload; runId: string }> {
    if (this.callDepth + 1 >= MAX_CALL_DEPTH) {
      throw new Error(`Run Workflow is nested more than ${MAX_CALL_DEPTH} levels deep. Does a workflow call itself?`);
    }
    const workflow = await this.host.workflows.get(workflowId);
    if (!workflow) throw new Error('The workflow to run was deleted');
    const parentId = run.record.id;
    const child = new WorkflowRunner({
      ...this.options,
      workflow,
      callDepth: this.callDepth + 1,
      // Stopping the caller stops the called workflow too.
      isCancelled: (id) => this.isCancelled(id) || this.isCancelled(parentId) || run.cancelled,
    });
    const { record, output } = await child.runAsCall(input, parentId);
    if (record.status !== 'passed') {
      throw Object.assign(new CodedError('workflow.failed', `"${workflow.name}" ${record.status}: ${record.error ?? 'no reason given'}`), { childRunId: record.id });
    }
    return { output, runId: record.id };
  }

  /**
   * Races `promise` against `Host.sleep`. On timeout `onTimeout` runs (the caller fences off the
   * block call, which cannot be cancelled), and a later rejection of `promise` is swallowed.
   */
  private withTimeout<T>(promise: Promise<T>, seconds: number, onTimeout: () => void = () => {}): Promise<T> {
    let settled = false;
    const timeout = this.host.sleep(seconds * 1000).then(() => {
      if (settled) return new Promise<never>(() => {});
      onTimeout();
      throw new CodedError('timeout', `Timed out after ${seconds}s`);
    });
    const guarded = promise.finally(() => {
      settled = true;
    });
    guarded.catch(() => {});
    return Promise.race([guarded, timeout]);
  }

  /** Adds a running step record (masked, compacted input). Past `MAX_STEPS_KEPT` it is only counted. */
  private beginStep(run: ActiveRun, node: NodeDef, input: Payload): StepRecord {
    run.host.diagnostics?.beginStep(node.id);
    const step: StepRecord = {
      nodeId: node.id,
      blockType: node.type,
      status: 'running',
      startedAt: this.host.now().toISOString(),
      attempts: 0,
      input: compactPayload(maskPayload(input, this.secretValues)),
      // Maps the step back to the node id in the author's file (see NodeDef.origin).
      ...(node.origin ? { sourceId: node.origin } : {}),
    };
    if (run.record.steps.length < MAX_STEPS_KEPT) run.record.steps.push(step);
    else run.record.droppedSteps = (run.record.droppedSteps ?? 0) + 1;
    this.publish(run);
    return step;
  }

  /** Finishes a step record (status, duration, masked output/port/error and error details) and publishes the run. */
  private endStep(
    run: ActiveRun,
    step: StepRecord,
    status: StepRecord['status'],
    extra: { output?: Payload; port?: string; error?: string; details?: ErrorDetails } = {},
  ): void {
    step.status = status;
    const consoleEntries = run.host.diagnostics?.finishStep(step.nodeId);
    if (consoleEntries?.length) step.console = maskPayload(consoleEntries.slice(0, 100).map((entry) => ({ ...entry, text: entry.text.slice(0, 2000) })), this.secretValues);
    step.durationMs = this.host.now().getTime() - Date.parse(step.startedAt);
    if (extra.output) step.output = compactPayload(maskPayload(extra.output, this.secretValues));
    if (extra.port) step.port = extra.port;
    if (extra.error) {
      step.error = this.mask(extra.error);
      const details = extra.details ?? { code: 'step.failed' };
      step.code = details.code;
      if (details.locator) step.locator = this.mask(details.locator);
      if (details.url) step.url = this.mask(details.url);
      if (details.matches) step.matches = details.matches.map((match) => this.mask(match));
    }
    this.publish(run);
  }

  /** Sends a copy of the run record to `onRun`. */
  private publish(run: ActiveRun): void {
    this.observer?.(snapshot(run.record));
  }

  private mask(text: string): string {
    return maskText(text, this.secretValues);
  }

  // -------------------------------------------------------------------------

  /** Runs a start/onTimer hook outside any run: an error is logged, never thrown. */
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
  private makeContext(
    node: NodeDef,
    config: object,
    run: ActiveRun | undefined,
    trigger: RunTrigger = 'start',
    timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000,
    softFail: (failure: string | Error) => void = (failure) => this.log('error', node.id, typeof failure === 'string' ? failure : failure.message),
    abandoned: () => boolean = () => false,
  ): BlockContext<never> {
    const workflowId = this.workflow.id;
    const refuseIfAbandoned = (what: string): void => {
      if (!abandoned() && !run?.closed) return;
      const reason = run?.closed ? 'this run has ended' : 'this step already timed out';
      this.log('warn', node.id, `${what} ignored: ${reason}`);
      throw new Error(run?.closed && !abandoned() ? 'This run has ended' : 'This step already timed out');
    };
    const emit = async (payload: Payload, port: string = DEFAULT_PORT): Promise<Payload | undefined> => {
      refuseIfAbandoned('Output');
      if (run) {
        // What reaches the end of a path under this emit (steps run one after another, so the
        // run's lastOutput after it returns is that); the run keeps its earlier one otherwise.
        const before = run.lastOutput;
        run.lastOutput = undefined;
        await this.emitFrom(node.id, payload, port, run);
        const reached = run.lastOutput;
        if (reached === undefined) run.lastOutput = before;
        return reached;
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
      workflowName: this.workflow.name,
      nodeId: node.id,
      config,
      isRoot: !this.hasIncoming.has(node.id),
      timeoutMs,
      realInput: node.step?.realInput === true,
      runId: run?.record.id ?? '',
      aborted: () => abandoned() || this.stopped || (run ? run.closed || run.cancelled || this.isCancelled(run.record.id) : false),
      softFail,
      callWorkflow: async (id, input) => {
        if (!run) throw new Error('Run Workflow can only be used inside a run');
        refuseIfAbandoned('Run Workflow');
        const step = run.record.steps.findLast((candidate) => candidate.nodeId === node.id);
        try {
          const result = await this.callWorkflow(id, input, run);
          if (step) step.childRunId = result.runId;
          return result.output;
        } catch (error) {
          const childRunId = (error as { childRunId?: string }).childRunId;
          if (step && childRunId) step.childRunId = childRunId;
          throw error;
        }
      },
      host: run?.host ?? this.host,
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

  /** Writes a masked line to the log sink. */
  private log(level: LogLevel, nodeId: string | undefined, message: string): void {
    this.sink?.({
      ts: this.host.now().toISOString(),
      workflowId: this.workflow.id,
      ...(nodeId ? { nodeId } : {}),
      level,
      message: this.mask(message),
    });
  }
}

/** The step's own setting, else the block type's default, else DEFAULT_TIMEOUT_SECONDS. */
export function stepTimeoutSeconds(node: Pick<NodeDef, 'step'>, def: Pick<AnyBlockDefinition, 'timeoutSeconds'> | undefined): number {
  const own = node.step?.timeoutSeconds;
  if (own && own > 0) return own;
  return def?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
}

/** Message of a thrown value, whatever was thrown. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Integer within [min, max]; non-finite values become `min`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(Number.isFinite(value) ? value : min)));
}

/** Copy of a run record (and its steps) safe to hand to observers. */
function snapshot(record: RunRecord): RunRecord {
  return { ...record, steps: record.steps.map((step) => ({ ...step })) };
}
