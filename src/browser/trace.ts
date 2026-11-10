import type { BoxResult } from '../core/page';
import type { StepTrace } from '../core/runs';
import type { Host, TraceStepInfo } from '../core/types';

/**
 * M5.1 `Host.trace`: what the page looked like around a traced step (run option `trace`, or the step setting
 * `trace`). `before`: a screenshot of the step's tab. `after`: a screenshot, the box of the step's element
 * (with the viewport size, to draw it over the image), the page URL, and a network summary when the run
 * already has a debugger session on that tab.
 *
 * Every part is optional and quiet: a part that cannot be had (no tab, a tab that is not showing in Chromium,
 * no debugger, a page the extension may not touch) is left out, and nothing here ever throws into the step.
 * The debugger is never attached for tracing: images of a background tab and network summaries are taken
 * only through a session the run already has.
 *
 * Browser access comes in through {@link TraceDeps} (wired by `forRun` in host.ts), so this is unit-tested
 * with fakes (tests/browser/trace.test.ts).
 */

/** How long one page-agent question of the trace may take (box, viewport). */
export const TRACE_AGENT_MS = 1_500;

export interface TraceDeps {
  runId: string;
  /** JPEG data URL of the tab, or null (see `captureForTrace` in screenshots.ts). `useDebugger`: the run has a session there. */
  shoot(tabId: number, useDebugger: boolean): Promise<string | null>;
  /** Stores a trace image (blobStore `saveTraceImage`); its id, or null over the per-run cap. */
  save(dataUrl: string): Promise<string | null>;
  /** Page agent request (`Host.page.act`). */
  act(tabId: number, request: { op: 'box'; locator: string } | { op: 'measure' }, timeoutMs: number): Promise<Record<string, unknown>>;
  /** The tab's URL, if it still exists. */
  url(tabId: number): Promise<string | undefined>;
  /** Run-scoped telemetry (m3Host.ts); absent outside runs. */
  telemetry?: {
    hasSession(tabId: number): boolean;
    beginStepNetwork(tabId: number, nodeId: string): Promise<boolean>;
    finishStepNetwork(tabId: number, nodeId: string): StepTrace['network'] | undefined;
  };
}

/** Runs `fn`, answering undefined instead of throwing. */
async function quiet<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function createTrace(deps: TraceDeps): NonNullable<Host['trace']> {
  const image = async (tabId: number): Promise<string | undefined> => {
    const dataUrl = await quiet(() => deps.shoot(tabId, deps.telemetry?.hasSession(tabId) ?? false));
    if (!dataUrl) return undefined;
    return (await quiet(() => deps.save(dataUrl))) ?? undefined;
  };

  return {
    async before(info: TraceStepInfo) {
      if (info.tabId === undefined) return undefined;
      const tabId = info.tabId;
      await quiet(async () => deps.telemetry?.beginStepNetwork(tabId, info.nodeId));
      const before = await image(tabId);
      return before ? { before } : undefined;
    },

    async after(info) {
      if (info.tabId === undefined) return undefined;
      const tabId = info.tabId;
      const trace: Omit<StepTrace, 'before'> = {};
      if (info.locator) {
        const box = (await quiet(() => deps.act(tabId, { op: 'box', locator: info.locator! }, TRACE_AGENT_MS))) as BoxResult | undefined;
        if (box?.found && finite(box.x) && finite(box.y) && box.width > 0 && box.height > 0) {
          trace.box = { x: box.x, y: box.y, width: box.width, height: box.height };
          const page = await quiet(() => deps.act(tabId, { op: 'measure' }, TRACE_AGENT_MS));
          if (page && finite(page.viewportWidth) && finite(page.viewportHeight) && page.viewportWidth > 0) {
            trace.viewport = { width: page.viewportWidth, height: page.viewportHeight };
          }
        }
      }
      const after = await image(tabId);
      if (after) trace.after = after;
      const url = await quiet(() => deps.url(tabId));
      if (url) trace.url = url;
      // The network window closes last: CDP events of requests the block started arrive a little after it
      // returned (the box, picture and URL take that long). The trace's own calls make no page requests.
      const network = deps.telemetry?.finishStepNetwork(tabId, info.nodeId);
      if (network) trace.network = network;
      return Object.keys(trace).length > 0 ? trace : undefined;
    },
  };
}
