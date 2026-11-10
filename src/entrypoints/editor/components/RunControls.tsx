import { useState } from 'react';
import type { RunOptions } from '../../../core/runs';

/** localStorage key (this editor only, a convenience): the "pause on error" checkbox. */
const PAUSE_ON_ERROR_KEY = 'bf-editor:pause-on-error';

function readPauseOnError(): boolean {
  try {
    return globalThis.localStorage?.getItem(PAUSE_ON_ERROR_KEY) === '1';
  } catch {
    return false;
  }
}

function writePauseOnError(value: boolean): void {
  try {
    globalThis.localStorage?.setItem(PAUSE_ON_ERROR_KEY, value ? '1' : '0');
  } catch {
    // private window or blocked storage: the box just is not remembered
  }
}

/**
 * M5 header controls: ▶ Run, Run with trace (M5.1, every step traced), 🐞 Debug (M5.2, pauses at
 * breakpoints, and on a failure when "pause on error" is ticked). `onRun` sends `bf:run-workflow` with
 * these options. Root mounts it in the header; the Stop button stays root's (shown while `running`).
 */
export function RunControls({
  onRun,
  running,
  disabled = false,
  disabledReason,
}: {
  onRun(options: RunOptions): void;
  running: boolean;
  /** No runnable workflow (problems, empty canvas). */
  disabled?: boolean;
  /** Shown as the tooltip while `disabled`. */
  disabledReason?: string;
}) {
  const [pauseOnError, setPauseOnError] = useState(readPauseOnError);
  const off = disabled || running;
  const why = (title: string) => (running ? 'A run is going on' : disabled ? (disabledReason ?? 'Nothing to run') : title);
  return (
    <span className="bf-run-controls">
      <button type="button" className="bf-run" disabled={off} onClick={() => onRun({})} title={why('Run the workflow once, now (it does not need to be On)')}>
        ▶ Run
      </button>
      <button type="button" disabled={off} onClick={() => onRun({ trace: true })} title={why('Run once and keep screenshots before and after every step (see Reports)')}>
        ◉ Run with trace
      </button>
      <button
        type="button"
        disabled={off}
        onClick={() => onRun({ debug: pauseOnError ? { pauseOnError: true } : {} })}
        title={why('Run once and pause before blocks marked “Pause here”, with Continue / Step / Stop')}
      >
        🐞 Debug
      </button>
      <label className="bf-inline" title="In a Debug run, also pause when a block fails, before the failure is handled">
        <input
          type="checkbox"
          checked={pauseOnError}
          onChange={(event) => {
            setPauseOnError(event.target.checked);
            writePauseOnError(event.target.checked);
          }}
        />
        <span>pause on error</span>
      </label>
    </span>
  );
}
