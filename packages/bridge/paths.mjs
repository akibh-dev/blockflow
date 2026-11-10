// Where the bridge socket and token live. Mirrors the "paths" comment in src/core/bridgeProtocol.ts:
//
//   Socket: $BLOCKFLOW_SOCKET, else $XDG_RUNTIME_DIR/blockflow.sock, else ~/.config/blockflow/blockflow.sock;
//           Windows: \\.\pipe\blockflow-<username>.
//   Token:  $BLOCKFLOW_TOKEN_FILE, else ~/.config/blockflow/token (0600, 32 random bytes hex).
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {Record<string, string | undefined>} Env
 * @typedef {{ platform?: NodeJS.Platform, home?: string, username?: string }} PathOptions
 */

/** @param {Env} env @param {PathOptions} options */
function homeOf(env, options) {
  return options.home ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
}

/** `~/.config/blockflow` (also on macOS and Windows: one place for the token, easy to find). */
export function configDir(env = process.env, options = {}) {
  const platform = options.platform ?? process.platform;
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(homeOf(env, options), '.config', 'blockflow');
}

/**
 * The socket (unix) or named pipe (Windows) the native host listens on.
 * @param {Env} [env]
 * @param {PathOptions} [options]
 */
export function socketPath(env = process.env, options = {}) {
  if (env.BLOCKFLOW_SOCKET) return env.BLOCKFLOW_SOCKET;
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    const user = options.username ?? env.USERNAME ?? safeUsername();
    return `\\\\.\\pipe\\blockflow-${user.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  }
  if (env.XDG_RUNTIME_DIR) return path.posix.join(env.XDG_RUNTIME_DIR, 'blockflow.sock');
  return path.posix.join(configDir(env, options), 'blockflow.sock');
}

/**
 * The file holding the shared secret a socket client must send in `auth`.
 * @param {Env} [env]
 * @param {PathOptions} [options]
 */
export function tokenFile(env = process.env, options = {}) {
  if (env.BLOCKFLOW_TOKEN_FILE) return env.BLOCKFLOW_TOKEN_FILE;
  const platform = options.platform ?? process.platform;
  return (platform === 'win32' ? path.win32.join : path.posix.join)(configDir(env, options), 'token');
}

/**
 * Reads the token, creating the file (mode 0600, parent folder 0700 when it is new) with 32 random bytes as
 * hex if it does not exist yet. Two hosts racing to create it end up with the same token (`wx` flag).
 * @param {string} file
 * @returns {string}
 */
export function readOrCreateToken(file) {
  try {
    const token = readFileSync(file, 'utf8').trim();
    if (token) return token;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  try {
    writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code !== 'EEXIST') throw error;
    // An empty file, or another host won the race: use what is there, or fill the empty one.
    const existing = readFileSync(file, 'utf8').trim();
    if (existing) return existing;
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
  }
  if (process.platform !== 'win32') chmodSync(file, 0o600);
  return token;
}

/** Reads an existing token (clients never create one). @param {string} file */
export function readToken(file) {
  return readFileSync(file, 'utf8').trim();
}

function safeUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return 'user';
  }
}
