/** Encrypted storage for `bf:secrets`.

Secrets (`{{secret.name}}`) can be stored encrypted with a key derived from a passphrase. The key lives only
in `storage.session` (gone when the browser closes). Without a passphrase the plain v1 format is still valid
and behaves exactly as before.

The crypto here is pure (no browser APIs except the injected `SubtleCrypto`), so it can be unit-tested in
Node with `globalThis.crypto.subtle`.
*/

export interface Sealed {
  /** Base64 of 12 random IV bytes. */
  iv: string;
  /** Base64 of the AES-GCM ciphertext (+ 16-byte GCM tag appended by the browser). */
  data: string;
}

export interface EncryptedSecrets {
  format: 'blockflow-secrets';
  version: 2;
  kdf: {
    name: 'PBKDF2';
    hash: 'SHA-256';
    iterations: number;
    /** Base64 of 16 random salt bytes. */
    salt: string;
  };
  /** `seal('blockflow-check')` — proves the passphrase is right. */
  check: Sealed;
  /** Secret names in plain text (the editor needs them while locked). */
  names: string[];
  /** One sealed value per name. */
  values: Record<string, Sealed>;
}

/** `bf:secrets` is either a plain map (v1, "no passphrase" mode) or the encrypted form (v2). */
export type StoredSecrets = Record<string, string> | EncryptedSecrets;

export const PBKDF2_ITERATIONS = 600_000;

const CHECK_PLAINTEXT = 'blockflow-check';

/** True when `stored` is the encrypted v2 format. */
export function isEncrypted(stored: unknown): stored is EncryptedSecrets {
  return (
    typeof stored === 'object' &&
    stored !== null &&
    (stored as Record<string, unknown>).format === 'blockflow-secrets' &&
    (stored as Record<string, unknown>).version === 2
  );
}

/** Secret names, works in both modes. */
export function secretNames(stored: StoredSecrets | undefined): string[] {
  if (!stored) return [];
  if (isEncrypted(stored)) return stored.names.slice();
  return Object.keys(stored);
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 32 raw bytes derived from a passphrase + salt with PBKDF2-SHA256. */
export async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations = PBKDF2_ITERATIONS,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await subtle.importKey('raw', utf8(passphrase) as Uint8Array<ArrayBuffer>, 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** AES-GCM-256 seal of `plaintext` with `key` and a fresh random 12-byte IV. */
export async function seal(
  key: Uint8Array<ArrayBuffer>,
  plaintext: string,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<Sealed> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const cipher = await subtle.encrypt({ name: 'AES-GCM', iv }, k, utf8(plaintext) as Uint8Array<ArrayBuffer>);
  return { iv: toBase64(iv), data: toBase64(new Uint8Array(cipher)) };
}

/** AES-GCM-256 unseal. Throws on wrong key or tampered data (AES-GCM authenticates). */
export async function unseal(
  key: Uint8Array<ArrayBuffer>,
  sealed: Sealed,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(sealed.iv) },
    k,
    fromBase64(sealed.data),
  );
  return new TextDecoder().decode(plain);
}

export async function encryptAll(
  plain: Record<string, string>,
  passphrase: string,
  options: { iterations?: number; subtle?: SubtleCrypto } = {},
): Promise<{ stored: EncryptedSecrets; key: Uint8Array<ArrayBuffer> }> {
  const { iterations = PBKDF2_ITERATIONS, subtle = globalThis.crypto.subtle } = options;
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const key = await deriveKey(passphrase, salt, iterations, subtle);
  const names = Object.keys(plain);
  const check = await seal(key, CHECK_PLAINTEXT, subtle);
  const values: Record<string, Sealed> = {};
  for (const name of names) {
    values[name] = await seal(key, plain[name], subtle);
  }
  const stored: EncryptedSecrets = {
    format: 'blockflow-secrets',
    version: 2,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toBase64(salt) },
    check,
    names,
    values,
  };
  return { stored, key };
}

/** Derive the session key from `stored` + passphrase, throwing `Error('Wrong passphrase')` if it does not match `check`. */
export async function unlock(
  stored: EncryptedSecrets,
  passphrase: string,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<Uint8Array<ArrayBuffer>> {
  const salt = fromBase64(stored.kdf.salt);
  const key = await deriveKey(passphrase, salt, stored.kdf.iterations, subtle);
  try {
    await unseal(key, stored.check, subtle);
  } catch {
    throw new Error('Wrong passphrase');
  }
  return key;
}

/** Decrypt every sealed value back into a plain map. */
export async function decryptAll(
  stored: EncryptedSecrets,
  key: Uint8Array<ArrayBuffer>,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<Record<string, string>> {
  const plain: Record<string, string> = {};
  for (const [name, sealed] of Object.entries(stored.values)) {
    plain[name] = await unseal(key, sealed, subtle);
  }
  return plain;
}

/** Add or replace one sealed value, keeping `names` unique. */
export async function setSecret(
  stored: EncryptedSecrets,
  key: Uint8Array<ArrayBuffer>,
  name: string,
  value: string,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<EncryptedSecrets> {
  const next: EncryptedSecrets = {
    ...stored,
    values: { ...stored.values },
  };
  if (!next.values[name]) next.names = [...next.names, name];
  next.values[name] = await seal(key, value, subtle);
  next.names = next.names.filter((n, i) => next.names.indexOf(n) === i);
  return next;
}

/** Remove one value from both `names` and `values`. */
export function removeSecret(stored: EncryptedSecrets, name: string): EncryptedSecrets {
  const next: EncryptedSecrets = {
    ...stored,
    names: stored.names.filter((n) => n !== name),
    values: { ...stored.values },
  };
  delete next.values[name];
  return next;
}

/** Re-encrypt everything under a new passphrase. */
export async function changePassphrase(
  stored: EncryptedSecrets,
  key: Uint8Array<ArrayBuffer>,
  next: string,
  options: { iterations?: number; subtle?: SubtleCrypto } = {},
): Promise<{ stored: EncryptedSecrets; key: Uint8Array<ArrayBuffer> }> {
  const plain = await decryptAll(stored, key, options.subtle);
  return encryptAll(plain, next, options);
}
