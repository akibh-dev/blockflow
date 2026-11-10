import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readOrCreateToken, socketPath, tokenFile } from '../../packages/bridge/paths.mjs';

const temps: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bf-paths-'));
  temps.push(dir);
  return dir;
};
afterEach(() => temps.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('bridge paths', () => {
  it('picks the socket from the environment, XDG_RUNTIME_DIR, then ~/.config', () => {
    expect(socketPath({ BLOCKFLOW_SOCKET: '/x/s.sock', XDG_RUNTIME_DIR: '/run/user/1' })).toBe('/x/s.sock');
    expect(socketPath({ XDG_RUNTIME_DIR: '/run/user/1' }, { platform: 'linux' })).toBe('/run/user/1/blockflow.sock');
    expect(socketPath({}, { platform: 'darwin', home: '/Users/a' })).toBe('/Users/a/.config/blockflow/blockflow.sock');
  });

  it('uses a per-user named pipe on Windows (path construction only)', () => {
    expect(socketPath({ USERNAME: 'Akib H' }, { platform: 'win32' })).toBe('\\\\.\\pipe\\blockflow-Akib_H');
    expect(tokenFile({}, { platform: 'win32', home: 'C:\\Users\\a' })).toBe('C:\\Users\\a\\.config\\blockflow\\token');
  });

  it('picks the token file from the environment or ~/.config/blockflow/token', () => {
    expect(tokenFile({ BLOCKFLOW_TOKEN_FILE: '/t' })).toBe('/t');
    expect(tokenFile({}, { platform: 'linux', home: '/home/a' })).toBe('/home/a/.config/blockflow/token');
  });

  it('creates a missing token file with mode 0600 and reuses it', () => {
    const file = path.join(temp(), 'new', 'token');
    const token = readOrCreateToken(file);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(readOrCreateToken(file)).toBe(token);
    expect(readFileSync(file, 'utf8').trim()).toBe(token);
  });

  it('fills an empty token file', () => {
    const file = path.join(temp(), 'token');
    writeFileSync(file, '');
    expect(readOrCreateToken(file)).toMatch(/^[0-9a-f]{64}$/);
  });
});
