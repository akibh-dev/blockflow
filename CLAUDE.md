# BlockFlow: notes for Claude Code

Browser extension (Chrome, Firefox, Safari) for building automations from connectable blocks, n8n style.
WXT + React + TypeScript + React Flow. Read `README.md` for the product and `docs/ARCHITECTURE.md` for design.

## Commands

```bash
npm install            # runs `wxt prepare` (generates .wxt/ types)
npm run typecheck      # tsc --noEmit
npm test               # vitest run (core + editor in Node, tests/dom in jsdom)
npm run check          # both
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
5. Confirm the things that were never run for real: alarms firing and restarting the flow, the picker
   injection (`/content-scripts/picker.js` path), Watch Element reading a background tab, Firefox host
   permission grant, Safari conversion.

## Rules of the codebase

- `src/core` must stay free of browser APIs and DOM types. Anything it needs from the outside goes
  through `Host` (`src/core/types.ts`). That is what keeps the engine unit-testable.
- Use `import type` for type-only imports (`verbatimModuleSyntax` is on).
- Relative imports only. No path aliases (the Node test runner and WXT must agree).
- Never use `setTimeout`/`setInterval` for workflow timing: the MV3 worker sleeps. Use
  `ctx.timers.set(...)` and handle it in `onTimer`. Keep anything a block must remember in `ctx.state`.
- Block payloads must stay JSON-serialisable (they are stored with alarms).
- Register all event listeners synchronously at the top of `defineBackground` (service worker rule).
- WXT auto-imports `defineBackground` / `defineContentScript`; `browser` is imported from `wxt/browser`.
- React Flow node `data` types must be `type` aliases, not interfaces (see `BlockNodeData`).
- Add or change a block: edit `src/core/blocks/`, register in `index.ts`, test with `tests/helpers/fakeHost.ts`.
  The editor needs no changes.

## Where things are

See the layout in `README.md`. Entry points: `src/entrypoints/background.ts` (runs workflows),
`src/entrypoints/editor/` (UI), `src/entrypoints/picker.content.ts` (element picker, injected on demand).
