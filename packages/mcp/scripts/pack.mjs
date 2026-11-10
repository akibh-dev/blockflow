// `node scripts/pack.mjs copy` (prepack): copy the guide, block reference, script schema and llms.txt
// into ./resources so the published package is self-contained. `clean` (postpack) removes the copies
// again, so a development checkout always reads the live files from the repo.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PACKAGE_DIR, copyResources } from '../resources.mjs';

const mode = process.argv[2];
if (mode === 'copy') {
  for (const { from, to } of copyResources()) {
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    console.error(`copied ${path.relative(PACKAGE_DIR, to)}`);
  }
} else if (mode === 'clean') {
  rmSync(path.join(PACKAGE_DIR, 'resources'), { recursive: true, force: true });
} else {
  console.error('usage: node scripts/pack.mjs copy|clean');
  process.exit(2);
}
