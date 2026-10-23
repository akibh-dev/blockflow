import { useState } from 'react';
import { STORAGE_KEYS } from '../../../shared/keys';
import { useStorageValue } from '../hooks';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Named secrets: used as {{secret.name}}, masked everywhere, never exported with workflows. */
export function SecretsPage() {
  const [secrets, save] = useStorageValue<Record<string, string>>(STORAGE_KEYS.secrets, {});
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [shown, setShown] = useState<Set<string>>(new Set());
  const valid = NAME.test(name);

  const add = () => {
    if (!valid || !value) return;
    void save({ ...secrets, [name]: value });
    setName('');
    setValue('');
  };

  return (
    <section className="bf-manage">
      <div className="bf-manage-bar">
        <h2>Secrets</h2>
      </div>
      <p className="bf-muted">
        Passwords, API keys and tokens. Use them in any setting as <code>{'{{secret.name}}'}</code>. Their values are
        replaced by ••• in the run log, the step inspector and reports, and they are never included when you export a
        workflow. They are stored in this browser profile only (extension storage, not encrypted).
      </p>
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
          {Object.entries(secrets).map(([key, secret]) => (
            <tr key={key}>
              <td>
                <strong>{key}</strong>
              </td>
              <td>
                <input
                  type={shown.has(key) ? 'text' : 'password'}
                  value={secret}
                  aria-label={`Value of ${key}`}
                  onChange={(event) => void save({ ...secrets, [key]: event.target.value })}
                />
              </td>
              <td>
                <code>{`{{secret.${key}}}`}</code>
              </td>
              <td className="bf-table-actions">
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
                <button
                  type="button"
                  className="bf-danger"
                  onClick={() => {
                    if (!window.confirm(`Delete the secret “${key}”? Workflows that use it will fail.`)) return;
                    const next = { ...secrets };
                    delete next[key];
                    void save(next);
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
          <tr>
            <td>
              <input type="text" placeholder="loginPassword" value={name} aria-label="New secret name" onChange={(event) => setName(event.target.value.trim())} />
              {name && !valid && <small className="bf-error">Letters, digits and _ only</small>}
            </td>
            <td>
              <input type="password" placeholder="value" value={value} aria-label="New secret value" onChange={(event) => setValue(event.target.value)} />
            </td>
            <td />
            <td className="bf-table-actions">
              <button type="button" className="bf-run" disabled={!valid || !value} onClick={add}>
                Add secret
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
