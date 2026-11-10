import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { DEBUG_PAUSE_KEY } from '../../../browser/debugChannel';
import type { DebugAction, PausedRun } from '../../../browser/debugChannel';
import type { DebugAnswerMessage } from '../../../shared/messages';
import { registry } from '../registry';

const REASONS: Record<PausedRun['reason'], string> = {
  breakpoint: 'at a breakpoint',
  step: 'after Step',
  error: 'on an error, before it is handled',
};

/**
 * M5.2: debug runs paused at a breakpoint (storage.session `bf:debug-pause`, written by
 * src/browser/debugChannel.ts), with Continue / Step / Stop. The pause is read from storage, so an
 * editor opened after the run paused shows it too. No props: root mounts it next to `PromptBanner`.
 */
export function DebugBanner() {
  const pauses = useDebugPauses();
  return <DebugBannerView pauses={pauses} answer={sendAnswer} />;
}

function sendAnswer(runId: string, action: DebugAction): void {
  const message: DebugAnswerMessage = { type: 'bf:debug-answer', runId, action };
  void browser.runtime.sendMessage(message).catch(() => {});
}

/** `bf:debug-pause` from storage.session, live. */
export function useDebugPauses(): PausedRun[] {
  const [pauses, setPauses] = useState<PausedRun[]>([]);
  useEffect(() => {
    let alive = true;
    const session = browser.storage.session;
    if (!session) return undefined; // very old browsers: no storage.session, no debugger banner
    void session
      .get(DEBUG_PAUSE_KEY)
      .then((stored) => {
        const list = stored[DEBUG_PAUSE_KEY];
        if (alive) setPauses(Array.isArray(list) ? (list as PausedRun[]) : []);
      })
      .catch(() => {});
    const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'session' || !changes[DEBUG_PAUSE_KEY]) return;
      const list = changes[DEBUG_PAUSE_KEY].newValue;
      setPauses(Array.isArray(list) ? (list as PausedRun[]) : []);
    };
    browser.storage.onChanged.addListener(listener);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(listener);
    };
  }, []);
  return pauses;
}

/** The banner itself (exported for tests): one row per paused run. */
export function DebugBannerView({ pauses, answer }: { pauses: PausedRun[]; answer(runId: string, action: DebugAction): void }) {
  // Several clicks before the pause disappears from storage would answer twice; the channel ignores those.
  if (pauses.length === 0) return null;
  return (
    <div className="bf-debug-pauses" role="alert">
      {pauses.map((pause) => {
        const label = registry.get(pause.blockType)?.label ?? pause.blockType;
        return (
          <div key={pause.runId} className={`bf-debug-pause ${pause.reason}`} data-run-id={pause.runId}>
            <div className="bf-debug-head">
              <span>
                ⏸ {pause.workflowName ? <strong>{pause.workflowName}</strong> : 'A debug run'} paused before <strong>{label}</strong>{' '}
                <code title="Block id">{pause.nodeId}</code> {REASONS[pause.reason]}
              </span>
              <button type="button" className="bf-run" onClick={() => answer(pause.runId, 'continue')} title="Run on to the next breakpoint">
                ▶ Continue
              </button>
              <button type="button" onClick={() => answer(pause.runId, 'step')} title="Run this block, then pause before the next one">
                ⤼ Step
              </button>
              <button type="button" className="bf-danger" onClick={() => answer(pause.runId, 'stop')} title="End the run here">
                ■ Stop
              </button>
            </div>
            {pause.error && <p className="bf-error">{pause.error}</p>}
            {pause.locator && (
              <small className="bf-muted">
                Element: <code>{pause.locator}</code>
                {pause.tabId !== undefined ? ' (outlined on the page)' : ''}
              </small>
            )}
            <details className="bf-debug-input">
              <summary>Input of this step</summary>
              <pre className="bf-json">{JSON.stringify(pause.input, null, 2)}</pre>
            </details>
          </div>
        );
      })}
    </div>
  );
}
