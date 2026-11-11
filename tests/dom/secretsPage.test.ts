// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { encryptAll, toBase64 } from '../../src/browser/secretVault';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type FakeStorage = Record<string, unknown>;
const local: FakeStorage = {};
const session: FakeStorage = {};

const listeners: ((changes: Record<string, { newValue?: unknown }>, area: string) => void)[] = [];

function get(area: FakeStorage, key: string) {
  return key in area ? { [key]: area[key] } : {};
}
function set(area: FakeStorage, entries: Record<string, unknown> | string, value?: unknown) {
  if (typeof entries === 'string') { area[entries] = value; notify(area, entries, value); return; }
  Object.assign(area, entries);
  for (const [key, value] of Object.entries(entries)) notify(area, key, value);
}
function remove(area: FakeStorage, key: string) {
  delete area[key];
  notify(area, key, undefined);
}
function notify(area: FakeStorage, key: string, value: unknown) {
  const changes: Record<string, { newValue?: unknown }> = {};
  changes[key] = { newValue: value };
  const areaName = area === local ? 'local' : 'session';
  for (const fn of listeners) fn(changes, areaName);
}

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: (key: string) => Promise.resolve(get(local, key)),
        set: (key: string, value: unknown) => Promise.resolve(set(local, key, value)),
        remove: (key: string) => Promise.resolve(remove(local, key)),
      },
      session: {
        get: (key: string) => Promise.resolve(get(session, key)),
        set: (key: string, value: unknown) => Promise.resolve(set(session, key, value)),
        remove: (key: string) => Promise.resolve(remove(session, key)),
      },
      onChanged: {
        addListener: (fn: (typeof listeners)[number]) => listeners.push(fn),
        removeListener: (fn: (typeof listeners)[number]) => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
    },
    runtime: { sendMessage: vi.fn() },
  },
}));

const { SecretsPage } = await import('../../src/entrypoints/editor/components/SecretsPage');

const PASS = 'correct horse battery';

async function seedEncrypted(plain: Record<string, string>, passphrase: string) {
  const { stored, key } = await encryptAll(plain, passphrase, { iterations: 1000 });
  local['bf:secrets'] = stored;
  return { stored, key };
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
/** Wait for async crypto (decryptAll) and React state to settle. */
const settle = async (ms = 400) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 3; i += 1) await flush();
};

const inputByLabel = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll('input')].find((i) => (i.closest('label')?.textContent ?? '').includes(label) || i.getAttribute('aria-label')?.includes(label)) as HTMLInputElement | undefined;

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined;

function render() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  return { host, root };
}

describe('Secrets page (M6.1c)', () => {
  beforeEach(() => {
    Object.keys(local).forEach((key) => delete local[key]);
    Object.keys(session).forEach((key) => delete session[key]);
    listeners.splice(0, listeners.length);
  });

  it('locked: names are shown, values are hidden, unlock form is shown', async () => {
    await seedEncrypted({ loginPassword: 'hunter2', apiToken: 'abc-123' }, PASS);
    delete session['bf:secrets-key'];
    const { host, root } = render();
    await act(async () => root.render(createElement(SecretsPage)));
    await flush();

    expect(host.textContent).toContain('loginPassword');
    expect(host.textContent).toContain('apiToken');
    expect(host.textContent).not.toContain('hunter2');
    expect(host.textContent).not.toContain('abc-123');
    expect(inputByLabel(host, 'Unlock passphrase')).toBeTruthy();
    expect(button(host, 'Unlock')).toBeTruthy();
  });

  it('unlocked: decrypted values are editable', async () => {
    const { key } = await seedEncrypted({ loginPassword: 'hunter2' }, PASS);
    session['bf:secrets-key'] = toBase64(key);
    const { host, root } = render();
    await act(async () => root.render(createElement(SecretsPage)));
    await settle();

    const valueInput = inputByLabel(host, 'Value of loginPassword');
    expect(valueInput).toBeTruthy();
    expect((valueInput as HTMLInputElement).value).toBe('hunter2');
    expect(button(host, 'Lock now')).toBeTruthy();
    expect(button(host, 'Remove passphrase')).toBeTruthy();
  });

  it('lock now removes the session key and hides values again', async () => {
    const { key } = await seedEncrypted({ loginPassword: 'hunter2' }, PASS);
    session['bf:secrets-key'] = toBase64(key);
    const { host, root } = render();
    await act(async () => root.render(createElement(SecretsPage)));
    await settle();
    expect((inputByLabel(host, 'Value of loginPassword') as HTMLInputElement).value).toBe('hunter2'); // unlocked: values visible

    await act(async () => button(host, 'Lock now')!.click());
    await settle();

    expect(session['bf:secrets-key']).toBeUndefined();
    expect(inputByLabel(host, 'Value of loginPassword')).toBeUndefined();
    expect(inputByLabel(host, 'Unlock passphrase')).toBeTruthy();
  });
});
