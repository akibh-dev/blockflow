import { CodedError } from '../core/errors';
import { finishDebuggerRun, onDebuggerEvent, startDebuggerRun, withDebugger } from './cdp';
import { createEnvironment } from './environment';
import { createRoutes } from './routes';
import { createTelemetry } from './telemetry';
import type { Host } from '../core/types';
import type { M3Runtime } from './m3Runtime';

/** Mutable page-wide overrides cannot be safely installed by independent runs on the same tab. */
const claims = new Map<number, string>();

/** What M5.1 tracing (trace.ts) uses of the run's telemetry; not part of `Host`. */
export type TraceTelemetry = Pick<ReturnType<typeof createTelemetry>, 'hasSession' | 'beginStepNetwork' | 'finishStepNetwork'>;

/**
 * Build one feature set per run; all features use the same CDP session and exit path. `traceTelemetry`
 * is for host.ts to wire `Host.trace`; take it off before handing the Host to the engine.
 */
export function createRunHost(base: Host, runId: string): Host & { traceTelemetry: TraceTelemetry } {
  let closing = false;
  let finished: Promise<{ usedDebugger?: boolean }> | undefined;
  const assertOpen = () => { if (closing) throw new CodedError('step.failed', 'The run has ended; its browser resources are closed.'); };
  const runtime: M3Runtime = {
    runId,
    withTab: (tabId, fn) => {
      assertOpen();
      return withDebugger(tabId, fn, runId);
    },
    cleanupTab: (tabId, fn) => withDebugger(tabId, fn, runId),
    subscribe: onDebuggerEvent,
    isClosed: () => closing,
    claim: (tabId, feature) => {
      assertOpen();
      const owner = claims.get(tabId);
      if (owner && owner !== runId) throw new CodedError('config.invalid', `Another run owns network/emulation overrides for this tab. Finish that run before changing ${feature}.`);
      claims.set(tabId, runId);
    },
  };
  const telemetry = createTelemetry(runtime);
  const routes = createRoutes(runtime);
  const environment = createEnvironment(runtime);
  startDebuggerRun(runId, (tabId, send) => telemetry.attach(tabId, send));
  const finish = (): Promise<{ usedDebugger?: boolean }> => {
    if (finished) return finished;
    closing = true;
    finished = (async () => {
      let metadata: { usedDebugger?: boolean } = {};
      const cleanup = await Promise.allSettled([
        Promise.resolve().then(() => routes.finish()),
        Promise.resolve().then(() => environment.finish()),
        Promise.resolve().then(() => telemetry.finish()),
      ]);
      try {
        metadata = await finishDebuggerRun(runId);
      } finally {
        for (const [tabId, owner] of claims) if (owner === runId) claims.delete(tabId);
      }
      const failed = cleanup.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      return metadata;
    })();
    return finished;
  };
  return {
    ...base,
    finishRun: finish,
    diagnostics: { beginStep: (nodeId) => telemetry.beginStep(nodeId), finishStep: (nodeId) => telemetry.finishStep(nodeId) },
    traceTelemetry: {
      hasSession: (tabId) => telemetry.hasSession(tabId),
      beginStepNetwork: (tabId, nodeId) => telemetry.beginStepNetwork(tabId, nodeId),
      finishStepNetwork: (tabId, nodeId) => telemetry.finishStepNetwork(tabId, nodeId),
    },
    network: {
      route: (tabId, options) => { assertOpen(); return routes.apply(tabId, options); },
      har: (tabId, action) => { assertOpen(); return telemetry.har(tabId, action); },
      console: (tabId) => { assertOpen(); return telemetry.console(tabId); },
    },
    environment: {
      emulate: (tabId, options) => { assertOpen(); return environment.emulate(tabId, options); },
      clearSiteData: (options) => { assertOpen(); return environment.clearSiteData(options); },
    },
  };
}
