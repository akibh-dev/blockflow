import { CodedError } from '../core/errors';

/** The small transport boundary keeps session lifetime testable without a browser. */
export interface DebuggerPort {
  available(): Promise<boolean>;
  attach(tabId: number): Promise<void>;
  detach(tabId: number): Promise<void>;
  send(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
export type CdpListener = (method: string, params?: object) => void;

interface Session {
  ready: Promise<void>;
  references: number;
  attached: boolean;
  invalidated: boolean;
  domains: Map<string, Promise<unknown>>;
  listeners: Set<CdpListener>;
}

interface Lease {
  send: CdpSend;
  release(): Promise<void>;
}

interface RunOwner {
  tabs: Map<number, Promise<Lease>>;
  used: boolean;
}

const ended = () => new CodedError('step.failed', 'The run has ended; its debugger session is closed.');
const detached = () => new CodedError('step.failed', 'The debugger was detached or the tab closed. Run the workflow again; do not close the debugging bar during a run.');

/**
 * One attachment per tab, shared by explicitly owned leases. A run retains its lease between
 * steps. Calls outside runs retain it only for their callback. Attach/detach are serialised per
 * tab, so a finishing action cannot detach a new action's connection. We never adopt an attachment
 * that belongs to DevTools or another extension: a failed attach remains a failure.
 */
export class DebuggerSessions {
  private readonly sessions = new Map<number, Session>();
  /** Includes a retiring attachment while its detach event is still in flight. */
  private readonly attachments = new Map<number, Session>();
  private readonly runs = new Map<string, RunOwner>();
  private readonly tails = new Map<number, Promise<void>>();

  constructor(private readonly port: DebuggerPort) {}

  startRun(runId: string): void {
    if (!runId || this.runs.has(runId)) throw new Error('A debugger run needs a new, non-empty id');
    this.runs.set(runId, { tabs: new Map(), used: false });
  }

  /** Close before awaiting anything: late/timed-out callbacks cannot attach or send more commands. */
  async finishRun(runId: string): Promise<{ usedDebugger?: boolean }> {
    const owner = this.runs.get(runId);
    if (!owner) return {};
    this.runs.delete(runId);
    const acquired = await Promise.allSettled(owner.tabs.values());
    const released = await Promise.allSettled(acquired.flatMap((result) => result.status === 'fulfilled' ? [result.value.release()] : []));
    const failure = released.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return owner.used ? { usedDebugger: true } : {};
  }

  async withSession<T>(tabId: number, fn: (send: CdpSend) => Promise<T>, runId?: string): Promise<T> {
    if (runId !== undefined) {
      const owner = this.runs.get(runId);
      if (!owner) throw ended();
      let pending = owner.tabs.get(tabId);
      if (!pending) {
        pending = this.acquire(tabId).then((lease) => {
          owner.used = true;
          return lease;
        });
        owner.tabs.set(tabId, pending);
        // A permission/attach failure must not poison a later retry in the same run.
        void pending.catch(() => { if (owner.tabs.get(tabId) === pending) owner.tabs.delete(tabId); });
      }
      const lease = await pending;
      if (this.runs.get(runId) !== owner) throw ended();
      return fn((method, params) => this.runs.get(runId) === owner ? lease.send(method, params) : Promise.reject(ended()));
    }
    const lease = await this.acquire(tabId);
    try {
      return await fn(lease.send);
    } finally {
      await lease.release();
    }
  }

  /** Called by the synchronous background listeners, including tabs.onRemoved. */
  detached(tabId: number): void {
    const session = this.attachments.get(tabId);
    if (!session) return;
    session.invalidated = true;
    session.attached = false;
    session.listeners.clear();
    this.attachments.delete(tabId);
    if (this.sessions.get(tabId) === session) this.sessions.delete(tabId);
  }

  /** Permission revocation makes all current connections unusable. */
  invalidateAll(): void {
    for (const tabId of this.attachments.keys()) this.detached(tabId);
  }

  /** Multiplex CDP events through one browser listener instead of registering one per operation. */
  event(tabId: number, method: string, params?: object): void {
    const session = this.sessions.get(tabId);
    if (!session || session.invalidated) return;
    for (const listener of session.listeners) listener(method, params);
  }

  subscribe(tabId: number, listener: CdpListener): () => void {
    const session = this.sessions.get(tabId);
    if (!session?.attached || session.invalidated) throw detached();
    session.listeners.add(listener);
    return () => { session.listeners.delete(listener); };
  }

  private serial(tabId: number, action: () => Promise<void>): Promise<void> {
    const pending = (this.tails.get(tabId) ?? Promise.resolve()).catch(() => {}).then(action);
    this.tails.set(tabId, pending);
    void pending.finally(() => { if (this.tails.get(tabId) === pending) this.tails.delete(tabId); }).catch(() => {});
    return pending;
  }

  private async acquire(tabId: number): Promise<Lease> {
    let session = this.sessions.get(tabId);
    if (!session) {
      const fresh: Session = { ready: Promise.resolve(), references: 0, attached: false, invalidated: false, domains: new Map(), listeners: new Set() };
      this.sessions.set(tabId, fresh);
      fresh.ready = this.serial(tabId, async () => {
        if (fresh.invalidated) throw detached();
        if (!(await this.port.available())) {
          throw new CodedError('permission.missing', 'This operation needs the "debugger" permission (Chromium only: Chrome, Edge, Brave). Grant it on the block or enable "Use real mouse and keyboard" in the step settings.');
        }
        if (fresh.invalidated) throw detached();
        this.attachments.set(tabId, fresh);
        try {
          await this.port.attach(tabId);
        } catch (error) {
          if (this.attachments.get(tabId) === fresh) this.attachments.delete(tabId);
          throw error;
        }
        fresh.attached = true;
      });
      session = fresh;
    }
    const entry = session;
    entry.references += 1;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      entry.references -= 1;
      if (entry.references !== 0) return;
      entry.invalidated = true;
      entry.listeners.clear();
      if (this.sessions.get(tabId) === entry) this.sessions.delete(tabId);
      if (entry.attached) {
        entry.attached = false;
        await this.serial(tabId, async () => {
          try {
            await this.port.detach(tabId);
          } finally {
            if (this.attachments.get(tabId) === entry) this.attachments.delete(tabId);
          }
        });
      }
    };
    try {
      await entry.ready;
      if (entry.invalidated) throw detached();
    } catch (error) {
      await release();
      throw error;
    }
    return {
      release,
      send: async (method, params) => {
        if (released || entry.invalidated) throw detached();
        // Default domain enable is idempotent and shared; custom options always go through.
        if (/^[A-Za-z]+\.enable$/.test(method) && Object.keys(params ?? {}).length === 0) {
          let enabled = entry.domains.get(method);
          if (!enabled) {
            enabled = this.port.send(tabId, method, params);
            entry.domains.set(method, enabled);
            void enabled.catch(() => { if (entry.domains.get(method) === enabled) entry.domains.delete(method); });
          }
          return enabled;
        }
        if (/^[A-Za-z]+\.disable$/.test(method)) entry.domains.delete(method.replace(/disable$/, 'enable'));
        return this.port.send(tabId, method, params);
      },
    };
  }
}
