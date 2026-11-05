import { browser } from 'wxt/browser';

/**
 * Test-only bridge for the Firefox e2e runner (tests/e2e/firefox.mjs). Firefox's WebDriver BiDi
 * cannot open moz-extension:// pages, so the test drives the extension from a fixture page instead:
 * the page posts `{ bfE2e: id, op, arg }` and this script answers with `{ bfE2eReply: id, ... }`.
 *
 * Registered at runtime by the background script only in e2e builds (BF_E2E=1), and only for the
 * local fixture server (http://127.0.0.1). Regular builds ship the file but never register it.
 */
export default defineContentScript({
  matches: ['http://127.0.0.1/*'],
  registration: 'runtime',
  main() {
    window.addEventListener('message', (event) => {
      const data = event.data as { bfE2e?: number; op?: string; arg?: unknown } | null;
      if (event.source !== window || !data || typeof data.bfE2e !== 'number') return;
      const reply = (body: Record<string, unknown>) => window.postMessage({ bfE2eReply: data.bfE2e, ...body }, '*');
      void (async () => {
        switch (data.op) {
          case 'send':
            return browser.runtime.sendMessage(data.arg);
          case 'get':
            return browser.storage.local.get(data.arg as string);
          case 'ping':
            return 'pong';
          default:
            throw new Error(`Unknown e2e op ${String(data.op)}`);
        }
      })().then(
        (result) => reply({ ok: true, result: result ?? null }),
        (error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    });
  },
});
