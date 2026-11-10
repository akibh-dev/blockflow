import {
  BLOB_CHUNK_BYTES,
  BRIDGE_PROTOCOL_VERSION,
  INLINE_RESULT_BYTES,
  MAX_BRIDGE_LOG,
  RPC_ERRORS,
} from '../core/bridgeProtocol';
import type {
  BlobRef,
  BridgeLogEntry,
  BridgeMethod,
  BridgeNotificationName,
  BridgeNotifications,
  BridgeParams,
  BridgeResults,
  RpcError,
  RpcId,
  RpcResponse,
  Suite,
  SuiteInput,
  SuiteResult,
  WorkflowSource,
  WorkflowSummary,
} from '../core/bridgeProtocol';
import { hasErrors } from '../core/issues';
import { parseImport } from '../core/library';
import { toHtmlReport, toJsonReport, toJUnitXml } from '../core/report';
import type { RunRecord } from '../core/runs';
import type { Host, Workflow } from '../core/types';

/**
 * The bridge's methods (M4, `src/core/bridgeProtocol.ts`), written against injected dependencies so
 * they run in Node tests with a FakeHost. `src/browser/bridge.ts` owns the native port and the browser
 * side of each dependency; background.ts wires them. Nothing here touches `browser.*`.
 */

/** A JSON-RPC error thrown by a handler; `respond` turns it into an `RpcFailure`. */
export class BridgeRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: RpcError['data'],
  ) {
    super(message);
    this.name = 'BridgeRpcError';
  }
}

/** Options of `runWorkflow` (the background's, shared with suites). */
export interface RunWorkflowOptions {
  /** Overlay the stored secrets for this run only. Never stored. */
  secrets?: Record<string, string>;
  /** Workflows of an inline source that are not saved, so its Run Workflow blocks find each other. */
  workflows?: Workflow[];
  /** Every update of every run of this call (the run itself first, then any called workflows). */
  onRun?(run: RunRecord): void;
}

/** Progress of a suite, per finished workflow (agent 5's `runSuite`). */
export interface SuiteProgress {
  index: number;
  total: number;
  workflowName: string;
  status: string;
}

export type ReportFormat = 'json' | 'junit' | 'html';

/** `runSuite(input, deps)` from `src/browser/suites.ts` (M4 contract). */
export type RunSuite = (
  input: { suite: Suite | SuiteInput; secrets?: Record<string, string>; formats?: ReportFormat[] },
  deps: {
    loadWorkflows(): Promise<Workflow[]>;
    runWorkflow(workflow: Workflow, options: { secrets?: Record<string, string> }): Promise<RunRecord>;
    onProgress?(progress: SuiteProgress): void;
  },
) => Promise<{ result: SuiteResult; reports?: Partial<Record<ReportFormat, string>> }>;

/** Everything the handlers need from the browser. */
export interface BridgeHandlerDeps {
  /** "Allow outside control" (`bf:settings.outsideControl`). Every request is refused while it is off. */
  isEnabled(): boolean | Promise<boolean>;
  info(): { extensionVersion: string; browser: string; extensionId: string };
  loadWorkflows(): Promise<Workflow[]>;
  saveWorkflows(workflows: Workflow[]): Promise<void>;
  /** Names (not values) of the stored secrets, for validation warnings. */
  secretNames(): Promise<string[]>;
  loadRuns(): Promise<RunRecord[]>;
  /** Runs a workflow once (like the Run button) and resolves with its finished record. */
  runWorkflow(workflow: Workflow, options: RunWorkflowOptions): Promise<RunRecord>;
  /** The Stop button's path: ask a live run to stop. */
  cancelRun(runId: string): void;
  isRunLive(runId: string): boolean;
  snapshot(params: { url?: string; tabId?: number }): Promise<{ url: string; title: string; outline: string }>;
  /** A stored screenshot as a data URL, or undefined. */
  loadScreenshot(id: string): Promise<string | undefined>;
  loadSuites(): Promise<Suite[]>;
  runSuite: RunSuite;
  blockLabel(type: string): string;
  appendLog(entry: BridgeLogEntry): Promise<void> | void;
  /** Calls `fn` after `ms` (run timeouts). Returns a cancel function. */
  after(ms: number, fn: () => void): () => void;
  /** Milliseconds clock (blob expiry). Default `Date.now`. */
  now?(): number;
}

/** A request as the extension receives it from the native host. */
export interface IncomingRequest {
  id: RpcId;
  method: string;
  params?: unknown;
}

/** Sends one notification back through the port. */
export type Notify = <N extends BridgeNotificationName>(method: N, params: BridgeNotifications[N]) => void;

/** After a run's `timeoutSeconds`, how long to wait for it to stop before answering anyway. */
export const TIMEOUT_GRACE_MS = 15_000;
/** Result blobs are dropped this long after their last read (bridgeProtocol `blob.get`). */
export const BLOB_TTL_MS = 10 * 60_000;
/** At most this many blobs are kept; the least recently read go first. */
export const MAX_BLOBS = 20;
/** Runs in a report when neither `runIds` nor `limit` is given. */
export const DEFAULT_REPORT_LIMIT = 50;
const MAX_DETAIL = 160;

// ---------- small pure helpers (exported for tests) ----------

/** The log with `entry` appended, keeping the newest `max`. */
export function boundedLog(list: readonly BridgeLogEntry[], entry: BridgeLogEntry, max = MAX_BRIDGE_LOG): BridgeLogEntry[] {
  return [...list, entry].slice(-max);
}

/**
 * A Host for one bridge run: `secrets.all()` returns the stored secrets with `overlay.secrets` on top
 * (so `{{secret.x}}` and masking see them) and `workflows.get` finds the source's unsaved workflows.
 * Run-scoped hosts (`forRun`) get the same overlay. The base host and storage are never changed.
 */
export function withRunOverlay(host: Host, overlay: Pick<RunWorkflowOptions, 'secrets' | 'workflows'>): Host {
  const extra = overlay.secrets ?? {};
  const unsaved = overlay.workflows ?? [];
  if (Object.keys(extra).length === 0 && unsaved.length === 0) return host;
  const wrap = (base: Host): Host => {
    // Object.create keeps the base's prototype methods (class hosts) and `this`.
    const wrapped = Object.create(base) as Host;
    wrapped.secrets = { all: async () => ({ ...(await base.secrets.all()), ...extra }) };
    wrapped.workflows = { get: async (id) => unsaved.find((workflow) => workflow.id === id) ?? (await base.workflows.get(id)) };
    if (base.forRun) {
      const forRun = base.forRun.bind(base);
      wrapped.forRun = (runId) => wrap(forRun(runId));
    }
    return wrapped;
  };
  return wrap(host);
}

const encoder = new TextEncoder();

/** Standard base64 of bytes (btoa exists in workers, extension pages and Node ≥ 16). */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

interface StoredBlob {
  bytes: Uint8Array;
  mime?: string;
  readAt: number;
}

/** In-memory blobs for `blob.get` (results over INLINE_RESULT_BYTES, screenshots being read). */
export class BlobCache {
  private readonly blobs = new Map<string, StoredBlob>();
  private counter = 0;

  constructor(private readonly now: () => number) {}

  /** Drops expired blobs. */
  private sweep(): void {
    const now = this.now();
    for (const [id, blob] of this.blobs) if (now - blob.readAt > BLOB_TTL_MS) this.blobs.delete(id);
  }

  put(bytes: Uint8Array, mime?: string, id?: string): string {
    this.sweep();
    const blobId = id ?? `blob-${this.now().toString(36)}-${(this.counter += 1)}`;
    this.blobs.set(blobId, { bytes, readAt: this.now(), ...(mime ? { mime } : {}) });
    while (this.blobs.size > MAX_BLOBS) {
      const oldest = [...this.blobs.entries()].sort((a, b) => a[1].readAt - b[1].readAt)[0];
      if (!oldest) break;
      this.blobs.delete(oldest[0]);
    }
    return blobId;
  }

  get(blobId: string): StoredBlob | undefined {
    this.sweep();
    const blob = this.blobs.get(blobId);
    if (blob) blob.readAt = this.now();
    return blob;
  }

  get size(): number {
    return this.blobs.size;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): BridgeRpcError {
  return new BridgeRpcError(RPC_ERRORS.invalidParams, message);
}

function short(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL - 1)}…` : line;
}

function summary(workflow: Workflow): WorkflowSummary {
  return { id: workflow.id, name: workflow.name, enabled: workflow.enabled, ...(workflow.importedVia === 'bridge' ? { viaBridge: true } : {}) };
}

/** A source (JSON text or parsed) as JSON text for the importer. */
function sourceText(source: WorkflowSource): string {
  if (typeof source === 'string') return source;
  if (source === undefined || source === null) throw invalid('"source" is missing: send a script, a workflow file or one workflow.');
  return JSON.stringify(source);
}

function secretsParam(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || Object.values(value).some((secret) => typeof secret !== 'string')) throw invalid('"secrets" must be an object of name → text.');
  return value as Record<string, string>;
}

/** What a handler wants logged about its call (never secrets, never payloads). */
interface Outcome<T> {
  result: T;
  detail?: string;
}

// ---------- the handlers ----------

/**
 * Builds the method table. `respond(request, notify)` answers one request (never throws) and logs it;
 * `blobs` is exposed for tests.
 */
export function createBridgeHandlers(deps: BridgeHandlerDeps) {
  const now = deps.now ?? (() => Date.now());
  const blobs = new BlobCache(now);

  /** The result, or a `BlobRef` to it when its JSON is over INLINE_RESULT_BYTES. */
  function maybeBlob<T>(result: T): T | BlobRef {
    const bytes = encoder.encode(JSON.stringify(result));
    if (bytes.length <= INLINE_RESULT_BYTES) return result;
    return { blobId: blobs.put(bytes, 'application/json'), size: bytes.length };
  }

  async function parse(source: WorkflowSource, existing: Workflow[]) {
    return parseImport(sourceText(source), existing, { secrets: await deps.secretNames() });
  }

  /** A saved workflow by id, or the first workflow of an inline source (the others go along unsaved). */
  async function workflowToRun(params: BridgeParams['run']): Promise<{ workflow: Workflow; unsaved: Workflow[] }> {
    const saved = await deps.loadWorkflows();
    if (params.workflowId !== undefined) {
      if (typeof params.workflowId !== 'string') throw invalid('"workflowId" must be text.');
      const workflow = saved.find((candidate) => candidate.id === params.workflowId);
      if (!workflow) throw new BridgeRpcError(RPC_ERRORS.notFound, `No saved workflow has the id "${params.workflowId}".`);
      return { workflow, unsaved: [] };
    }
    if (params.source === undefined) throw invalid('Send "workflowId" or "source".');
    const parsed = await parse(params.source, saved);
    if (!parsed.ok) throw new BridgeRpcError(RPC_ERRORS.invalidWorkflow, parsed.error, { issues: parsed.issues });
    const [workflow, ...rest] = parsed.workflows;
    if (!workflow) throw new BridgeRpcError(RPC_ERRORS.invalidWorkflow, 'The source has no workflow.', { issues: parsed.issues });
    return { workflow, unsaved: rest };
  }

  /**
   * Runs one workflow, streaming `run.started` and `run.step` (once per step status change) for the
   * top-level run with `requestId`. With `timeoutSeconds`, the run is stopped then; it resolves with
   * the finished record (or, if the run does not stop within TIMEOUT_GRACE_MS, with its latest copy).
   */
  async function streamRun(
    workflow: Workflow,
    options: { secrets?: Record<string, string>; unsaved?: Workflow[]; timeoutSeconds?: number },
    requestId: RpcId,
    notify: Notify,
  ): Promise<RunRecord> {
    let runId: string | undefined;
    let latest: RunRecord | undefined;
    const sent = new Map<number, string>();
    let timedOut = false;
    const onRun = (run: RunRecord) => {
      if (runId === undefined) {
        runId = run.id;
        notify('run.started', { requestId, runId, workflowName: run.workflowName });
        if (timedOut) deps.cancelRun(runId);
      }
      if (run.id !== runId) return; // a workflow it called
      latest = run;
      run.steps.forEach((step, index) => {
        if (sent.get(index) === step.status) return;
        sent.set(index, step.status);
        notify('run.step', { requestId, runId: run.id, step });
      });
    };
    const done = deps.runWorkflow(workflow, {
      ...(options.secrets ? { secrets: options.secrets } : {}),
      ...(options.unsaved?.length ? { workflows: options.unsaved } : {}),
      onRun,
    });
    const seconds = options.timeoutSeconds;
    if (seconds === undefined) return done;

    let cancelTimer = () => {};
    const timeout = new Promise<'timeout'>((resolve) => {
      cancelTimer = deps.after(seconds * 1000, () => resolve('timeout'));
    });
    const first = await Promise.race([done, timeout]);
    cancelTimer();
    if (first !== 'timeout') return first;

    timedOut = true;
    if (runId !== undefined) deps.cancelRun(runId);
    let cancelGrace = () => {};
    const grace = new Promise<undefined>((resolve) => {
      cancelGrace = deps.after(TIMEOUT_GRACE_MS, () => resolve(undefined));
    });
    const stopped = await Promise.race([done, grace]);
    cancelGrace();
    const message = `Timed out after ${seconds} s (timeoutSeconds).`;
    if (stopped) return stopped.status === 'cancelled' ? { ...stopped, error: message } : stopped;
    // Still stuck in a long step: answer with what we have; the run ends by itself.
    const base: RunRecord = latest ?? { id: runId ?? '', workflowId: workflow.id, workflowName: workflow.name, trigger: 'manual', status: 'running', startedAt: new Date(now()).toISOString(), steps: [] };
    return { ...base, status: 'cancelled', endedAt: new Date(now()).toISOString(), error: `${message} The run is still stopping.` };
  }

  type Handler<M extends BridgeMethod> = (params: BridgeParams[M], requestId: RpcId, notify: Notify) => Promise<Outcome<BridgeResults[M]>>;

  const handlers: { [M in Exclude<BridgeMethod, 'auth'>]: Handler<M> } = {
    async hello(params) {
      if (params.protocol !== BRIDGE_PROTOCOL_VERSION) {
        throw new BridgeRpcError(RPC_ERRORS.version, `This BlockFlow speaks bridge protocol ${BRIDGE_PROTOCOL_VERSION}, the client ${String(params.protocol)}.`, { expected: BRIDGE_PROTOCOL_VERSION });
      }
      return { result: { protocol: BRIDGE_PROTOCOL_VERSION, ...deps.info() }, ...(typeof params.client === 'string' ? { detail: short(params.client) } : {}) };
    },

    async validate(params) {
      const parsed = await parse(params.source, await deps.loadWorkflows());
      if (!parsed.ok) return { result: { ok: false, issues: parsed.issues, workflows: [] }, detail: `invalid: ${short(parsed.error)}` };
      const ok = !hasErrors(parsed.issues);
      return {
        result: { ok, issues: parsed.issues, workflows: parsed.workflows.map((workflow) => ({ name: workflow.name, nodes: workflow.nodes.length })) },
        detail: `${parsed.workflows.length} workflow(s), ${parsed.issues.length} issue(s)`,
      };
    },

    async import(params) {
      const existing = await deps.loadWorkflows();
      const replace = params.replace === true;
      // Replacing: names are made unique against the user's own workflows only, then a bridge workflow
      // with the same name is replaced in place (keeping its id, so suites and history still point at it).
      const parsed = await parse(params.source, replace ? existing.filter((workflow) => workflow.importedVia !== 'bridge') : existing);
      if (!parsed.ok) throw new BridgeRpcError(RPC_ERRORS.invalidWorkflow, parsed.error, { issues: parsed.issues });
      const next = [...existing];
      const idChanges = new Map<string, string>();
      const imported = parsed.workflows.map((workflow): Workflow => ({ ...workflow, importedVia: 'bridge' }));
      const added: Workflow[] = [];
      for (const workflow of imported) {
        const index = replace ? next.findIndex((old) => old.importedVia === 'bridge' && old.name === workflow.name) : -1;
        const old = index >= 0 ? next[index] : undefined;
        if (old) {
          idChanges.set(workflow.id, old.id);
          workflow.id = old.id;
          next[index] = workflow;
        } else {
          next.push(workflow);
        }
        added.push(workflow);
      }
      // Run Workflow blocks of the file point at the ids the importer gave; follow the kept ones.
      if (idChanges.size > 0) {
        for (const workflow of added) {
          workflow.nodes = workflow.nodes.map((node) => {
            const called = node.config.workflow;
            return node.type === 'run-workflow' && typeof called === 'string' && idChanges.has(called) ? { ...node, config: { ...node.config, workflow: idChanges.get(called) } } : node;
          });
        }
      }
      await deps.saveWorkflows(next);
      return { result: { workflows: added.map(summary), issues: parsed.issues }, detail: short(added.map((workflow) => `"${workflow.name}"`).join(', ')) };
    },

    async list() {
      const workflows = await deps.loadWorkflows();
      return { result: { workflows: workflows.map(summary) }, detail: `${workflows.length} workflow(s)` };
    },

    async run(params, requestId, notify) {
      const secrets = secretsParam(params.secrets);
      const timeoutSeconds = params.timeoutSeconds;
      if (timeoutSeconds !== undefined && !(typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0)) {
        throw invalid('"timeoutSeconds" must be a number above 0.');
      }
      const { workflow, unsaved } = await workflowToRun(params);
      const run = await streamRun(workflow, { ...(secrets ? { secrets } : {}), unsaved, ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}) }, requestId, notify);
      return { result: maybeBlob({ run }), detail: short(`"${run.workflowName}" ${run.status} (run ${run.id})`) };
    },

    async report(params) {
      const format = params.format;
      if (format !== 'json' && format !== 'junit' && format !== 'html') throw invalid('"format" must be "json", "junit" or "html".');
      let runs = await deps.loadRuns();
      if (params.runIds !== undefined) {
        if (!Array.isArray(params.runIds)) throw invalid('"runIds" must be a list of run ids.');
        const wanted = new Set(params.runIds);
        runs = runs.filter((run) => wanted.has(run.id));
        const missing = params.runIds.filter((id) => !runs.some((run) => run.id === id));
        if (missing.length > 0) throw new BridgeRpcError(RPC_ERRORS.notFound, `No stored run has the id ${missing.map((id) => `"${id}"`).join(', ')}.`);
      }
      if (params.workflowId !== undefined) runs = runs.filter((run) => run.workflowId === params.workflowId);
      const limit = params.limit ?? (params.runIds ? undefined : DEFAULT_REPORT_LIMIT);
      if (limit !== undefined) {
        if (!(Number.isInteger(limit) && limit > 0)) throw invalid('"limit" must be a whole number above 0.');
        runs = runs.slice(-limit);
      }
      let content: string;
      if (format === 'json') content = JSON.stringify(toJsonReport(runs), null, 2);
      else if (format === 'junit') content = toJUnitXml(runs, { blockLabel: deps.blockLabel });
      else {
        const screenshots: Record<string, string> = {};
        for (const run of runs) {
          for (const step of run.steps) {
            if (!step.screenshot || screenshots[step.screenshot]) continue;
            const shot = await deps.loadScreenshot(step.screenshot).catch(() => undefined);
            if (shot) screenshots[step.screenshot] = shot;
          }
        }
        content = toHtmlReport(runs, { blockLabel: deps.blockLabel, screenshots });
      }
      return { result: maybeBlob({ format, content }), detail: `${format}, ${runs.length} run(s)` };
    },

    async snapshot(params) {
      if (params.url === undefined && params.tabId === undefined) throw invalid('Send "url" or "tabId".');
      if (params.url !== undefined && typeof params.url !== 'string') throw invalid('"url" must be text.');
      if (params.tabId !== undefined && !Number.isInteger(params.tabId)) throw invalid('"tabId" must be a tab id.');
      const result = await deps.snapshot({ ...(params.url !== undefined ? { url: params.url } : {}), ...(params.tabId !== undefined ? { tabId: params.tabId } : {}) });
      return { result: maybeBlob(result), detail: short(result.url) };
    },

    async stop(params) {
      if (typeof params.runId !== 'string') throw invalid('"runId" must be text.');
      if (deps.isRunLive(params.runId)) {
        deps.cancelRun(params.runId);
        return { result: { stopped: true }, detail: `run ${params.runId}` };
      }
      if ((await deps.loadRuns()).some((run) => run.id === params.runId)) return { result: { stopped: false }, detail: `run ${params.runId} already finished` };
      throw new BridgeRpcError(RPC_ERRORS.notFound, `No run has the id "${params.runId}".`);
    },

    async 'blob.get'(params) {
      if (typeof params.blobId !== 'string') throw invalid('"blobId" must be text.');
      const offset = params.offset ?? 0;
      if (!Number.isInteger(offset) || offset < 0) throw invalid('"offset" must be a whole number, 0 or more.');
      let blob = blobs.get(params.blobId);
      if (!blob && params.blobId.startsWith('screenshot:')) {
        const dataUrl = await deps.loadScreenshot(params.blobId.slice('screenshot:'.length)).catch(() => undefined);
        const match = dataUrl ? /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl) : null;
        if (match) {
          const [, mime, base64, body = ''] = match;
          const bytes = base64 ? fromBase64(body) : encoder.encode(decodeURIComponent(body));
          blobs.put(bytes, mime, params.blobId);
          blob = blobs.get(params.blobId);
        }
      }
      if (!blob) throw new BridgeRpcError(RPC_ERRORS.notFound, `No blob "${params.blobId}" (result blobs expire 10 minutes after their last read).`);
      const size = blob.bytes.length;
      if (offset > size) throw invalid(`"offset" ${offset} is past the end (${size} bytes).`);
      const end = Math.min(size, offset + BLOB_CHUNK_BYTES);
      return {
        result: { data: toBase64(blob.bytes.subarray(offset, end)), offset, size, done: end >= size, ...(blob.mime ? { mime: blob.mime } : {}) },
        detail: `${params.blobId} @${offset}`,
      };
    },

    async 'suite.list'() {
      const suites = await deps.loadSuites();
      return { result: { suites }, detail: `${suites.length} suite(s)` };
    },

    async 'suite.run'(params, requestId, notify) {
      const secrets = secretsParam(params.secrets);
      let suite: Suite | SuiteInput | undefined;
      if (params.suite !== undefined) {
        if (!isObject(params.suite)) throw invalid('"suite" must be a suite object.');
        suite = params.suite;
      } else if (params.suiteId !== undefined || params.name !== undefined) {
        const saved = await deps.loadSuites();
        suite = saved.find((candidate) => (params.suiteId !== undefined ? candidate.id === params.suiteId : candidate.name === params.name));
        if (!suite) throw new BridgeRpcError(RPC_ERRORS.notFound, `No saved suite ${params.suiteId !== undefined ? `has the id "${params.suiteId}"` : `is named "${String(params.name)}"`}.`);
      } else {
        throw invalid('Send "suiteId", "name" or "suite".');
      }
      const outcome = await deps.runSuite(
        { suite, ...(secrets ? { secrets } : {}), ...(params.formats ? { formats: params.formats } : {}) },
        {
          loadWorkflows: deps.loadWorkflows,
          runWorkflow: (workflow, options) => streamRun(workflow, { ...(options.secrets ? { secrets: options.secrets } : {}) }, requestId, notify),
          onProgress: (progress) => notify('suite.progress', { requestId, ...progress }),
        },
      );
      return { result: maybeBlob(outcome), detail: short(`"${outcome.result.name}" ${outcome.result.status} (${outcome.result.runs.length} run(s))`) };
    },
  };

  /** Answers one request: refused while outside control is off; logged either way (method, ok, detail). */
  async function respond(request: IncomingRequest, notify: Notify): Promise<RpcResponse> {
    const { id, method } = request;
    let detail: string | undefined;
    try {
      if (!(await deps.isEnabled())) throw new BridgeRpcError(RPC_ERRORS.disabled, 'Allow outside control is off in BlockFlow (Settings).');
      if (!Object.prototype.hasOwnProperty.call(handlers, method)) throw new BridgeRpcError(RPC_ERRORS.methodNotFound, `Unknown method "${method}".`);
      const params = request.params === undefined ? {} : request.params;
      if (!isObject(params)) throw invalid('"params" must be an object.');
      const handler = handlers[method as keyof typeof handlers] as Handler<Exclude<BridgeMethod, 'auth'>>;
      const outcome = await handler(params as never, id, notify);
      detail = outcome.detail;
      void Promise.resolve(deps.appendLog({ at: new Date(now()).toISOString(), method, ok: true, ...(detail ? { detail } : {}) })).catch(() => {});
      return { jsonrpc: '2.0', id, result: outcome.result } as RpcResponse;
    } catch (caught) {
      const error: RpcError =
        caught instanceof BridgeRpcError
          ? { code: caught.code, message: caught.message, ...(caught.data ? { data: caught.data } : {}) }
          : {
              // runSuite throws config.invalid for a suite that does not validate.
              code: codeOf(caught) === 'config.invalid' ? RPC_ERRORS.invalidWorkflow : RPC_ERRORS.internal,
              message: caught instanceof Error ? caught.message : String(caught),
              ...(codeOf(caught) ? { data: { code: codeOf(caught) } } : {}),
            };
      void Promise.resolve(deps.appendLog({ at: new Date(now()).toISOString(), method: short(String(method)), ok: false, detail: short(error.message) })).catch(() => {});
      return { jsonrpc: '2.0', id, error };
    }
  }

  return { respond, blobs };
}

/** A BlockFlow error code (`CodedError.code`) on a thrown value, if any. */
function codeOf(error: unknown): string | undefined {
  const code = isObject(error) ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

