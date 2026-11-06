import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { hasTemplate } from '../../../core/template';
import { isExtensionMessage } from '../../../shared/messages';
import type { SnapshotPageMessage } from '../../../shared/messages';
import { toast } from './Dialogs';

/**
 * "📸 Snapshot page" on Open Tab: asks the background for a snapshot of the block's URL (`bf:snapshot-page`,
 * the picker's tab is opened or reused) and copies the outline to the clipboard, to paste into a chat
 * with a model that writes the workflow. The answer arrives as `bf:snapshot-result`.
 */
export function SnapshotButton({ url }: { url: string }) {
  const [busy, setBusy] = useState(false);
  const waiting = useRef(false);

  useEffect(() => {
    const listener = (message: unknown) => {
      if (!isExtensionMessage(message) || message.type !== 'bf:snapshot-result' || !waiting.current) return;
      waiting.current = false;
      setBusy(false);
      if (message.error || message.text === undefined) {
        toast(message.error ?? 'The snapshot came back empty', 'error');
        return;
      }
      const lines = `${message.lines ?? 0} lines${message.truncated ? ', cut at the limit' : ''}`;
      navigator.clipboard.writeText(message.text).then(
        () => toast(`Page snapshot copied (${lines}). Paste it into your chat.`, 'success'),
        (error: unknown) => toast(`Snapshot taken (${lines}) but the clipboard refused it: ${error instanceof Error ? error.message : String(error)}. Click the editor and try again.`, 'error'),
      );
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  const start = () => {
    waiting.current = true;
    setBusy(true);
    const own = url.trim() && !hasTemplate(url) ? url.trim() : undefined;
    const message: SnapshotPageMessage = { type: 'bf:snapshot-page', ...(own ? { url: own } : {}) };
    void browser.runtime.sendMessage(message).catch(() => {
      waiting.current = false;
      setBusy(false);
      toast('Could not reach the background worker. Try reloading the extension.', 'error');
    });
  };

  return (
    <div className="bf-field">
      <button type="button" className="bf-snapshot" onClick={start} disabled={busy}>
        {busy ? '📸 Taking snapshot…' : '📸 Snapshot page'}
      </button>
      <small className="bf-muted">Copies an outline of the page (roles, names, a locator per element) to paste into a chat with a model.</small>
    </div>
  );
}
