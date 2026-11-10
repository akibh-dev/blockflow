import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as ts from '../../src/core/bridgeProtocol';
import * as mjs from '../../packages/bridge/protocol.mjs';

// packages/bridge/protocol.mjs mirrors src/core/bridgeProtocol.ts for the Node packages.
describe('bridge protocol mirror', () => {
  it('has the same constants', () => {
    expect(mjs.BRIDGE_PROTOCOL_VERSION).toBe(ts.BRIDGE_PROTOCOL_VERSION);
    expect(mjs.NATIVE_HOST_NAME).toBe(ts.NATIVE_HOST_NAME);
    expect(mjs.MAX_MESSAGE_BYTES).toBe(ts.MAX_MESSAGE_BYTES);
    expect(mjs.BLOB_CHUNK_BYTES).toBe(ts.BLOB_CHUNK_BYTES);
    expect(mjs.INLINE_RESULT_BYTES).toBe(ts.INLINE_RESULT_BYTES);
    expect({ ...mjs.RPC_ERRORS }).toEqual({ ...ts.RPC_ERRORS });
  });

  // Types do not exist at run time: read the interface keys from the source text.
  const source = readFileSync(new URL('../../src/core/bridgeProtocol.ts', import.meta.url), 'utf8');
  const keysOf = (name: string) => {
    const body = source.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
    return [...body.matchAll(/^ {2}('?)([\w.]+)\1\??:/gm)].map((match) => match[2]);
  };

  it('lists every method of BridgeParams and BridgeResults', () => {
    expect(keysOf('BridgeParams').length).toBeGreaterThan(5);
    expect([...mjs.BRIDGE_METHODS].sort()).toEqual(keysOf('BridgeParams').sort());
    expect([...mjs.BRIDGE_METHODS].sort()).toEqual(keysOf('BridgeResults').sort());
  });

  it('lists every notification of BridgeNotifications', () => {
    expect([...mjs.BRIDGE_NOTIFICATIONS].sort()).toEqual(keysOf('BridgeNotifications').sort());
  });
});
