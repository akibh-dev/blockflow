import { useEffect, useState } from 'react';
import { loadScreenshot } from '../../../browser/blobStore';
import type { StepRecord, StepTrace } from '../../../core/runs';
import { formatMs } from './ConfigPanel';

/**
 * M5.1 trace views for the Reports page: a filmstrip of a run's traced steps, and a step's before/after
 * pictures with the element's box drawn over the after image, its URL and network summary. Works for any
 * run with `step.trace` (traced runs and single steps with the `trace` setting).
 */

/** A stored screenshot's data URL: undefined while loading, null when it is no longer kept. */
function useShot(id: string | undefined): string | null | undefined {
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!id) {
      setSrc(null);
      return;
    }
    let alive = true;
    setSrc(undefined);
    void loadScreenshot(id)
      .then((shot) => alive && setSrc(shot?.dataUrl ?? null))
      .catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [id]);
  return src;
}

/** The box as percentages of the screenshot (it shows the viewport), or undefined when it cannot be placed. */
export function boxStyle(trace: Pick<StepTrace, 'box' | 'viewport'>, natural?: { width: number; height: number }) {
  const { box } = trace;
  // Without the viewport size, assume one image pixel per CSS pixel.
  const view = trace.viewport ?? natural;
  if (!box || !view || view.width <= 0 || view.height <= 0) return undefined;
  const pct = (value: number, of: number) => `${Math.max(0, Math.min(100, (value / of) * 100))}%`;
  return { left: pct(box.x, view.width), top: pct(box.y, view.height), width: pct(box.width, view.width), height: pct(box.height, view.height) };
}

/** One trace picture; `trace` given = draw its box over it. */
function TraceImage({ id, label, trace }: { id: string | undefined; label: string; trace?: StepTrace }) {
  const src = useShot(id);
  const [natural, setNatural] = useState<{ width: number; height: number } | undefined>(undefined);
  const style = trace ? boxStyle(trace, natural) : undefined;
  return (
    <figure className="bf-trace-shot">
      <figcaption className="bf-muted">{label}</figcaption>
      {src === undefined && id && <small className="bf-muted">Loading…</small>}
      {src === null && <small className="bf-muted">{id ? 'No longer kept.' : 'No picture (tab not showing, or none).'}</small>}
      {src && (
        <a href={src} target="_blank" rel="noreferrer" title="Open full size" className="bf-trace-frame">
          <img src={src} alt={label} onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
          {style && <span className="bf-trace-box" style={style} data-testid="trace-box" />}
        </a>
      )}
    </figure>
  );
}

/** Before / after of one traced step, URL and requests. */
export function StepTraceView({ trace }: { trace: StepTrace }) {
  const { network } = trace;
  return (
    <div className="bf-trace">
      <div className="bf-trace-pair">
        <TraceImage id={trace.before} label="Before" />
        <TraceImage id={trace.after} label="After" trace={trace} />
      </div>
      {trace.url && (
        <div className="bf-muted bf-trace-url" title={trace.url}>
          {trace.url}
        </div>
      )}
      {network && (
        <details className="bf-trace-network">
          <summary>
            Network: {network.requests} request{network.requests === 1 ? '' : 's'}
            {network.failed > 0 && <span className="bf-error"> · {network.failed} failed</span>}
          </summary>
          {network.slowest && network.slowest.length > 0 && (
            <ul>
              {network.slowest.map((request, index) => (
                // eslint-disable-next-line react/no-array-index-key
                <li key={index}>
                  {request.method} {request.status ?? '–'} · {formatMs(request.ms)} · <span className="bf-muted">{request.url}</span>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
    </div>
  );
}

/** A small picture in the filmstrip. */
function Frame({ id }: { id: string | undefined }) {
  const src = useShot(id);
  return src ? <img src={src} alt="" /> : <span className="bf-trace-frame-empty" />;
}

/** The run's traced steps as a strip of pictures (after, else before); a click selects that step. */
export function Filmstrip({ steps, selected, onSelect, label }: { steps: StepRecord[]; selected: number | null; onSelect(index: number): void; label(step: StepRecord): string }) {
  const traced = steps.map((step, index) => ({ step, index })).filter(({ step }) => step.trace);
  if (traced.length === 0) return null;
  return (
    <div className="bf-filmstrip" role="list" aria-label="Trace filmstrip">
      {traced.map(({ step, index }) => (
        <button
          type="button"
          role="listitem"
          key={index}
          className={`bf-filmstrip-frame ${step.status}${selected === index ? ' active' : ''}`}
          title={`${index + 1}. ${label(step)} (${step.status})`}
          onClick={() => onSelect(index)}
        >
          <Frame id={step.trace?.after ?? step.trace?.before} />
          <span>
            {index + 1}. {label(step)}
          </span>
        </button>
      ))}
    </div>
  );
}
