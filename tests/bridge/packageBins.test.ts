import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * npm 11 warns that it removes a `bin` entry written as "./cli.mjs" when it publishes ("script name cli.mjs
 * was invalid and removed"); npm 10 only rewrote it. Bin paths are therefore plain relative paths, and each
 * must exist and start with a node shebang.
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
