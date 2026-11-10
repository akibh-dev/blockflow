# M5 parallel implementation contract

Base: branch `m5-debugging` from `m4-outside-access` (M4 not merged yet), groundwork commit `182cecd`.
Read CLAUDE.md, the M5 section of docs/IMPLEMENTATION.md, and the groundwork: `src/core/engine.ts`
(`runOnce(options)`, `debugPause`, trace hooks, `runFrom`), `src/core/types.ts` (`StepSettings.pause/trace`,
`Host.debug`, `Host.trace`, `DebugPause`, `TraceStepInfo`), `src/core/runs.ts` (`StepTrace`, `RunOptions`,
`RunRecord.mode`), `tests/core/engineM5.test.ts`, and `bf:run-workflow` `options` in `src/shared/messages.ts`
(the background already passes them to `runOnce`). Agents do not commit. `src/core` stays free of browser APIs.

## Shared rules (as in M4)

- Root owns: `src/core/engine.ts`, `src/core/types.ts`, `src/core/runs.ts`, `src/shared/keys.ts`, `Editor.tsx`
  (header buttons/nav), `package.json`, `wxt.config.ts`, `tests/e2e/harness.mjs`, the learning lessons, plan/status
  docs. Ask root (in your report) for changes there; small additive exports are fine if unavoidable — say so.
- Shared files two agents touch: `src/browser/host.ts` (each wires its own Host hook into `createExtensionHost` /
  `forRun`), `src/core/page.ts` + `src/dom/agent.ts` (agent 1 only), `src/entrypoints/editor/style.css` (append
  only). Re-read before every edit; keep edits small and local.
- Builds for your checks: `BF_OUT_DIR=.output-<you> BF_E2E=1 npx wxt build`, e2e with
  `BF_HEADLESS=1 BF_EXTENSION_DIR=.output-<you>/chrome-mv3 node tests/e2e/run.mjs <spec>`. Never the default folders.
- New/changed blocks or step settings: `npm run guide:sync` and keep `npm run check` green. Update the wiki pages
  for your files (`npm run wiki:check`). Don't run npm install. Report exact commands and what ran in a real browser.
- Storage keys you add: name them in your report (root adds them to keys.ts / Storage-Keys.md if you can't).

## Ownership and interfaces

1. **Trace (M5.1)** — `src/browser/trace.ts` (implements `Host.trace`), `src/core/page.ts` + `src/dom/agent.ts`
   (new page ops `box` → bounding box of a locator's element in CSS px of the viewport, and `highlight` → outline
   overlay on the element, cleared by `highlight` with `clear: true` or after `ms`; jsdom tests), trace storage
   bounds in `src/browser/blobStore.ts` (per-run cap, oldest runs' trace images evicted first; documented limits),
   `src/entrypoints/editor/components/ReportsPage.tsx` (timeline: step list + filmstrip of before/after with the box
   drawn over the after image, URL, network summary; works for any run with `step.trace`), report export: HTML
   report shows the trace images when embedded screenshots are on (`src/core/report.ts`, keep JSON schema in sync),
   `tests/browser/trace.test.ts`, `tests/dom/*` for the ops, e2e `tests/e2e/specs/m5-trace.mjs`.
   - `before`: screenshot of the step's tab (reuse `src/browser/screenshots.ts`) when `tabId` is set; skip quietly
     otherwise. `after`: screenshot + `box` (if `locator`) + URL + network summary from the M3 telemetry when CDP is
     already attached (never attach the debugger just for tracing).
   - Wire `trace` into the run-scoped Host in `host.ts`. Leave a `<VisualComparePanel step={step} />` slot comment
     in the step details of ReportsPage where agent 3 can mount its panel (agent 3 exports it; root mounts).
2. **Debug + Run from here (M5.2, M5.5)** — `src/browser/debugChannel.ts` (implements `Host.debug`: stores the pause
   in `storage.session` `bf:debug-pause`, resolves on a `bf:debug-answer` message from the editor, highlights the
   element with agent 1's `highlight` op while paused (code against the contract if it isn't there yet), keeps the
   MV3 worker alive while paused, Stop/run-end cleans up, a pause with no editor open still works when the editor
   opens later), `src/shared/messages.ts` (append `bf:debug-answer`), `src/entrypoints/background.ts` (only the
   message case), `src/entrypoints/editor/components/DebugBanner.tsx` (export `DebugBanner`, no props: paused step,
   reason, error, current input, Continue / Step / Stop), `ConfigPanel.tsx` step settings: "Pause here (breakpoint)"
   and "Trace this step" toggles, and a **Run from here** button for the selected block (uses that step's input from
   the workflow's last run that reached it; disabled with a hint otherwise; sends `bf:run-workflow` with
   `options.startAt`), suites "re-run failed" (`src/browser/suites.ts`: run only given workflow ids,
   `SuitesPage.tsx`: button on the last result), `tests/browser/debugChannel.test.ts`, `tests/browser/suites.test.ts`
   additions, e2e `tests/e2e/specs/m5-debug.mjs`. Export the editor header controls you need as a component
   `RunControls` (props: `{ onRun(options: RunOptions): void; running: boolean }` — Run, Run with trace, Debug,
   "pause on error" checkbox); root mounts it in `Editor.tsx`. Bridge: accept `options` (trace/debug) on the
   `run` method only if trivial (`src/browser/bridgeHandlers.ts`); MCP/CLI unchanged.
3. **Visual comparison (M5.3)** — `src/core/pixelDiff.ts` (pure: RGBA arrays → diff count, ratio, diff image RGBA;
   per-pixel threshold like pixelmatch, anti-aliasing tolerance optional, mask rectangles), Screenshot block
   options (`src/core/blocks/screenshot.ts`: `compare`, `threshold`, `maxDiffRatio`, `mask` rectangles or locators,
   `updateBaseline`), `Host.visual` if the block needs a new Host method (ask root to add the type; until then
   declare it in your report), `src/browser/visual.ts` (baselines per (workflow id, node id) in IndexedDB, decode
   PNG via `createImageBitmap` + `OffscreenCanvas` in the worker (Firefox: background page; check both), first run
   stores the baseline and passes, later runs fail with `visual.mismatch` (add the error code to
   `src/core/errors.ts` and the guide's error table), diff image saved like a screenshot), "Accept new baseline"
   (editor → message → store), `src/entrypoints/editor/components/VisualComparePanel.tsx` (export
   `VisualComparePanel({ step })`: baseline / actual / diff, ratio, Accept), Playwright export mapping
   (`toHaveScreenshot`), tests `tests/core/pixelDiff.test.ts`, `tests/browser/visual.test.ts`, e2e
   `tests/e2e/specs/m5-visual.mjs` (a fixture page whose look changes by query string).
4. **ARIA snapshot assert (M5.4)** — `src/core/ariaSnapshot.ts` (pure: parse an expected YAML-like template
   `- heading "Welcome" [level=1]`, `- button /Sign (in|up)/`, nested lists; match against the M1.3 outline with
   Playwright-like partial semantics: order kept, extra nodes allowed, children matched as a subsequence; useful
   diff message), Assert subject `aria-snapshot` (`src/core/blocks/assert.ts`: locator = the subtree root or the
   page, `expected` = template; retries like other asserts), Playwright export → `toMatchAriaSnapshot`, guide
   section + example, `tests/core/ariaSnapshot.test.ts`, a jsdom test that runs the real outline op on a fixture
   DOM, e2e `tests/e2e/specs/m5-aria.mjs`. Read how `snapshot` (M1.3) produces the outline (`src/dom/`, `src/core/page.ts`)
   and reuse it; do not edit page.ts/agent.ts (agent 1) — if you need an outline option without refs/locators,
   do the stripping in `ariaSnapshot.ts`, or ask root.

Root integrates: Editor header (`RunControls`), `DebugBanner` and `VisualComparePanel` mounting, keys, the
learning lesson, guide/README/IMPLEMENTATION status, a combined e2e pass in Chromium and Firefox, version 0.6.0.
