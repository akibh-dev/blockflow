import { defineConfig } from 'vitest/config';

// Core logic is plain TypeScript with no browser APIs, so tests run in Node.
// Files under tests/dom opt in to jsdom with a `// @vitest-environment jsdom` docblock.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
