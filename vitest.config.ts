import { defineConfig } from 'vitest/config';

// Core logic is plain TypeScript with no browser APIs, so tests run in Node.
// Files under tests/dom opt in to jsdom with a `// @vitest-environment jsdom` docblock.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Node 25+ has its own global `localStorage` (undefined without --localstorage-file) that shadows jsdom's in
    // tests/dom. Switch it off in the test workers; Node 22 and 24 accept the flag too.
    poolOptions: {
      forks: { execArgv: ['--no-experimental-webstorage'] },
      threads: { execArgv: ['--no-experimental-webstorage'] },
    },
    // `npm run test:coverage` (CI uploads coverage/ as an artifact). No threshold yet.
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
