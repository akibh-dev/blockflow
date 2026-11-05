#!/usr/bin/env node
/**
 * Publishes `docs/wiki/` to the project wikis: the Forgejo primary (git.akibh.dev) and the GitHub mirror.
 * Each wiki is a separate git repo (`<repo>.wiki.git`); the code mirror to GitHub does not carry it.
 *
 * `docs/wiki/` is the source of truth: pages are written so they also read well when browsing the
 * repo (links like `Core-Engine.md` and `../../src/core/engine.ts`). GitHub wiki pages need other
 * links, so this script rewrites them on the way out, per target:
 *
 *   `Core-Engine.md#runs`        -> `Core-Engine#runs`                        (wiki page link)
 *   `../../src/core/engine.ts`   -> `<web>/blob/main/src/core/engine.ts`       (GitHub)
 *                                -> `<web>/src/branch/main/src/core/engine.ts` (Forgejo)
 *
 * Usage:
 *   node scripts/wiki.mjs --check                  verify every relative link resolves (part of `npm run check`)
 *   node scripts/wiki.mjs --build <dir> [target]   write the converted pages into <dir> (default target: github)
 *   node scripts/wiki.mjs --push [target...]       clone each wiki repo, replace its pages, commit and push
 *                                                  (default: every target)
 *
 * A wiki repo only exists after its first page is created in the web UI.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WIKI_DIR = join(ROOT, 'docs', 'wiki');
const BRANCH = 'main';

/** Where each wiki lives and how it links to source files (`dir` is true for folders). */
const TARGETS = {
  forgejo: {
    remote: 'ssh://git@ssh.akibh.dev/akib/blockflow.wiki.git',
    web: 'https://git.akibh.dev/akib/blockflow/wiki',
    fileUrl: (rel) => `https://git.akibh.dev/akib/blockflow/src/branch/${BRANCH}/${rel}`,
  },
  github: {
    remote: 'https://github.com/akibh-dev/blockflow.wiki.git',
    web: 'https://github.com/akibh-dev/blockflow/wiki',
    fileUrl: (rel, dir) => `https://github.com/akibh-dev/blockflow/${dir ? 'tree' : 'blob'}/${BRANCH}/${rel}`,
  },
};

/**
 * GitHub's heading anchor slug (close enough for checking links: lowercase, drop punctuation and
 * emoji; marks such as the U+FE0F variation selector stay, like github-slugger keeps them).
 */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Anchors defined by a markdown file's headings (with GitHub's -1, -2 suffixes for duplicates). */
function anchorsOf(file) {
  const seen = new Map();
  const out = new Set();
  let fence = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slug(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

const anchorCache = new Map();
function hasAnchor(file, anchor) {
  if (!anchorCache.has(file)) anchorCache.set(file, anchorsOf(file));
  return anchorCache.get(file).has(decodeURIComponent(anchor).toLowerCase());
}

/**
 * Converts one link target. Returns `{ target, error?, warning? }`. External links and in-page
 * anchors are returned unchanged.
 */
function convertTarget(target, pages, site) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) return { target };
  const hashAt = target.indexOf('#');
  const path = hashAt < 0 ? target : target.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : target.slice(hashAt + 1);
  const abs = resolve(WIKI_DIR, decodeURI(path));

  if (dirname(abs) === WIKI_DIR && pages.has(abs.slice(WIKI_DIR.length + 1))) {
    const warning = hash && !hasAnchor(abs, hash) ? `no heading for #${hash} in ${path}` : undefined;
    return { target: path.replace(/\.md$/, '') + (hash ? `#${hash}` : ''), warning };
  }
  const rel = relative(ROOT, abs);
  if (rel.startsWith('..')) return { target, error: `points outside the repo: ${target}` };
  if (!existsSync(abs)) return { target, error: `missing file: ${target}` };
  const warning = hash && abs.endsWith('.md') && !hasAnchor(abs, hash) ? `no heading for #${hash} in ${rel}` : undefined;
  const url = site.fileUrl(rel.split(sep).join('/'), statSync(abs).isDirectory());
  return { target: url + (hash ? `#${hash}` : ''), warning };
}

/** Rewrites the links of one page, skipping fenced code blocks and inline code. */
function convertPage(name, text, pages, problems, site) {
  let fence = false;
  return text
    .split('\n')
    .map((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      if (fence) return line;
      const where = `${name}:${i + 1}`;
      const fix = (target) => {
        const r = convertTarget(target, pages, site);
        if (r.error) problems.errors.push(`${where} ${r.error}`);
        if (r.warning) problems.warnings.push(`${where} ${r.warning}`);
        return r.target;
      };
      // Leave `inline code` alone by only rewriting the parts between backtick spans.
      return line
        .split(/(`[^`]*`)/)
        .map((part) =>
          part.startsWith('`')
            ? part
            : part
                .replace(/\]\(\s*<?([^)\s>]+)>?(\s+"[^"]*")?\s*\)/g, (_, t, title = '') => `](${fix(t)}${title})`)
                .replace(/^(\s*\[[^\]]+\]:\s*)(\S+)/, (_, pre, t) => pre + fix(t)),
        )
        .join('');
    })
    .join('\n');
}

/** Reads and converts every page in docs/wiki for one target. */
function buildAll(site) {
  if (!existsSync(WIKI_DIR)) throw new Error('docs/wiki does not exist');
  const names = readdirSync(WIKI_DIR).filter((f) => f.endsWith('.md'));
  const pages = new Set(names);
  const problems = { errors: [], warnings: [] };
  const out = new Map();
  for (const name of names) {
    out.set(name, convertPage(name, readFileSync(join(WIKI_DIR, name), 'utf8'), pages, problems, site));
  }
  if (!pages.has('Home.md')) problems.errors.push('docs/wiki/Home.md is missing');
  if (pages.has('_Sidebar.md')) {
    const sidebar = readFileSync(join(WIKI_DIR, '_Sidebar.md'), 'utf8');
    for (const name of names) {
      if (!name.startsWith('_') && !sidebar.includes(`(${name}`)) problems.warnings.push(`${name} is not in _Sidebar.md`);
    }
  }
  return { out, problems };
}

function report({ errors, warnings }) {
  for (const w of warnings) console.warn(`warning: ${w}`);
  for (const e of errors) console.error(`error: ${e}`);
  if (errors.length) process.exit(1);
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

/** Clones one wiki repo, replaces its pages with `out`, and pushes if anything changed. */
function push(name, site, out) {
  const work = mkdtempSync(join(tmpdir(), 'bf-wiki-'));
  try {
    try {
      git(work, 'clone', '--quiet', site.remote, 'wiki');
    } catch {
      console.error(
        `\n${name}: could not clone ${site.remote}.\nA wiki repo exists only after its first page is saved:` +
          `\nopen ${site.web}, create the first page, save, then run this again.`,
      );
      return false;
    }
    const dir = join(work, 'wiki');
    for (const f of readdirSync(dir)) if (f.endsWith('.md')) rmSync(join(dir, f));
    for (const [page, text] of out) writeFileSync(join(dir, page), text);
    git(dir, 'add', '-A');
    if (!git(dir, 'status', '--porcelain')) {
      console.log(`${name}: already up to date (${site.web})`);
      return true;
    }
    const sha = git(ROOT, 'rev-parse', '--short', 'HEAD');
    git(dir, 'commit', '--quiet', '-m', `Sync wiki from docs/wiki at ${sha}`);
    git(dir, 'push', '--quiet', 'origin', 'HEAD');
    console.log(`${name}: pushed ${out.size} pages to ${site.web}`);
    return true;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const [mode, ...args] = process.argv.slice(2);
const pick = (name) => {
  if (!TARGETS[name]) throw new Error(`unknown target ${name}; use ${Object.keys(TARGETS).join(', ')}`);
  return TARGETS[name];
};

if (mode === '--check' || mode === undefined) {
  const { out, problems } = buildAll(TARGETS.github);
  report(problems);
  console.log(`docs/wiki: ${out.size} pages, all links resolve`);
} else if (mode === '--build') {
  const [dir, name = 'github'] = args;
  if (!dir) throw new Error('usage: --build <dir> [target]');
  const { out, problems } = buildAll(pick(name));
  report(problems);
  for (const [page, text] of out) writeFileSync(join(resolve(dir), page), text);
  console.log(`wrote ${out.size} pages for ${name} to ${dir}`);
} else if (mode === '--push') {
  const names = args.length ? args : Object.keys(TARGETS);
  let ok = true;
  for (const name of names) {
    const { out, problems } = buildAll(pick(name));
    report(problems);
    ok = push(name, pick(name), out) && ok;
  }
  if (!ok) process.exit(1);
} else {
  console.error('usage: node scripts/wiki.mjs [--check | --build <dir> [target] | --push [target...]]');
  process.exit(2);
}
