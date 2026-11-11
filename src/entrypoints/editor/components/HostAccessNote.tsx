import { describeNeed, needsAccess, requestAccess } from '../hostAccess';
import type { HostNeed } from '../hostAccess';

/**
 * Shown for the open workflow when the browser has not granted the sites it uses (the store build asks for
 * sites per workflow, not at install). The button is a click, as browsers require for the prompt.
 */
export function HostAccessNote({ need, onGranted }: { need: HostNeed; onGranted: () => void }) {
  if (!needsAccess(need)) return null;
  return (
    <div className="bf-problems bf-permission" role="status">
      <p>
        This workflow needs access to <strong>{describeNeed(need)}</strong>.{' '}
        <button
          type="button"
          onClick={() =>
            void requestAccess(need).then((granted) => {
              if (granted) onGranted();
            })
          }
        >
          Grant access
        </button>
      </p>
    </div>
  );
}
