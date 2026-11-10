import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { BRIDGE_STATUS_KEY } from '../../../browser/bridgeStatus';
import type { BridgeStatus } from '../../../browser/bridgeStatus';
import { BRIDGE_STORAGE_KEYS } from '../../../core/bridgeProtocol';
import type { BridgeLogEntry, BridgeSettings } from '../../../core/bridgeProtocol';
import { useStorageValue } from '../hooks';
import { requestPermission } from './PermissionNote';

const OFF: BridgeSettings = { outsideControl: false };
const NO_LOG: BridgeLogEntry[] = [];
/** Log lines shown (the worker keeps MAX_BRIDGE_LOG). */
const SHOWN_LOG = 50;

const STATE_TEXT: Record<BridgeStatus['state'], string> = {
  off: 'Off',
  connecting: 'Connecting to the BlockFlow bridge…',
  connected: 'Connected: local programs can use BlockFlow now',
  waiting: 'Not connected, retrying',
  failed: 'Not connected',
};

/** `bf:bridge-status` from storage.session (written by the worker), kept live. */
function useBridgeStatus(): BridgeStatus | undefined {
  const [status, setStatus] = useState<BridgeStatus | undefined>();
  useEffect(() => {
    let alive = true;
    void browser.storage.session
      .get(BRIDGE_STATUS_KEY)
      .then((stored) => {
        if (alive) setStatus(stored[BRIDGE_STATUS_KEY] as BridgeStatus | undefined);
      })
      .catch(() => {});
    const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'session' && changes[BRIDGE_STATUS_KEY]) setStatus(changes[BRIDGE_STATUS_KEY].newValue as BridgeStatus | undefined);
    };
    browser.storage.onChanged.addListener(listener);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(listener);
    };
  }, []);
  return status;
}

/**
 * Settings: "Allow outside control" (M4). While on, the worker keeps a native port to the BlockFlow
 * bridge open, so local programs (the MCP server, the `blockflow` CLI) can validate, import and run
 * workflows. Shows the connection, the install command for this browser and the bridge's request log.
 */
export function SettingsPage() {
  const [settings, saveSettings] = useStorageValue<BridgeSettings>(BRIDGE_STORAGE_KEYS.settings, OFF);
  const [log, saveLog] = useStorageValue<BridgeLogEntry[]>(BRIDGE_STORAGE_KEYS.log, NO_LOG);
  const status = useBridgeStatus();
  const [busy, setBusy] = useState(false);
  const firefox = import.meta.env.BROWSER === 'firefox';
  const extensionId = browser.runtime.id;
  const command = `npx blockflow-bridge install --extension-id ${extensionId}${firefox ? ' --browser firefox' : ''}`;
  const on = settings.outsideControl;
  const state = on ? (status?.state ?? 'connecting') : 'off';

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      // Asked on the click itself: browsers only show the permission prompt then.
      // Only when missing: a granted (or, in automation builds, required) permission needs no prompt.
      const granted = await browser.permissions.contains({ permissions: ['nativeMessaging'] }).catch(() => false);
      if (next && !granted && !(await requestPermission('nativeMessaging'))) return;
      await saveSettings({ ...settings, outsideControl: next });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bf-manage bf-settings">
      <div className="bf-manage-bar">
        <h2>Settings</h2>
      </div>

      <h3>Outside control</h3>
      <label className="bf-settings-switch">
        <input type="checkbox" checked={on} disabled={busy} aria-label="Allow outside control" onChange={(event) => void toggle(event.target.checked)} />{' '}
        <strong>Allow outside control</strong>
      </label>
      <p className="bf-muted">
        Lets programs on this computer that you installed (the BlockFlow bridge: an AI assistant through the MCP server, or
        the <code>blockflow</code> command line runner) list, check, import and run your workflows, read run reports and
        snapshot pages, while this is on. They can use your secrets in the runs they start, never read them. Off by default;
        switch it off again when you are done.
      </p>
      <p>
        Status: <span className={`bf-bridge-state ${state}`}>{STATE_TEXT[state]}</span>
        {on && status?.error && state !== 'connected' && <span className="bf-error"> · {status.error}</span>}
      </p>
      {on && state !== 'connected' && /not found|forbidden|exited/i.test(status?.error ?? '') && (
        <p className="bf-muted">The bridge is not installed for this browser, or not for this extension id. Run the command below, then wait a few seconds.</p>
      )}

      <h3>Install the bridge</h3>
      <p className="bf-muted">
        Once per browser, with Node.js 20 or newer. This browser’s BlockFlow id is <code>{extensionId}</code>.
      </p>
      <pre className="bf-settings-command">
        <code>{command}</code>
      </pre>
      <button type="button" onClick={() => void navigator.clipboard.writeText(command).catch(() => {})}>
        Copy command
      </button>

      <h3>Recent requests</h3>
      {log.length === 0 ? (
        <p className="bf-muted">No outside requests yet.</p>
      ) : (
        <>
          <table className="bf-table bf-bridge-log">
            <thead>
              <tr>
                <th>Time</th>
                <th>Request</th>
                <th>Result</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {log
                .slice(-SHOWN_LOG)
                .reverse()
                .map((entry, index) => (
                  <tr key={`${entry.at}-${index}`}>
                    <td className="bf-muted">{new Date(entry.at).toLocaleString()}</td>
                    <td>
                      <code>{entry.method}</code>
                    </td>
                    <td>
                      <span className={`bf-run-status ${entry.ok ? 'passed' : 'failed'}`}>{entry.ok ? 'ok' : 'error'}</span>
                    </td>
                    <td>{entry.detail ?? ''}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <button type="button" onClick={() => void saveLog([])}>
            Clear log
          </button>
        </>
      )}
    </section>
  );
}
