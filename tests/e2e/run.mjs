// End-to-end tests: loads the e2e build of the extension into a Chromium-based browser (see
// harness.mjs) and runs the scenarios in ./specs against tests/fixtures/site.
// Usage: npm run e2e                 all specs
//        npm run e2e -- forms scraping  only these (file names in ./specs, without .mjs)
// BF_BROWSER=/path/to/chrome picks a browser, BF_HEADLESS=1 runs --headless=new.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from './harness.mjs';

const specsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'specs');
const all = readdirSync(specsDir).filter((name) => name.endsWith('.mjs')).map((name) => name.slice(0, -4));
// Order matters little, but keep the historical order first, then anything newer alphabetically.
const preferred = ['forms', 'editor-detect', 'testing', 'scraping', 'authoring', 'harder-pages'];
const ordered = [...preferred.filter((name) => all.includes(name)), ...all.filter((name) => !preferred.includes(name)).sort()];
const wanted = process.argv.slice(2);
const unknown = wanted.filter((name) => !all.includes(name));
if (unknown.length > 0) throw new Error(`No such e2e spec: ${unknown.join(', ')}. Available: ${ordered.join(', ')}`);
const selected = wanted.length > 0 ? ordered.filter((name) => wanted.includes(name)) : ordered;

const h = await launch();
console.log(`BlockFlow e2e · ${path.basename(h.executablePath)} · ${h.base} · ${selected.join(', ')}`);
for (const name of selected) {
  const spec = await import(pathToFileURL(path.join(specsDir, `${name}.mjs`)).href);
  try {
    await spec.default(h);
  } catch (error) {
    h.check(`${name}: spec crashed`, false, error instanceof Error ? error.stack ?? error.message : String(error));
  }
}
h.check('no errors in the editor page', h.pageErrors.length === 0, h.pageErrors.join('\n'));
await h.close();
const failures = h.failures;
console.log(failures === 0 ? '\nAll e2e checks passed.' : `\n${failures} e2e check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
