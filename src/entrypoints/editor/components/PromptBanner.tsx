import { browser } from 'wxt/browser';
import type { PendingPrompt } from '../../../browser/prompts';

/** Manual Steps waiting for the user, shown on top of everything. */
export function PromptBanner({ prompts }: { prompts: PendingPrompt[] }) {
  if (prompts.length === 0) return null;
  const answer = (runId: string, ok: boolean) => void browser.runtime.sendMessage({ type: 'bf:answer-prompt', runId, ok });
  return (
    <div className="bf-prompts" role="alert">
      {prompts.map((prompt) => (
        <div key={prompt.runId} className="bf-prompt">
          <span>
            ✋ <strong>{prompt.workflowName}</strong> is waiting for you: {prompt.message}
          </span>
          <button type="button" className="bf-run" onClick={() => answer(prompt.runId, true)}>
            Continue
          </button>
          <button type="button" className="bf-danger" onClick={() => answer(prompt.runId, false)}>
            Fail the run
          </button>
        </div>
      ))}
    </div>
  );
}
