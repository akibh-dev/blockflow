import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '../../../shared/keys';
import { templates } from '../templates';

/** Where `npm run playground` serves docs/manual-test (scripts/playground.mjs). */
export const PLAYGROUND_URL = 'http://localhost:7357/playground.html';
/** The template the card creates (docs/guide/examples/playground-tour.blockflow.json). */
const TEMPLATE_ID = 'playground-tour';

/** What `bf:onboarding` holds. */
export interface OnboardingState {
  /** The "Try it" card was closed; it does not come back. */
  tryItDismissed?: boolean;
}

type Reachable = 'checking' | 'up' | 'down';

/**
 * First-run "Try it" card on the canvas: start the playground page, create a ready workflow that
 * fills and clicks it, press Run. Shown until dismissed (remembered in `bf:onboarding`).
 *
 * The playground is served over http by `npm run playground`, not shipped inside the extension:
 * Chromium does not let an extension script its own chrome-extension:// pages (see scripts/playground.mjs).
 */
export function TryItCard({ onCreate }: { onCreate(templateText: string): void }) {
  // undefined while loading, so the card does not flash for people who closed it.
  const [state, setState] = useState<OnboardingState | undefined>();
  const [reachable, setReachable] = useState<Reachable>('checking');
  const [created, setCreated] = useState(false);

  useEffect(() => {
    let alive = true;
    void browser.storage.local.get(STORAGE_KEYS.onboarding).then((stored) => {
      if (alive) setState((stored[STORAGE_KEYS.onboarding] as OnboardingState | undefined) ?? {});
    });
    return () => {
      alive = false;
    };
  }, []);

  const check = useCallback(() => {
    setReachable('checking');
    // Extension pages may fetch any host they have permission for; a network error means it is not running.
    void fetch(PLAYGROUND_URL, { cache: 'no-store' }).then(
      (response) => setReachable(response.ok ? 'up' : 'down'),
      () => setReachable('down'),
    );
  }, []);

  const visible = state !== undefined && !state.tryItDismissed;
  useEffect(() => {
    if (visible) check();
  }, [visible, check]);

  if (!visible) return null;
  const template = templates.find((candidate) => candidate.id === TEMPLATE_ID);

  const dismiss = () => {
    const next = { ...state, tryItDismissed: true };
    setState(next);
    void browser.storage.local.set({ [STORAGE_KEYS.onboarding]: next });
  };

  return (
    <aside className="bf-tryit" aria-label="Try it">
      <button type="button" className="bf-tryit-close" aria-label="Close the Try it card" title="Close (it will not come back)" onClick={dismiss}>
        ×
      </button>
      <h3>Try BlockFlow in a minute</h3>
      <ol>
        <li>
          Start the practice page: run <code>npm run playground</code> in the BlockFlow folder.{' '}
          <span className={`bf-tryit-status ${reachable}`}>
            {reachable === 'up' ? '● running' : reachable === 'down' ? '○ not running yet' : '… checking'}
          </span>{' '}
          {reachable === 'down' && (
            <button type="button" className="bf-link" onClick={check}>
              Check again
            </button>
          )}
          {reachable === 'up' && (
            <button type="button" className="bf-link" onClick={() => void browser.tabs.create({ url: PLAYGROUND_URL })}>
              Open it
            </button>
          )}
        </li>
        <li>
          <button
            type="button"
            className="bf-run"
            disabled={!template}
            onClick={() => {
              if (!template) return;
              onCreate(template.text);
              setCreated(true);
            }}
          >
            Create the Try-it workflow
          </button>
        </li>
        <li>{created ? <strong>Now press ▶ Run</strong> : 'Press ▶ Run'} and watch it fill in the form, click and check the greeting.</li>
      </ol>
      <p className="bf-muted">Then change a block (another name, another colour) and run it again.</p>
    </aside>
  );
}
