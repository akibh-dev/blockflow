import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { findComparison, getBaseline, baselineKey } from '../../../browser/visual';
import type { Comparison } from '../../../browser/visual';
import type { StepRecord } from '../../../core/runs';
import { formatRatio } from '../../../core/visual';
import { isExtensionMessage } from '../../../shared/messages';
import type { AcceptBaselineMessage } from '../../../shared/messages';
import { Screenshot } from './Screenshot';

const STATUS_TEXT: Record<Comparison['status'], string> = {
  'baseline-saved': 'No baseline yet: this screenshot became the baseline.',
  'baseline-updated': 'The baseline was replaced by this screenshot (Update the baseline is on).',
  match: 'Matches the baseline.',
  mismatch: 'Differs from the baseline.',
};

/** The current baseline picture of a (workflow, block), straight from IndexedDB. */
function CurrentBaseline({ workflowId, nodeId, version }: { workflowId: string; nodeId: string; version: number }) {
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void getBaseline(baselineKey(workflowId, nodeId))
      .then((baseline) => alive && setSrc(baseline?.dataUrl ?? null))
      .catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [workflowId, nodeId, version]);
  if (src === undefined) return <small className="bf-muted">Loading baseline…</small>;
  if (src === null) return <small className="bf-muted">No baseline stored.</small>;
  return (
    <a href={src} target="_blank" rel="noreferrer" title="Open full size" className="bf-shot">
      <img src={src} alt="Current baseline" />
    </a>
  );
}

/**
 * M5.3: baseline / actual / diff of a Screenshot step with "compare", the share of differing pixels, and
 * "Accept new baseline" (sends `bf:accept-baseline`). Renders nothing for other steps. Mounted in the
 * Reports page step details.
 */
export function VisualComparePanel({ step }: { step: StepRecord }) {
  const [comparison, setComparison] = useState<Comparison | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const relevant = step.blockType === 'screenshot' && (step.code === 'visual.mismatch' || (step.output as { visual?: unknown } | undefined)?.visual !== undefined);

  useEffect(() => {
    if (!relevant) return;
    let alive = true;
    void findComparison(step)
      .then((found) => alive && setComparison(found ?? null))
      .catch(() => alive && setComparison(null));
    return () => {
      alive = false;
    };
  }, [relevant, step.nodeId, step.startedAt, step.durationMs, version]);

  useEffect(() => {
    if (!comparison) return;
    const onMessage = (message: unknown) => {
      if (!isExtensionMessage(message) || message.type !== 'bf:baseline-accepted' || message.comparisonId !== comparison.id) return;
      setBusy(false);
      setError(message.error ?? '');
      setVersion((value) => value + 1);
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, [comparison]);

  if (!relevant) return null;
  if (comparison === undefined) return <small className="bf-muted">Loading visual comparison…</small>;
  if (comparison === null) return <small className="bf-muted">The visual comparison of this step is no longer kept.</small>;

  const accept = () => {
    setBusy(true);
    setError('');
    void browser.runtime.sendMessage({ type: 'bf:accept-baseline', comparisonId: comparison.id } satisfies AcceptBaselineMessage).catch((failure: unknown) => {
      setBusy(false);
      setError(failure instanceof Error ? failure.message : String(failure));
    });
  };
  const mismatch = comparison.status === 'mismatch';

  return (
    <div className={`bf-visual ${comparison.status}`} data-testid="visual-compare">
      <div className="bf-visual-head">
        <strong>Visual comparison</strong> <span className="bf-visual-status">{STATUS_TEXT[comparison.status]}</span>
        {comparison.status !== 'baseline-saved' && comparison.status !== 'baseline-updated' && (
          <span className="bf-muted">
            {' '}
            {comparison.baselineSize
              ? `Size ${comparison.width}×${comparison.height}, baseline ${comparison.baselineSize.width}×${comparison.baselineSize.height}.`
              : `${formatRatio(comparison.diffRatio)} of the pixels differ (${comparison.diffPixels}); allowed ${formatRatio(comparison.maxDiffRatio)}, colour threshold ${comparison.threshold}.`}
          </span>
        )}
      </div>
      <div className="bf-visual-images">
        <figure>
          <figcaption>Baseline{mismatch ? ' (as compared)' : ''}</figcaption>
          {comparison.baselineId ? <Screenshot id={comparison.baselineId} alt="Baseline" /> : <CurrentBaseline workflowId={comparison.workflowId} nodeId={comparison.nodeId} version={version} />}
        </figure>
        <figure>
          <figcaption>Actual</figcaption>
          <Screenshot id={comparison.actualId} alt="Actual" />
        </figure>
        {comparison.diffId && (
          <figure>
            <figcaption>Diff (red: differs, yellow: anti-aliasing, blue: masked)</figcaption>
            <Screenshot id={comparison.diffId} alt="Diff" />
          </figure>
        )}
      </div>
      <div className="bf-visual-actions">
        {comparison.acceptedAt ? (
          <span className="bf-ok">Accepted as the new baseline.</span>
        ) : (
          mismatch && (
            <button type="button" disabled={busy} onClick={accept}>
              {busy ? 'Accepting…' : 'Accept new baseline'}
            </button>
          )
        )}
        {error && <span className="bf-error">{error}</span>}
      </div>
    </div>
  );
}
