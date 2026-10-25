import { createAgent } from '../dom/agent';
import type { Agent } from '../dom/agent';

/**
 * The page agent: clicks, fills, reads and waits inside a web page for page blocks.
 * Not injected automatically: src/browser/pageDriver.ts injects it the first time a block needs a
 * page, and again after every navigation (a new page starts without it).
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  main() {
    const holder = globalThis as { __blockflowAgent?: Agent };
    holder.__blockflowAgent ??= createAgent();
  },
});
