# Contributing to BlockFlow

Thanks for helping. This page covers how to set up, the rules the code follows, and what a change must
include before it is merged. For what each module does, see the [internals wiki](docs/wiki/Home.md).

## Set up

You need Node 22 (CI uses it) and a Chromium-based browser for `npm run dev` and the end-to-end tests.

```bash
npm install          # also runs `wxt prepare`, which generates .wxt/ types
npm run check        # typecheck + unit/DOM tests + learning examples + block guide + wiki links
npm run dev          # Chrome with hot reload (npm run dev:firefox for Firefox)
```

Load the dev build, open the editor, and walk through "Try it end to end" in the [README](README.md) with
`docs/manual-test/clock.html`.

## Rules of the codebase

[CLAUDE.md](CLAUDE.md) has the full list. The ones that break things if you miss them:

- **`src/core` stays free of browser APIs and DOM types.** Anything external goes through `Host`
  (`src/core/types.ts`). That is why the engine runs in plain Node tests.
- **No `setTimeout`/`setInterval` for workflow timing in blocks.** The MV3 service worker sleeps. Use
  `ctx.timers.set(...)` with `onTimer`, and keep anything a block must remember in `ctx.state`. Only
  `src/browser/hybridScheduler.ts` owns real timers. See [Scheduling and Timers](docs/wiki/Scheduling-and-Timers.md).
- **Payloads stay JSON-serialisable.** They are stored with alarms and run records.
- **Register every event listener synchronously** at the top of `defineBackground`.
- **Relative imports only, and `import type` for types** (`verbatimModuleSyntax` is on).
- **React Flow node `data` types are `type` aliases**, not interfaces.
- **`src/dom/*` runs inside web pages.** It may use the DOM and pure `src/core` modules, nothing else.
- **Page access goes through `ctx.host.page.act(...)`.** A new page ability means a new op in
  `src/core/page.ts`, an implementation in `src/dom/agent.ts` with a jsdom test, and then the block.

## Making a change

### Adding or changing a block

Follow [Adding a Block](docs/wiki/Adding-a-Block.md). In short: write the block in `src/core/blocks/`,
register it in `src/core/blocks/index.ts`, test it with `tests/helpers/fakeHost.ts`, run
`npm run guide:sync`, and keep `docs/guide/README.md` and its examples correct. The editor needs no changes.

### Docs that must move with the code

| You changed… | Also update |
| --- | --- |
| A block, or block config | `npm run guide:sync` (regenerates `docs/guide/blocks.*`), plus `docs/guide/README.md` if behaviour changed |
| Anything the learning course teaches or points at | The matching lesson in `docs/learning/` (read `MAINTAINING.md`), then `npm run learn:sync` |
| A module's API, a message, a storage key, a page op | The matching page in `docs/wiki/` |
| Design or a cross-cutting mechanism | `docs/ARCHITECTURE.md` |
| What has been tested in real browsers | README "What has been verified" |

Never hand-edit `docs/learning/examples/` or `docs/guide/blocks.*`. Both are generated.

### Tests

- Engine and blocks: `tests/core/*` against the fake host. No browser is needed.
- Page agent, locators, picker and recorder: `tests/dom/*` in jsdom.
- Editor model: `tests/editor/*`.
- End to end: `npm run e2e` builds with optional permissions granted and drives the extension in
  Brave/Chromium against `tests/fixtures/site`. Set `BF_BROWSER=/path/to/chrome` to choose the browser.

See [Testing](docs/wiki/Testing.md) for what each file covers and the fake host API.

## Before you open a pull request

- [ ] `npm run check` passes.
- [ ] `npm run build` and `npm run build:firefox` succeed.
- [ ] New behaviour has tests. Page changes have a jsdom test, and an e2e fixture where real browser behaviour matters.
- [ ] Docs are updated as described in the table above.
- [ ] You tried it in a real browser when it touches `src/browser`, `src/dom` or the editor, and you say in the PR what you tried.

Keep commits focused, and say *why* in the message. Work lands on `main` on Forgejo, which push-mirrors to GitHub, where CI runs.

## Publishing the wiki

`docs/wiki/` is published with `npm run wiki:publish` to both wikis: the Forgejo primary
(git.akibh.dev) and the GitHub mirror. Wikis aren't mirrored with the code, so the script handles each one
itself, rewriting links for that host. Edit the files in the repo, not either web wiki: each publish
overwrites them. `npm run wiki:check` (part of `npm run check`) fails on broken links. See
[Tooling and Scripts](docs/wiki/Tooling-and-Scripts.md).
