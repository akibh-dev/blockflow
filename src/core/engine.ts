import { resolveConfig } from './config';
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
  Workflow,
} from './types';

/** Longest chain of blocks one payload may pass through. Stops accidental infinite loops. */
export const DEFAULT_MAX_DEPTH = 25;

export interface RunnerOptions {
  workflow: Workflow;
  registry: BlockRegistry;
  host: Host;
  log?: LogSink;
  maxDepth?: number;
}

/**
 * Runs one workflow.
 *
 * Model (same idea as n8n / node-RED):
 *  - Blocks are nodes, connections are edges. A block's output goes to every block it is
 *    connected to, and becomes that block's input.
 *  - Blocks with nothing connected to their input are "root" blocks. They start the flow
 *    when the workflow is enabled (`start()`).
 *  - Anything time-based goes through the host scheduler, never through setTimeout, so a
 *    freshly created runner (after the background worker slept) can pick the flow back up
 *    via `handleTimer()`.
 */
export class WorkflowRunner {
  private readonly workflow: Workflow;
  private readonly registry: BlockRegistry;
  private readonly host: Host;
  private readonly sink: LogSink | undefined;
  private readonly maxDepth: number;
  private readonly nodesById = new Map<string, NodeDef>();
  private readonly hasIncoming = new Set<string>();
  private stopped = false;

  constructor(options: RunnerOptions) {
    this.workflow = options.workflow;
    this.registry = options.registry;
    this.host = options.host;
    this.sink = options.log;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
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

  /** (Re)starts the workflow: clears old timers, then starts every root block. */
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
    const ctx = this.makeContext(node, resolved.config, 0);
    await this.guard(node, def, async () => {
      await def.onTimer?.(ctx, parsed.name, record.data);
    });
  }

  // -------------------------------------------------------------------------

  private async startRoot(node: NodeDef): Promise<void> {
    const def = this.registry.get(node.type);
    if (!def) {
      this.log('error', node.id, `Unknown block type "${node.type}"`);
      return;
    }
    const resolved = resolveConfig(def, node.config, {});
    if (resolved.errors.length > 0) {
      this.log('error', node.id, `${def.label}: ${resolved.errors.join('; ')}`);
      return;
    }
    const ctx = this.makeContext(node, resolved.config, 0);
    await this.guard(node, def, async () => {
      if (def.start) {
        await def.start(ctx);
      } else if (def.run) {
        const output = await def.run(ctx, {});
        if (output) await this.emitFrom(node.id, output, 0);
      }
    });
  }

  private async execute(node: NodeDef, input: Payload, depth: number): Promise<void> {
    const def = this.registry.get(node.type);
    if (!def) {
      this.log('error', node.id, `Unknown block type "${node.type}"`);
      return;
    }
    if (!def.run) {
      this.log('warn', node.id, `${def.label} cannot take input, so it was skipped`);
      return;
    }
    const resolved = resolveConfig(def, node.config, input);
    if (resolved.errors.length > 0) {
      this.log('error', node.id, `${def.label}: ${resolved.errors.join('; ')}`);
      return;
    }
    const ctx = this.makeContext(node, resolved.config, depth);
    await this.guard(node, def, async () => {
      const output = await def.run?.(ctx, input);
      if (output) await this.emitFrom(node.id, output, depth);
    });
  }

  /** Sends `payload` to every block connected to `nodeId`'s output. */
  private async emitFrom(nodeId: string, payload: Payload, depth: number): Promise<void> {
    if (this.stopped) return;
    const targets = this.workflow.edges.filter((edge) => edge.source === nodeId);
    if (targets.length === 0) return;
    if (depth >= this.maxDepth) {
      this.log(
        'error',
        nodeId,
        `Stopped: the flow passed through more than ${this.maxDepth} blocks in a row. Is there a loop?`,
      );
      return;
    }
    for (const edge of targets) {
      const target = this.nodesById.get(edge.target);
      if (!target) continue;
      // Each branch gets its own copy so one block cannot change another's input.
      await this.execute(target, { ...payload }, depth + 1);
    }
  }

  private async guard(node: NodeDef, def: AnyBlockDefinition, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log('error', node.id, `${def.label}: ${message}`);
    }
  }

  private makeContext(node: NodeDef, config: object, depth: number): BlockContext<never> {
    const workflowId = this.workflow.id;
    const ctx: BlockContext<object> = {
      workflowId,
      nodeId: node.id,
      config,
      isRoot: !this.hasIncoming.has(node.id),
      host: this.host,
      emit: (payload) => this.emitFrom(node.id, payload, depth),
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
