# Changelog

BlockFlow versions, newest first. Each entry lists what a user or an integrator can do that they could not
before; the task-level history is in [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) and `git log`. Versions
follow the milestones of [docs/PLAN.md](docs/PLAN.md).

## Unreleased

- **No Chrome Web Store.** Chrome, Edge and Brave install the release's Chrome zip unpacked (README "Install");
  the release workflow no longer has a Chrome Web Store step. Firefox stays on addons.mozilla.org.

## npm: blockflow-bridge 1.0.1, blockflow-mcp 1.0.1

- `bin` paths without `./`, so npm 11 publishes them without a warning (same commands as 1.0.0). The MCP server
  depends on bridge 1.0.1. First bridge and MCP versions published by the release workflow (trusted publishing,
  with provenance). The extension and `blockflow-runner` are unchanged (1.0.1).

## 1.0.1: Release fixes

- **MIT licence** for the whole repository (`LICENSE`); the npm packages were already MIT. The sources zip of a
  release now contains it.
- Exported reports' `$schema` and the JSON schemas' `$id` point at the real files
  (`raw.githubusercontent.com/akibh-dev/blockflow/main/docs/guide/…`) instead of an old repository owner.
- Releases: pre-release tags (`v1.0.1-rc.1`) are accepted, marked pre-release and kept out of the stores.
- CI and releases on Node 26 (LTS) with the current GitHub Actions; the lock file matches the renamed
  `blockflow-runner` package.
- npm `bin` paths are written without `./` (`cli.mjs`): npm 11 warns that it removes `./cli.mjs`. The published
  `blockflow-runner` 1.0.1 still installs its `blockflow` command, but the plain form avoids the warning.
  `tests/bridge/packageBins.test.ts` checks it.
- npm: **`blockflow-runner` 1.0.1** bundles the 1.0.1 extension and is the first version published by the release
  workflow (trusted publishing); `blockflow-bridge` and `blockflow-mcp` are unchanged (1.0.0).

## 1.0.0: Ship

- **Encrypted secrets.** Protect `{{secret.name}}` values with a passphrase (AES-GCM, key from PBKDF2 with
  600 000 iterations, kept only in session storage). A locked browser fails runs that use secrets with
  `secrets.locked` instead of running with empty values. "No passphrase" mode still works, with a warning.
- **Site access per workflow.** The store build asks for no site at install. Running or switching on a workflow
  asks for the sites it uses ("Grant access"); background runs without access fail with `permission.missing`
  naming the site. Privacy policy and every permission explained: [docs/PRIVACY.md](docs/PRIVACY.md).
- **Settings → Limits.** Run history, log lines, screenshots kept and blocks per run are configurable.
- **Faster big workflows.** The canvas draws only the blocks in view: a 500-block workflow opens in about
  2.4 s instead of 3.8–4.9 s.
- **Safari build** without the APIs Safari lacks, with clear `permission.missing` messages
  ([docs/SAFARI.md](docs/SAFARI.md); not verified on a Mac).
- **Releases.** A tag builds, checks, lints (Firefox) and zips both stores' packages, attaches them to a GitHub
  release and, with secrets, signs and uploads. Listing text and screenshots: [docs/store/](docs/store/).
- **npm packages**: `blockflow-bridge`, `blockflow-mcp` and `blockflow-runner` (the CLI; `blockflow-cli` on npm is an
  unrelated package). The runner bundles the extension's automation build, so `npx blockflow-runner run tests/`
  works without a checkout.
- **Firefox** asks for `declarativeNetRequest` at install ("Block content on any page"): Firefox does not allow it
  as an optional permission, and without it the Route block could not block or redirect there.
- Docs: lesson 10 (the DevTools Protocol), wiki pages for every module added since 0.4.

## 0.6.0: Debugging and visual

- **Trace timeline.** Run with trace (or "Trace this step"): before/after pictures of every page step, the
  element's box, the URL and a network summary, as a filmstrip in Reports and in the HTML export.
- **Breakpoints.** "Pause here" and a 🐞 Debug run with Continue / Step / Stop, the element highlighted while
  paused, "pause on error". A pause survives closing the editor. **Run from here** and **Re-run failed** (suites).
- **Visual comparison.** The Screenshot block compares against a baseline (masks, threshold, "Accept new
  baseline", diff image); failures are `visual.mismatch`. Exports to `toHaveScreenshot`.
- **ARIA snapshot assert** with Playwright-style partial templates; exports to `toMatchAriaSnapshot`.

## 0.5.0: Network, environment and outside access

- **Route** mocks, blocks, redirects or changes requests (CDP, or browser rules on every browser for
  block/redirect). **HAR Record** (metadata only). **Emulate** a device, viewport, locale, timezone, location,
  color scheme, reduced motion or offline. **Clear Site Data** for exact origins. **Console capture** per
  step and Assert `console-errors`.
- **Outside control** (off by default): a native-messaging bridge (`blockflow-bridge`), an **MCP server**
  (`blockflow-mcp`) so an AI agent can snapshot, validate, run and repair workflows in your browser, and the
  **`blockflow` CLI** that runs workflows and suites in Chromium for CI with JUnit/JSON/HTML reports.
- **Suites**: ordered workflows with one combined JUnit/HTML/JSON report.
- Run-scoped debugger sessions: one attachment per tab per run, released on every exit path.

## 0.4.0: Playwright essentials

- Locator filters and role states, click options (button, modifiers, position, count), Element Action, Drag and
  drop zones, key chords, insert-text.
- **Wait for Download**, a **Screenshot** block (visible, full page, element), **Cookies & Storage**,
  Wait For request and response bodies, Switch, Repeat until, more Assert subjects (class, css, focused, editable,
  in-viewport, accessible name and description).

## 0.3.0: Script-first

- Workflows as short **JSON scripts** (a list of steps) with strict import, error codes with JSON paths and
  hints so a model can repair its own file; `llms.txt`, a usage guide and generated block reference and schemas.
- Page snapshot for authoring, coded step errors, a versioned JSON report, export to Playwright tests.

## 0.2.0: Stabilise

- Real-input clicks in iframes, picker and recorder through shadow DOM and iframes, popup recording, secret
  naming in recordings, Playwright export fixes, first-run onboarding.
- Run history and timers hardened (timed-out steps fenced off, live runs keep the worker awake, long delays
  survive worker restarts), e2e coverage of every block in Chromium and Firefox, CI.

## 0.1.0: Prototype

- Connectable blocks on a canvas (React Flow), a background engine, timers and Watch Element, the element
  picker and recorder, run log and reports. Chrome, Firefox and Safari builds from one codebase (WXT).
