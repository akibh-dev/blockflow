import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * npm 11 drops a `bin` entry written as "./cli.mjs" when it publishes ("script name cli.mjs was invalid and
 * removed"); npm 10 only rewrote it. blockflow-runner 1.0.1 was published from CI without its `blockflow`
 * command that way. Bin paths are therefore plain relative paths, and each must exist and be in `files`.
 */
const PACKAGES = ['bridge', 'mcp', 'cli'];

describe('npm package bin entries', () => {
  for (const dir of PACKAGES) {
    const root = join(__dirname, '../../packages', dir);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; bin?: Record<string, string>; files?: string[] };

    it(`${pkg.name}: every bin path is plain, exists and starts with a shebang`, () => {
      const bins = Object.entries(pkg.bin ?? {});
      expect(bins.length).toBeGreaterThan(0);
      for (const [command, target] of bins) {
        expect(target, `${command} -> ${target}`).not.toMatch(/^\.{0,2}\//);
        expect(existsSync(join(root, target)), `${target} exists`).toBe(true);
        expect(readFileSync(join(root, target), 'utf8').startsWith('#!/usr/bin/env node'), `${target} shebang`).toBe(true);
      }
    });
  }
});
