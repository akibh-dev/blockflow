import { describe, expect, it } from 'vitest';
import type { EncryptedSecrets, StoredSecrets } from '../../src/browser/secretVault';
import {
  changePassphrase,
  decryptAll,
  deriveKey,
  encryptAll,
  isEncrypted,
  PBKDF2_ITERATIONS,
  removeSecret,
  secretNames,
  seal,
  setSecret,
  unseal,
  unlock,
} from '../../src/browser/secretVault';

function subtle(): SubtleCrypto {
  return globalThis.crypto.subtle;
}

async function roundTrip(passphrase: string, plain: Record<string, string>) {
  const { stored, key } = await encryptAll(plain, passphrase, { iterations: 1000, subtle: subtle() });
  const decrypted = await decryptAll(stored, key, subtle());
  return { stored, key, decrypted };
}

describe('secretVault', () => {
  it('encryptAll → decryptAll round trip; names equal the plain keys', async () => {
    const plain = { loginPassword: 'hunter2', apiToken: 'abc-123' };
    const { stored, key, decrypted } = await roundTrip('correct horse battery', plain);
    expect(isEncrypted(stored)).toBe(true);
    expect(decrypted).toEqual(plain);
    expect(secretNames(stored)).toEqual(['loginPassword', 'apiToken']);
  });

  it('unlock with the right passphrase returns a key that decrypts; wrong passphrase throws', async () => {
    const { stored, key } = await roundTrip('correct horse battery', { x: 'y' });
    const unlocked = await unlock(stored, 'correct horse battery', subtle());
    expect(unlocked).toEqual(key);
    await expect(unlock(stored, 'wrong passphrase', subtle())).rejects.toThrow('Wrong passphrase');
  });

  it('stored JSON contains none of the plain values', async () => {
    const plain = { loginPassword: 'hunter2' };
    const { stored } = await roundTrip('pass', plain);
    expect(JSON.stringify(stored).includes('hunter2')).toBe(false);
  });

  it('tampering one byte of values.x.data makes unseal throw', async () => {
    const { stored, key } = await roundTrip('pass', { x: 'y' });
    const tampered: EncryptedSecrets = {
      ...stored,
      values: { ...stored.values, x: { ...stored.values.x, data: stored.values.x.data + 'A' } },
    };
    await expect(unseal(key, tampered.values.x, subtle())).rejects.toThrow();
  });

  it('setSecret adds/replaces one value and keeps names unique', async () => {
    const { stored, key } = await roundTrip('pass', { a: '1' });
    const added = await setSecret(stored, key, 'b', '2', subtle());
    expect(secretNames(added)).toEqual(['a', 'b']);
    const replaced = await setSecret(added, key, 'a', '1-changed', subtle());
    expect(secretNames(replaced)).toEqual(['a', 'b']);
    const decrypted = await decryptAll(replaced, key, subtle());
    expect(decrypted).toEqual({ a: '1-changed', b: '2' });
  });

  it('removeSecret removes the name from both names and values', async () => {
    const { stored, key } = await roundTrip('pass', { a: '1', b: '2' });
    const removed = removeSecret(stored, 'a');
    expect(secretNames(removed)).toEqual(['b']);
    expect(removed.values.a).toBeUndefined();
    const decrypted = await decryptAll(removed, key, subtle());
    expect(decrypted).toEqual({ b: '2' });
  });

  it('changePassphrase: old passphrase no longer unlocks, new one does, values unchanged', async () => {
    const { stored } = await roundTrip('old', { x: 'y' });
    const { stored: rekeyed, key } = await changePassphrase(stored, await unlock(stored, 'old', subtle()), 'new', { iterations: 1000, subtle: subtle() });
    await expect(unlock(rekeyed, 'old', subtle())).rejects.toThrow('Wrong passphrase');
    const nextKey = await unlock(rekeyed, 'new', subtle());
    expect(await decryptAll(rekeyed, nextKey, subtle())).toEqual({ x: 'y' });
    expect(key).toEqual(nextKey);
  });

  it('secretNames works for a plain map and for EncryptedSecrets', () => {
    expect(secretNames({ a: '1', b: '2' })).toEqual(['a', 'b']);
    expect(secretNames(undefined)).toEqual([]);
    expect(
      secretNames(
        {
          format: 'blockflow-secrets',
          version: 2,
          kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 1000, salt: 'salt' },
          check: { iv: 'iv', data: 'data' },
          names: ['a'],
          values: {},
        } as unknown as EncryptedSecrets,
      ),
    ).toEqual(['a']);
  });

  it('two seal calls of the same text give different IVs', async () => {
    const key = await deriveKey('pass', new Uint8Array([1, 2, 3]), 1000, subtle());
    const first = await seal(key, 'hello', subtle());
    const second = await seal(key, 'hello', subtle());
    expect(first.iv).not.toEqual(second.iv);
    expect(await unseal(key, first, subtle())).toBe('hello');
    expect(await unseal(key, second, subtle())).toBe('hello');
  });

  it('deriveKey returns 32 raw bytes and PBKDF2_ITERATIONS is the default', async () => {
    const key = await deriveKey('pass', new Uint8Array([1, 2, 3]), 1000, subtle());
    expect(key.length).toBe(32);
    expect(PBKDF2_ITERATIONS).toBe(600_000);
  });

  it('a plain map is not encrypted', () => {
    expect(isEncrypted({ a: '1' })).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
  });

  type Stored = StoredSecrets;
  const _t: Stored = { a: '1' };
  void _t;
});
