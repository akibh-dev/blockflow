# Tooling and Scripts

The repo's generators and checkers (block reference, learning examples, wiki), the TypeScript settings that
shape how code is written, `llms.txt`, and the CI workflow. Read it when a `*:check` fails, when you add a
block (the guide must be regenerated), or when you wonder why an import has to look a certain way.

**Source:** [scripts/guide.ts](../../scripts/guide.ts) · [scripts/wiki.mjs](../../scripts/wiki.mjs) ·
[docs/learning/tools/sync-examples.mjs](../learning/tools/sync-examples.mjs) · [tsconfig.json](../../tsconfig.json) ·
[vitest.config.ts](../../vitest.config.ts) · [llms.txt](../../llms.txt) · [.github/workflows/ci.yml](../../.github/workflows/ci.yml) ·
[package.json](../../package.json)

## Overview

| Tool | Sync (write) | Check (CI-style, exits 1 when stale) | Source of truth → generated |
| --- | --- | --- | --- |
| Block reference | `npm run guide:sync` | `npm run guide:check` | Block registry (`src/core/blocks`) → `docs/guide/blocks.md`, `blocks.json`, `workflow.schema.json` |
| Learning examples | `npm run learn:sync` | `npm run learn:check` | Code fences in `docs/learning/NN-*.md` → `docs/learning/examples/**` |
| Wiki | `npm run wiki:publish` (push) | `npm run wiki:check` | `docs/wiki/*.md` → Forgejo and GitHub wiki repos |

All three checks run in `npm run check`. Never hand-edit a generated file: edit the source and re-sync.

## scripts/guide.ts

Generates the usage guide's block reference from the live registry, so the docs cannot describe settings that
do not exist. Run with `vite-node` (TypeScript, same module resolution as Vitest), so it imports `src/core`
directly: `createDefaultRegistry()`, `DEFAULT_TIMEOUT_SECONDS` (engine), `nodePorts` (ports) and
`CATEGORY_LABELS` (types).

| Output (in `docs/guide/`) | Content |
| --- | --- |
| `blocks.md` | Header with a "do not edit" comment, block count, an index per category (linking to anchors), then one section per block: `## <icon> <Label> — \`type\``, description, output ports (with a note that `error` is added when `step.onError` is `"port"`), default timeout, whether it can start a workflow, a settings table (config key, label, type, default from `defaultConfig`, required / supports `{{…}}` / help), and the data keys it adds (`outputs`) |
| `blocks.json` | `{ generatedBy, blocks: [...] }`; per block: `type`, `label`, `category`, `description`, `canStart` (has `start`, `trigger` or `run`), `canTakeInput` (has `run`), `ports`, `timeoutSeconds`, `defaultConfig`, `fields` (key, label, kind, plus `required`, `templated`, select `options`, number `min`/`max`, rows `columns`, `help` when present), `outputs` |
| `workflow.schema.json` | JSON Schema (2020-12) for what Import accepts: either `{ format: 'blockflow-workflows', version: 1, workflows[] }` or one workflow. Nodes are a `oneOf` per block type with typed `config` (number → `number` with min/max, boolean, select → `enum`, rows → array of string-valued objects, everything else → string) and `required` keys; edges; and a shared `step` definition (`timeoutSeconds`, `retries` 0–5, `onError`, `disabled`, `note`, `screenshot`) |

| `report.schema.json` | From [scripts/reportSchema.ts](../../scripts/reportSchema.ts) (`reportSchemaFiles()`, one line in `guide.ts`): JSON Schema of the JSON report (`toJsonReport`): `schemaVersion` (`REPORT_SCHEMA_VERSION`), `summary`, runs and steps (statuses from `runs.ts`, triggers from `TRIGGER_LABELS`), and `$defs/errorCode` with every code of `ERROR_CODES` (src/core/errors.ts) and its meaning and fix |

Mode: without arguments it writes files whose content differs and prints `wrote docs/guide/<name>`. With
`--check` (passed as `vite-node scripts/guide.ts -- --check`) it writes nothing, prints
`docs/guide/<name> is out of date. Run: npm run guide:sync` for each stale file and exits 1.

Hand-written parts of the guide (`docs/guide/README.md`, `docs/guide/examples/*.blockflow.json`) are not
generated, but the examples are validated by `tests/core/guideExamples.test.ts` (see [Testing](Testing.md)).
When adding a block, see [Adding a Block](Adding-a-Block.md).

## docs/learning/tools/sync-examples.mjs

Keeps `docs/learning/examples/` identical to the code in the lessons (the rules are in
[MAINTAINING.md](../learning/MAINTAINING.md)).

- Scans `docs/learning/` for files matching `NN-*.md`, in name order.
- Collects every fenced block whose info string has `file=<path>`, e.g. a fence opened with
  `js file=01-hello/popup.js`. The body becomes `examples/01-hello/popup.js` byte for byte.
- A path defined twice throws (`… is defined twice (second time in <lesson>)`).
- Sync mode creates folders and writes changed files (`wrote examples/…`). `--check` reports
  `out of date: examples/<file> (from <lesson>)` instead.
- In both modes, any file under `examples/` that no lesson defines is reported as
  `stale example file: …` and makes the exit code 1 (except `README.md` files inside example folders). Sync
  does not delete stale files: remove them by hand.

## scripts/wiki.mjs

Checks and publishes this wiki. `docs/wiki/` is the source of truth; pages use repo-relative links so they
also work when browsing the repo.

| Mode | Does |
| --- | --- |
| `--check` (default) | Converts every page in memory; errors (exit 1) on links to missing files, links outside the repo, or a missing `Home.md`; warns on unknown `#anchors` and pages missing from `_Sidebar.md` (if there is one) |
| `--build <dir> [target]` | Writes the pages converted for one target (default `github`) to `<dir>` |
| `--push [target...]` | For each target (default: all), clones its wiki repo, replaces every `*.md`, commits "Sync wiki from docs/wiki at <sha>" and pushes. Skips the commit when nothing changed |

The code lives on a self-hosted Forgejo (`git.akibh.dev`, pushed over `ssh.akibh.dev`), which push-mirrors
`main` to GitHub. Wikis are separate git repos and are **not** mirrored, so the script publishes to both:

| Target | Wiki repo | Source links become |
| --- | --- | --- |
| `forgejo` | `ssh://git@ssh.akibh.dev/akib/blockflow.wiki.git` | `https://git.akibh.dev/akib/blockflow/src/branch/main/<path>` |
| `github` | `https://github.com/akibh-dev/blockflow.wiki.git` | `https://github.com/akibh-dev/blockflow/blob\|tree/main/<path>` |

Page links become `Page#a` (no `.md`) for both. Links inside code fences and inline code are left alone.
Source links point at `main`, so a page that links to a new file 404s until that file reaches `main`.
A wiki repo exists only after its first page is created in the web UI. Change hosts in `TARGETS` at the top of the script.

## tsconfig.json

```json
{
  "extends": "./.wxt/tsconfig.json",
  "compilerOptions": { "jsx": "react-jsx", "strict": true, "verbatimModuleSyntax": true, "noFallthroughCasesInSwitch": true },
  "include": ["src", "tests", "scripts", "wxt.config.ts", "vitest.config.ts", ".wxt/wxt.d.ts"]
}
```

| Setting | Effect on the code |
| --- | --- |
| `extends ./.wxt/tsconfig.json` | Generated by `wxt prepare` (`npm install`). Brings `target`/`module` `ESNext`, `moduleResolution: Bundler`, `noEmit`, `resolveJsonModule`, `skipLibCheck`. Typecheck fails on a fresh clone until `npm install` has run |
| `verbatimModuleSyntax` | Imports are emitted as written, so type-only imports **must** be `import type { … }` (or `import { type X }`); otherwise the bundler or Node tries to load a value that does not exist |
| `strict` | All strict checks |
| `noFallthroughCasesInSwitch` | Every non-empty `case` must `break`/`return` |
| `jsx: react-jsx` | Automatic JSX runtime, no `import React` |
| `include` | Typechecks app, tests, scripts and configs together. `.mjs` files (e2e, `sync-examples`, `wiki.mjs`) are not typechecked |
| `.wxt/wxt.d.ts` | Auto-import declarations (`defineBackground`, `defineContentScript`, …) and `browser` types |

`.wxt/tsconfig.json` also declares path aliases (`@/`, `~/`, `@@/`, `~~/`). **Do not use them**: Vitest and
`vite-node` are not configured for them, so the codebase rule is relative imports only.

## llms.txt

[llms.txt](../../llms.txt) follows the [llms.txt](https://llmstxt.org) convention: a short Markdown index for
AI tools. It points AI tools that **write workflows** at the usage guide, `blocks.md`, `blocks.json`,
`workflow.schema.json` and `docs/guide/examples/`, and AI tools that **change code** at `CLAUDE.md`,
`docs/ARCHITECTURE.md` and `docs/PLAN-automation.md`. Hand-written; update it when those entry points move.

## CI workflow

[.github/workflows/ci.yml](../../.github/workflows/ci.yml), triggered by pushes to `main` and every pull
request (the GitHub mirror only receives `main`, so there it runs after a merge). Two jobs on `ubuntu-latest`:

**`check`**

| Step | Command |
| --- | --- |
| Checkout, Node 22 with npm cache | `actions/checkout@v4`, `actions/setup-node@v4` |
| Install | `npm ci` (runs `wxt prepare`) |
| Typecheck | `npm run typecheck` |
| Unit tests with coverage | `npm run test:coverage` (`vitest run --coverage` with `@vitest/coverage-v8`, settings in `vitest.config.ts`; no threshold) |
| Coverage artifact | `actions/upload-artifact@v4`: `coverage/` as `coverage` (HTML report and `coverage-summary.json`) |
| Learning examples | `npm run learn:check` |
| Block reference | `npm run guide:check` |
| Wiki links | `npm run wiki:check` |
| Builds | `npm run build`, `npm run build:firefox` |

**`e2e`** (30 minute limit)

| Step | Command |
| --- | --- |
| Checkout, Node 22, install | As above |
| Browser | `npx playwright install --with-deps chromium` |
| End-to-end tests | `BF_BROWSER` set to `chromium.executablePath()` from `playwright-core`, then `BF_HEADLESS=1 xvfb-run -a npm run e2e` (new headless loads extensions; `xvfb-run` provides a display as a fallback) |

Not in CI: the Safari build. Run `npm run check` locally before pushing. See [Testing](Testing.md#ci).

## See also

- [Testing](Testing.md) · [Build and Release](Build-and-Release.md) · [Adding a Block](Adding-a-Block.md)
- [Learning: MAINTAINING.md](../learning/MAINTAINING.md) · [Usage guide](../guide/README.md)
- [Home](Home.md)
