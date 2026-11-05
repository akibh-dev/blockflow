import { defineConfig } from 'vitest/config';

// Core logic is plain TypeScript with no browser APIs, so tests run in Node.
// Files under tests/dom opt in to jsdom with a `// @vitest-environment jsdom` docblock.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // `npm run test:coverage` (CI uploads coverage/ as an artifact). No threshold yet.
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
