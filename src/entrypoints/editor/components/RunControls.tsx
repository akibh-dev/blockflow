import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
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
 * M5 header controls: ▶ Run, Run with trace (M5.1, every step traced), Debug (M5.2, pauses at
 * breakpoints, and on a failure when "pause on error" is ticked). Trace and Debug are icon buttons
 * (their names stay in the DOM for screen readers and tests); the ▾ menu repeats all three and holds
 * the "pause on error" box. `onRun` sends `bf:run-workflow` with
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);
  const off = disabled || running;
  const why = (title: string) => (running ? 'A run is going on' : disabled ? (disabledReason ?? 'Nothing to run') : title);
  const debug = () => onRun({ debug: pauseOnError ? { pauseOnError: true } : {} });

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menuOpen]);

  return (
    <span className="bf-run-controls">
      <span className="bf-split" ref={menuRef}>
        <button type="button" className="bf-run" disabled={off} onClick={() => onRun({})} title={why('Run the workflow once, now (it does not need to be On)')}>
          <Icon name="play" size={12} className="bf-fill" /> Run
        </button>
        <button
          type="button"
          className="bf-run bf-run-caret"
          aria-label="More ways to run"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="More ways to run"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Icon name="chevronDown" size={14} />
        </button>
        {menuOpen && (
          <span className="bf-menu-list bf-run-menu" role="menu">
            <button type="button" role="menuitem" disabled={off} onClick={() => { setMenuOpen(false); onRun({}); }}>
              <Icon name="play" /> Run once
            </button>
            <button type="button" role="menuitem" disabled={off} onClick={() => { setMenuOpen(false); onRun({ trace: true }); }}>
              <Icon name="record" /> Run and trace every step
            </button>
            <button type="button" role="menuitem" disabled={off} onClick={() => { setMenuOpen(false); debug(); }}>
              <Icon name="bug" /> Debug (stop at breakpoints)
            </button>
            <span className="bf-menu-sep" />
            <label className="bf-menu-check" title="In a Debug run, also pause when a block fails, before the failure is handled">
              <input
                type="checkbox"
                checked={pauseOnError}
                onChange={(event) => {
                  setPauseOnError(event.target.checked);
                  writePauseOnError(event.target.checked);
                }}
              />
              <span>pause on error (Debug runs)</span>
            </label>
          </span>
        )}
      </span>
      <button
        type="button"
        className="bf-tool bf-icon-button"
        disabled={off}
        onClick={() => onRun({ trace: true })}
        title={why('Run with trace: run once and keep screenshots before and after every step (see Reports)')}
      >
        <Icon name="record" />
        <span className="bf-sr-only">Run with trace</span>
      </button>
      <button
        type="button"
        className={`bf-tool bf-icon-button${pauseOnError ? ' bf-armed' : ''}`}
        disabled={off}
        onClick={debug}
        title={why(`Debug: run once and pause before blocks marked “Pause here”${pauseOnError ? ', and when a block fails' : ''}`)}
      >
        <Icon name="bug" />
        <span className="bf-sr-only">Debug</span>
      </button>
    </span>
  );
}
