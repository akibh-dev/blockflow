// An in-process fake of the bridge client (`connectBridge` from blockflow-bridge/client): answers
// methods from handlers, records every call and lets a handler emit notifications for its request.
import type { BridgeCallOptions, BridgeClient } from '../../packages/mcp/index.mjs';

export class FakeBridgeError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type Handler = (params: any, notify: (method: string, params: any) => void) => unknown;

export function fakeBridge(handlers: Record<string, Handler>) {
  const calls: { method: string; params: any; options?: BridgeCallOptions }[] = [];
  let connects = 0;
  let closes = 0;
  const client: BridgeClient = {
    async call(method, params, options) {
      calls.push({ method, params, options });
      const handler = handlers[method];
      if (!handler) throw new FakeBridgeError(-32601, `Unknown method ${method}`);
      const notify = (name: string, note: any) => options?.onNotification?.({ jsonrpc: '2.0', method: name, params: { requestId: 1, ...note } });
      return handler(params, notify);
    },
    close() {
      closes += 1;
    },
  };
  return {
    calls,
    get connects() {
      return connects;
    },
    get closes() {
      return closes;
    },
    connect: async () => {
      connects += 1;
      return client;
    },
  };
}

/** Splits bytes into `blob.get` answers of `chunk` bytes, as the extension does. */
export function blobHandler(blobs: Record<string, { bytes: Buffer; mime?: string }>, chunk = 5): Handler {
  return ({ blobId, offset }) => {
    const blob = blobs[blobId];
    if (!blob) throw new FakeBridgeError(-32004, `No blob ${blobId}`);
    const part = blob.bytes.subarray(offset, offset + chunk);
    return { data: part.toString('base64'), offset, size: blob.bytes.length, done: offset + part.length >= blob.bytes.length, ...(blob.mime ? { mime: blob.mime } : {}) };
  };
}

export const passedRun = {
  id: 'run-1',
  workflowId: 'wf-1',
  workflowName: 'Login test',
  trigger: 'manual',
  status: 'passed',
  startedAt: '2026-11-10T10:00:00.000Z',
  endedAt: '2026-11-10T10:00:02.500Z',
  steps: [
    { nodeId: 'n1', sourceId: 's1', blockType: 'open-url', status: 'passed', startedAt: '2026-11-10T10:00:00.000Z', durationMs: 1200, attempts: 1 },
    { nodeId: 'n2', sourceId: 'title', blockType: 'read-element', status: 'passed', startedAt: '2026-11-10T10:00:01.200Z', durationMs: 300, attempts: 1, output: { text: 'Welcome' } },
  ],
};

export const failedRun = {
  ...passedRun,
  id: 'run-2',
  status: 'failed',
  error: 'Step "landed" failed',
  steps: [
    passedRun.steps[0],
    {
      nodeId: 'n3',
      sourceId: 'landed',
      blockType: 'click',
      status: 'failed',
      startedAt: '2026-11-10T10:00:01.200Z',
      durationMs: 30000,
      attempts: 1,
      error: 'No element matches role=button[name="Sign in"]',
      code: 'locator.not-found',
      locator: 'role=button[name="Sign in"]',
      url: 'https://example.com/login',
      screenshot: 'shot-1',
    },
  ],
};
