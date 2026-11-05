// Keeps docs/learning/examples/ identical to the code in the lessons.
//
// A code fence like  ```js file=01-hello/popup.js  in any lesson (NN-*.md) is the source of truth
// for examples/01-hello/popup.js.
//
//   node docs/learning/tools/sync-examples.mjs          write the example files
//   node docs/learning/tools/sync-examples.mjs --check  fail if a file differs (used by CI / before commit)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const learning = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const examples = path.join(learning, 'examples');
const check = process.argv.includes('--check');
// Matches a fenced block whose info string has file=<path>; captures the path and the body.
const fence = /^```[\w-]*\s+file=(\S+)\s*\n([\s\S]*?)^```[ \t]*$/gm;

/** examples-relative path → { body, from: lesson file }. A path defined twice is an error. */
const wanted = new Map();
for (const name of fs.readdirSync(learning).filter((f) => /^\d\d-.*\.md$/.test(f)).sort()) {
  const text = fs.readFileSync(path.join(learning, name), 'utf8');
  for (const [, file, body] of text.matchAll(fence)) {
    if (wanted.has(file)) throw new Error(`${file} is defined twice (second time in ${name})`);
    wanted.set(file, { body, from: name });
  }
}

let problems = 0;
for (const [file, { body, from }] of wanted) {
  const target = path.join(examples, file);
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (current === body) continue;
  if (check) {
    console.error(`out of date: examples/${file} (from ${from})`);
    problems++;
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    console.log(`wrote examples/${file}`);
  }
}
// Files in examples/ that no lesson defines are stale.
/** All file paths under `dir`, recursively. */
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
if (fs.existsSync(examples)) {
  for (const abs of walk(examples)) {
    const rel = path.relative(examples, abs).split(path.sep).join('/');
    if (!wanted.has(rel) && !rel.endsWith('/README.md')) { console.error(`stale example file: examples/${rel}`); problems++; }
  }
}
if (check && problems === 0) console.log(`examples match the lessons (${wanted.size} files)`);
process.exit(problems ? 1 : 0);
