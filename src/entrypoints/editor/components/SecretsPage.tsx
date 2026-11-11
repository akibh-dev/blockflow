import { useCallback, useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '../../../shared/keys';
import {
  decryptAll,
  encryptAll,
  fromBase64,
  isEncrypted,
  removeSecret,
  secretNames,
  setSecret,
  toBase64,
  unlock as vaultUnlock,
  type EncryptedSecrets,
  type StoredSecrets,
} from '../../../browser/secretVault';
import { confirmDialog } from './Dialogs';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MIN_PASSPHRASE = 8;

type VaultState = 'plain' | 'locked' | 'unlocked';

/** Named secrets: used as {{secret.name}}, masked everywhere, never exported with workflows. */
export function SecretsPage() {
  /** The raw `bf:secrets` value: a plain map (v1) or an EncryptedSecrets (v2). */
  const [stored, setStored] = useState<StoredSecrets | undefined>(undefined);
  /** The base64 session key that decrypts an encrypted store; undefined when locked. */
  const [sessionKey, setSessionKey] = useState<string | undefined>(undefined);
  /** The editable secret values: the plain map when plain, the decrypted values when unlocked. */
  const [plain, setPlain] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  /** Passphrase inputs for protect / change-passphrase / unlock. */
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');
  /** Which value inputs are shown as plain text. */
  const [shown, setShown] = useState<Set<string>>(new Set());
  /** Inline error (wrong passphrase, validation). */
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [showChange, setShowChange] = useState(false);

  const state: VaultState = useMemo(() => {
    if (!stored || !isEncrypted(stored)) return 'plain';
    return sessionKey ? 'unlocked' : 'locked';
  }, [stored, sessionKey]);

  const names = secretNames(stored);
  const hasSecrets = names.length > 0;
  const canEdit = state === 'plain' || state === 'unlocked';

  /** Re-derive the editable values whenever the store or session key changes. */
  useEffect(() => {
    (async () => {
      if (state === 'plain') {
        setPlain(typeof stored === 'object' && stored !== null && !isEncrypted(stored) ? { ...stored } : {});
      } else if (state === 'unlocked' && sessionKey) {
        try {
          setPlain(await decryptAll(stored as EncryptedSecrets, fromBase64(sessionKey)));
        } catch {
          setPlain({});
        }
      } else {
        setPlain({});
      }
    })();
  }, [state, stored, sessionKey]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [local, session] = await Promise.all([
        browser.storage.local.get(STORAGE_KEYS.secrets),
        browser.storage.session.get(STORAGE_KEYS.secretsKey),
      ]);
      if (!alive) return;
      setStored(local[STORAGE_KEYS.secrets] as StoredSecrets | undefined);
      setSessionKey(session[STORAGE_KEYS.secretsKey] as string | undefined);
    };
    load();
    const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'local' && changes[STORAGE_KEYS.secrets]) {
        setStored(changes[STORAGE_KEYS.secrets].newValue as StoredSecrets | undefined);
      }
      if (area === 'session' && changes[STORAGE_KEYS.secretsKey]) {
        setSessionKey(changes[STORAGE_KEYS.secretsKey].newValue as string | undefined);
      }
    };
    browser.storage.onChanged.addListener(listener);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(listener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Persist a plain (unencrypted) store. */
  const savePlain = useCallback(
    async (next: Record<string, string>) => {
      setPlain(next);
      await browser.storage.local.set({ [STORAGE_KEYS.secrets]: next });
    },
    [],
  );

  /** Persist an encrypted store. */
  const saveEncrypted = useCallback(
    async (next: EncryptedSecrets) => {
      setStored(next);
      await browser.storage.local.set({ [STORAGE_KEYS.secrets]: next });
    },
    [],
  );

  const keyBytes = useMemo(() => (sessionKey ? fromBase64(sessionKey) : undefined), [sessionKey]);

  /** Edit one secret's value (plain map or re-seal under the session key). */
  const editValue = useCallback(
    async (key: string, nextValue: string) => {
      setError('');
      if (!canEdit) return;
      if (state === 'plain') {
        await savePlain({ ...plain, [key]: nextValue });
      } else if (state === 'unlocked' && keyBytes) {
        const updated = await setSecret(stored as EncryptedSecrets, keyBytes, key, nextValue);
        await saveEncrypted(updated);
      }
    },
    [canEdit, state, plain, keyBytes, stored, savePlain, saveEncrypted],
  );

  /** Delete one secret. */
  const del = useCallback(
    async (keyName: string) => {
      if (!canEdit) return;
      const ok = await confirmDialog({
        title: 'Delete secret',
        message: `Delete the secret “${keyName}”? Workflows that use it will fail.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      setError('');
      if (state === 'plain') {
        const next = { ...plain };
        delete next[keyName];
        await savePlain(next);
      } else if (state === 'unlocked' && keyBytes) {
        const updated = removeSecret(stored as EncryptedSecrets, keyName);
        await saveEncrypted(updated);
      }
    },
    [canEdit, state, plain, keyBytes, stored, savePlain, saveEncrypted],
  );

  /** Add a new secret. */
  const add = useCallback(async () => {
    if (!NAME.test(name) || !value) return;
    if (!canEdit) return;
    setError('');
    if (state === 'plain') {
      await savePlain({ ...plain, [name]: value });
    } else if (state === 'unlocked' && keyBytes) {
      const updated = await setSecret(stored as EncryptedSecrets, keyBytes, name, value);
      await saveEncrypted(updated);
    }
    setName('');
    setValue('');
  }, [name, value, canEdit, state, plain, keyBytes, stored, savePlain, saveEncrypted]);

  /** Protect the current (plain) secrets with a new passphrase. */
  const protect = useCallback(async () => {
    setError('');
    if (pass1.length < MIN_PASSPHRASE) {
      setError(`Use at least ${MIN_PASSPHRASE} characters.`);
      return;
    }
    if (pass1 !== pass2) {
      setError('The passphrases do not match.');
      return;
    }
    setWorking(true);
    try {
      const { stored: sealed, key } = await encryptAll(plain, pass1);
      await saveEncrypted(sealed);
      await browser.storage.session.set({ [STORAGE_KEYS.secretsKey]: toBase64(key) });
      setPass1('');
      setPass2('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to protect secrets.');
    } finally {
      setWorking(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pass1, pass2, plain, saveEncrypted]);

  /** Unlock an encrypted store with the passphrase. */
  const unlock = useCallback(async () => {
    setError('');
    if (!isEncrypted(stored)) return;
    setWorking(true);
    try {
      const key = await vaultUnlock(stored as EncryptedSecrets, pass1);
      await browser.storage.session.set({ [STORAGE_KEYS.secretsKey]: toBase64(key) });
      setPass1('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wrong passphrase.');
    } finally {
      setWorking(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pass1, stored]);

  /** Lock now: drop the session key. */
  const lock = useCallback(async () => {
    setError('');
    await browser.storage.session.remove(STORAGE_KEYS.secretsKey);
  }, []);

  /** Remove the passphrase: decrypt, save plain, drop the session key. */
  const removePassphrase = useCallback(async () => {
    setError('');
    if (!isEncrypted(stored) || !keyBytes) return;
    const ok = await confirmDialog({
      title: 'Remove passphrase',
      message: 'Decrypt all secrets and store them unencrypted? Anyone with access to this browser profile can read them.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    setWorking(true);
    try {
      const plainMap = await decryptAll(stored as EncryptedSecrets, keyBytes);
      await savePlain(plainMap);
      await browser.storage.session.remove(STORAGE_KEYS.secretsKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove the passphrase.');
    } finally {
      setWorking(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored, keyBytes, savePlain]);

  /** Change the passphrase: re-encrypt under a new passphrase (we are unlocked). */
  const changePassphrase = useCallback(async () => {
    setError('');
    if (pass1.length < MIN_PASSPHRASE) {
      setError(`Use at least ${MIN_PASSPHRASE} characters.`);
      return;
    }
    if (pass1 !== pass2) {
      setError('The passphrases do not match.');
      return;
    }
    if (!isEncrypted(stored) || !keyBytes) return;
    setWorking(true);
    try {
      const plainMap = await decryptAll(stored as EncryptedSecrets, keyBytes);
      const { stored: sealed, key } = await encryptAll(plainMap, pass1);
      await saveEncrypted(sealed);
      await browser.storage.session.set({ [STORAGE_KEYS.secretsKey]: toBase64(key) });
      setPass1('');
      setPass2('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change the passphrase.');
    } finally {
      setWorking(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pass1, pass2, stored, keyBytes, saveEncrypted]);

  return (
    <section className="bf-manage">
      <div className="bf-manage-bar">
        <h2>Secrets</h2>
      </div>
      <p className="bf-muted">
        Passwords, API keys and tokens. Use them in any setting as <code>{'{{secret.name}}'}</code>. Their values are
        replaced by ••• in the run log, the step inspector and reports, and they are never included when you export a
        workflow.
      </p>

      {state === 'plain' && hasSecrets && (
        <p className="bf-error">Secrets are stored unencrypted. Protect them with a passphrase so they survive a backup or a copied profile.</p>
      )}
      {state === 'plain' && !hasSecrets && (
        <p className="bf-muted">No secrets yet. Add one below, or protect the store with a passphrase first.</p>
      )}
      {state === 'locked' && (
        <p className="bf-muted">Secrets are encrypted and locked this session. The names are visible, the values are hidden.</p>
      )}
      {state === 'unlocked' && (
        <p className="bf-muted">Secrets are unlocked this session. Edit below, or lock/change/remove the passphrase.</p>
      )}

      {canEdit && (
        <table className="bf-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Value</th>
              <th>Use as</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {names.map((key) => (
              <tr key={key}>
                <td><strong>{key}</strong></td>
                <td>
                    <input
                    type={shown.has(key) ? 'text' : 'password'}
                    value={plain[key] ?? ''}
                    aria-label={`Value of ${key}`}
                    onChange={(event) => void editValue(key, event.target.value)}
                  />
                </td>
                <td><code>{`{{secret.${key}}}`}</code></td>
                <td className="bf-table-actions">
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        setShown((current) => {
                          const next = new Set(current);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                    >
                      {shown.has(key) ? 'Hide' : 'Show'}
                    </button>
                    <button type="button" className="bf-danger" onClick={() => void del(key)}>
                      Delete
                    </button>
                  </>
                </td>
              </tr>
            ))}
              <tr>
                <td>
                  <input
                    type="text"
                    placeholder="loginPassword"
                    value={name}
                    aria-label="New secret name"
                    onChange={(event) => setName(event.target.value.trim())}
                  />
                  {name && !NAME.test(name) && <small className="bf-error">Letters, digits and _ only</small>}
                </td>
                <td>
                  <input type="password" placeholder="value" value={value} aria-label="New secret value" onChange={(event) => setValue(event.target.value)} />
                </td>
                <td />
                <td className="bf-table-actions">
                  <button type="button" className="bf-run" disabled={!NAME.test(name) || !value || working} onClick={add}>
                    Add secret
                  </button>
                </td>
              </tr>
          </tbody>
        </table>
      )}

      {state === 'locked' && hasSecrets && (
        <ul className="bf-muted" style={{ marginTop: 8 }}>
          {names.map((key) => <li key={key}>{key}</li>)}
        </ul>
      )}

      {state === 'plain' && (
        <form onSubmit={(event) => { event.preventDefault(); void protect(); }} className="bf-form">
          <label>
            Protect with a passphrase{' '}
            {hasSecrets ? '(re-encrypts existing secrets)' : '(no secrets yet)'}
          </label>
          <input
            type="password"
            value={pass1}
            onChange={(event) => setPass1(event.target.value)}
            placeholder="New passphrase (8+ characters)"
            aria-label="New passphrase"
          />
          <input
            type="password"
            value={pass2}
            onChange={(event) => setPass2(event.target.value)}
            placeholder="Repeat the passphrase"
            aria-label="Repeat passphrase"
          />
          <button type="submit" className="bf-run" disabled={working || pass1.length < MIN_PASSPHRASE || pass1 !== pass2}>
            Protect with a passphrase
          </button>
          <small className="bf-muted">The key lives only in this session (gone when the browser closes).</small>
          {error && <small className="bf-error">{error}</small>}
        </form>
      )}
      {state === 'locked' && (
        <form onSubmit={(event) => { event.preventDefault(); void unlock(); }} className="bf-form">
          <label>Passphrase</label>
          <input
            type="password"
            value={pass1}
            onChange={(event) => setPass1(event.target.value)}
            placeholder="Enter your passphrase"
            aria-label="Unlock passphrase"
          />
          <button type="submit" className="bf-run" disabled={working}>
            Unlock
          </button>
          {error && <small className="bf-error">{error}</small>}
        </form>
      )}
      {state === 'unlocked' && (
        <div className="bf-form" style={{ marginTop: 16 }}>
          <button type="button" className="bf-danger" onClick={lock} disabled={working}>
            Lock now
          </button>
          <button type="button" className="bf-run" style={{ marginLeft: 8 }} onClick={removePassphrase} disabled={working}>
            Remove passphrase
          </button>
          <button type="button" className="bf-run" style={{ marginLeft: 8 }} onClick={() => setShowChange(true)}>
            Change passphrase
          </button>
          {error && <small className="bf-error">{error}</small>}
        </div>
      )}

      {showChange && (
        <form onSubmit={(event) => { event.preventDefault(); void changePassphrase(); }} className="bf-form" style={{ marginTop: 12 }}>
          <label>New passphrase</label>
          <input
            type="password"
            value={pass1}
            onChange={(event) => setPass1(event.target.value)}
            placeholder="New passphrase (8+ characters)"
            aria-label="New passphrase"
          />
          <input
            type="password"
            value={pass2}
            onChange={(event) => setPass2(event.target.value)}
            placeholder="Repeat the passphrase"
            aria-label="Repeat passphrase"
          />
          <button type="submit" className="bf-run" disabled={working || pass1.length < MIN_PASSPHRASE || pass1 !== pass2}>
            Change passphrase
          </button>
          <button type="button" onClick={() => setShowChange(false)} style={{ marginLeft: 8 }}>Cancel</button>
          {error && <small className="bf-error">{error}</small>}
        </form>
      )}
    </section>
  );
}
