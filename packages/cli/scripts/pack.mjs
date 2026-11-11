// `node scripts/pack.mjs copy` (prepack): bundle the automation build of the extension
// (`npm run build:automation` → .output-automation/chrome-mv3 at the repo root) into ./extension, so the
// published `blockflow-runner` can start Chromium with BlockFlow without a checkout. `clean` (postpack)
// removes the copy again, so a development checkout always uses the live build.
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = path.resolve(packageDir, '../../.output-automation/chrome-mv3');
const target = path.join(packageDir, 'extension');

const mode = process.argv[2];
if (mode === 'copy') {
  if (!existsSync(path.join(build, 'manifest.json'))) {
    console.error(`No automation build at ${build}. Run \`npm run build:automation\` at the repo root first.`);
    process.exit(1);
  }
  rmSync(target, { recursive: true, force: true });
  cpSync(build, target, { recursive: true });
  console.error(`bundled the extension from ${path.relative(packageDir, build)}`);
} else if (mode === 'clean') {
  rmSync(target, { recursive: true, force: true });
} else {
  console.error('usage: node scripts/pack.mjs copy|clean');
  process.exit(2);
}
