# BlockFlow: notes for Claude Code

Browser extension (Chrome, Firefox, Safari) for building automations from connectable blocks, n8n style.
WXT + React + TypeScript + React Flow. Read `README.md` for the product and `docs/ARCHITECTURE.md` for design.

## Commands

```bash
npm install            # runs `wxt prepare` (generates .wxt/ types)
npm run typecheck      # tsc --noEmit
npm test               # vitest run (core + editor in Node, tests/dom in jsdom)
npm run check          # typecheck + tests + learning examples in sync
npm run e2e            # build + drive the real extension in Brave/Chromium (tests/e2e, fixtures in tests/fixtures/site)
npm run learn:sync     # regenerate docs/learning/examples from the lessons (learn:check verifies)
npm run dev            # Chrome with hot reload; `npm run dev:firefox` for Firefox
npm run build / build:firefox / build:safari
```

## First thing to do on a fresh checkout (prototype 1 status)

Prototype 1 was written where npm was blocked, so it was verified only partially (see README
"What has been verified"). On a machine with network access:

1. `npm install`, then `npm run typecheck`. Expect a few type errors in `src/browser/*` and
   `src/entrypoints/editor/*`, which were checked against stubs, not real WXT / React Flow types. Fix them.
2. `npm test`. Core, editor-model and DOM tests passed in the authoring environment (DOM tests under real
   Chromium, not jsdom). If a jsdom test fails, suspect jsdom differences (selector engine, `composedPath`)
   before suspecting the code.
3. `npm run build` and `npm run build:firefox`.
4. `npm run dev`, then walk through "Try it end to end" in the README using `docs/manual-test/clock.html`.
5. Done 2026-10-20 on the real WXT Chrome build (see README "What has been verified"): picker injection,
   Watch Element, short/long timers, worker restart mid-run. Still never run: Firefox host permission grant,
   Safari conversion.

## Rules of the codebase

- `src/core` must stay free of browser APIs and DOM types. Anything it needs from the outside goes
  through `Host` (`src/core/types.ts`). That is what keeps the engine unit-testable.
- Use `import type` for type-only imports (`verbatimModuleSyntax` is on).
- Relative imports only. No path aliases (the Node test runner and WXT must agree).
- Never use `setTimeout`/`setInterval` in blocks for workflow timing: the MV3 worker sleeps. Use
  `ctx.timers.set(...)` and handle it in `onTimer`. Keep anything a block must remember in `ctx.state`.
  (Timers under 30s are handled for you by `HybridScheduler`: in-memory timers + keep-alive ping, alarm as heartbeat.
  Only `src/browser/hybridScheduler.ts` may use `setTimeout`/`setInterval` for timers, via its injected `Clock`.
  Short polling inside one step, in `src/browser` (`sleep` from `tabs.ts`) or in the page agent, is fine;
  the engine waits through `Host.sleep`.)
- Block payloads must stay JSON-serialisable (they are stored with alarms).
- Register all event listeners synchronously at the top of `defineBackground` (service worker rule).
- WXT auto-imports `defineBackground` / `defineContentScript`; `browser` is imported from `wxt/browser`.
- React Flow node `data` types must be `type` aliases, not interfaces (see `BlockNodeData`).
- Add or change a block: edit `src/core/blocks/`, register in `index.ts`, test with `tests/helpers/fakeHost.ts`.
  The editor needs no changes.
- Blocks that touch a page go through `ctx.host.page.act(tabId, request, …)` (requests in `src/core/page.ts`,
  carried out by `src/dom/agent.ts`), and find their tab with `requireSessionTab(input, ctx.config.tab)`.
  New page abilities: add an op to `page.ts`, implement it in `agent.ts` with a jsdom test, then the block.
- `src/dom/*` runs inside web pages: DOM only, `import type` from elsewhere.

## Learning material (keep it current)

`docs/learning/` is a hand-coding course for the project owner, who knows React/Next.js/SaaS but is new to
extensions and wants to write their own extension by hand. **While you build or change things here, also write
or update the matching lesson in the same change.** Read `docs/learning/MAINTAINING.md` first; the short version:

- Lessons are numbered `NN-*.md`; start at `docs/learning/README.md`. Plain JS for lessons 1 to 5, WXT/React/TS after.
- Code fences with `file=<example>/<name>` in a lesson are the source of truth for `docs/learning/examples/`.
  After editing a lesson run `node docs/learning/tools/sync-examples.mjs`; `--check` must pass. Never hand-edit `examples/`.
- Verify examples by loading them in real Chromium before claiming they work; mark unverified lessons with a `> **Status:**` note.
- Match concepts to the owner's web-dev background first, then show the extension-specific difference.
  End lessons with a checkpoint, exercises and an "In BlockFlow" pointer to real files.

## Where things are

See the layout in `README.md`. Entry points: `src/entrypoints/background.ts` (runs workflows),
`src/entrypoints/editor/` (UI), `src/entrypoints/picker.content.ts` (element picker, injected on demand).
