#!/usr/bin/env node
// `blockflow`: run BlockFlow workflows and suites in Chromium with the extension, from a terminal or CI.
// Usage and flags: `blockflow --help` and docs/wiki/CLI.md.
import { main } from './main.mjs';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`blockflow: ${error?.stack ?? error}`);
    process.exitCode = 2;
  },
);
