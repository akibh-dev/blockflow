# Build and Release

How BlockFlow is built for Chrome, Firefox and Safari, what the generated manifest contains and why, where
the output goes, and the steps to ship a version. Read it when changing `wxt.config.ts`, adding a permission,
or preparing a store upload.

**Source:** [package.json](../../package.json) · [wxt.config.ts](../../wxt.config.ts) · [public/icon/](../../public/icon) ·
[tsconfig.json](../../tsconfig.json) · [.github/workflows/ci.yml](../../.github/workflows/ci.yml)

## npm scripts

| Script | Runs | Notes |
| --- | --- | --- |
| `postinstall` | `wxt prepare` | Generates `.wxt/` (types, `tsconfig.json` that ours extends, auto-import declarations). Runs on `npm install` |
| `dev` | `wxt` | Chrome with hot reload, temporary profile |
| `dev:firefox` | `wxt -b firefox` | Same for Firefox |
| `build` | `wxt build` | `.output/chrome-mv3/` |
| `build:firefox` | `wxt build -b firefox` | `.output/firefox-mv3/` |
| `build:safari` | `wxt build -b safari` | `.output/safari-mv3/`, then convert with Xcode (below) |
| `build:all` | the three builds in sequence | |
| `zip` | `wxt zip` | Builds and zips the Chrome build into `.output/` for store upload |
| `zip:firefox` | `wxt zip -b firefox` | Firefox zip, plus a sources zip WXT makes for AMO review |
| `typecheck` | `tsc --noEmit` | |
| `test` / `test:watch` | `vitest run` / `vitest` | See [Testing](Testing.md) |
| `e2e` | `BF_E2E=1 wxt build && node tests/e2e/run.mjs` | E2E build into `.output-e2e/`, then a real browser run. See [Testing](Testing.md#end-to-end-tests-testse2e) |
| `learn:sync` / `learn:check` | `node docs/learning/tools/sync-examples.mjs [--check]` | See [Tooling and Scripts](Tooling-and-Scripts.md) |
| `guide:sync` / `guide:check` | `vite-node scripts/guide.ts [-- --check]` | Generated block reference |
| `wiki:check` / `wiki:publish` | `node scripts/wiki.mjs --check` / `--push` | Wiki link check / publish to the Forgejo and GitHub wikis |
| `check` | `typecheck && test && learn:check && guide:check && wiki:check` | Run before every commit |

There is no `zip:safari`: Safari ships as an Xcode app, not a zip.

## wxt.config.ts

| Setting | Value | Why |
| --- | --- | --- |
| `srcDir` | `src` | Entry points live in `src/entrypoints/` |
| `outDir` | `.output-e2e` only when `BF_E2E=1` (default `.output`) | The test build never overwrites the one you load by hand |
| `modules` | `@wxt-dev/module-react` | React + JSX for the editor |
| `manifestVersion` | `3` | All browsers, including Firefox |
| `manifest` | function of `{ browser }` | Per-browser differences, below |

Name, description, `action.default_title` ("Open BlockFlow editor") and `host_permissions: ['<all_urls>']`
are the same everywhere. `version` comes from `package.json`. Icons are picked up by WXT from
`public/icon/{16,32,48,128}.png`.

### Entry points (what the build contains)

| Entry point | Becomes | Notes |
| --- | --- | --- |
| `background.ts` | `background.js` (service worker on Chrome, event page on Firefox) | [Background Worker](Background-Worker.md) |
| `editor/` | `editor.html` | Opened from the toolbar button. [Editor](Editor.md) |
| `offscreen/` | `offscreen.html` | DOM for parsing fetched HTML on Chrome. [Browser Host](Browser-Host.md) |
| `agent.content.ts`, `picker.content.ts`, `recorder.content.ts` | `content-scripts/*.js` | `registration: 'runtime'`: not in the manifest's `content_scripts` (which is empty), injected with `scripting.executeScript` when needed. [Page Agent](Page-Agent.md), [Picker and Recorder](Picker-and-Recorder.md) |

### Permissions

| Permission | Used for |
| --- | --- |
| `alarms` | Timers ≥ 30 s and the heartbeat ([Scheduling and Timers](Scheduling-and-Timers.md)) |
| `storage` | Workflows, runs, secrets, timers (`storage.local`); per-session tab data (`storage.session`). [Storage Keys](Storage-Keys.md) |
| `unlimitedStorage` | Screenshots and datasets in IndexedDB (`src/browser/blobStore.ts`) and run history in `storage.local` grow past the default quota |
| `tabs` | Open / update / close / query tabs, read URLs and titles, `captureVisibleTab` |
| `scripting` | Inject the page agent, picker and recorder |
| `notifications` | Notify block, Manual Step prompts with buttons |
| `webRequest` | Wait For response / request (per-tab logs, request bodies) and `networkidle` waiting (`src/browser/navigation.ts`) |
| `downloads` | Download block, Wait for Download (`downloads.search`) |
| `webNavigation` | Page Visited trigger, SPA URL changes, popup detection, frame ids for iframes |
| `contextMenus` | Context Menu trigger |
| `offscreen` | **Chrome/Safari only.** HTML parsing for Extract List/Table on fetched HTML. Firefox's background page has a DOM, so it is left out there |
| `debugger` (optional) | Real (trusted) mouse/keyboard input, background-tab, full-page and element screenshots, and response bodies via the Chrome DevTools Protocol (`src/browser/cdp.ts`, `screenshots.ts`, `navigation.ts`) |
| `cookies` (optional, Chrome and Firefox) | Cookies & Storage block on cookies (`src/browser/cookies.ts`). Regular in e2e builds |
| `userScripts` (optional) | Run Script block (Chrome 135+, also needs "Allow User Scripts" in `chrome://extensions`) |
| host `<all_urls>` | Watch/act on any site. Prototype choice; the comment in the config notes the plan to move to `optional_host_permissions` per workflow |

`debugger` and `userScripts` are **optional** on Chrome/Safari: the editor's `PermissionNote` component asks
for them with `permissions.request` only when a block needs them, and `cdp.ts` checks
`permissions.contains`. They show a scary install warning, so asking up front would hurt installs and review.

### Per-browser differences

| | Chrome (`chrome-mv3`) | Firefox (`firefox-mv3`) | Safari (`safari-mv3`) |
| --- | --- | --- | --- |
| `offscreen` permission | yes | no | yes (same branch as Chrome) |
| `optional_permissions` | `debugger`, `userScripts` | none: real input and Run Script are unavailable | same as Chrome (untested whether Safari honours them) |
| `browser_specific_settings` | none | `gecko.id: blockflow@akibh-dev`, `data_collection_permissions: { required: ['none'] }` (required for new AMO listings) | none |
| Background | service worker | event page (WXT) | per WXT |
| Host access | granted at install | user must grant site access after install (see README) | per Safari settings |
| E2E build (`BF_E2E=1`) | `debugger`, `userScripts` move to `permissions` | unchanged | `debugger`, `userScripts` move to `permissions` |

## Build outputs

| Folder | From | Gitignored |
| --- | --- | --- |
| `.output/chrome-mv3/` | `npm run build` | yes |
| `.output/firefox-mv3/` | `npm run build:firefox` | yes |
| `.output/safari-mv3/` | `npm run build:safari` | yes |
| `.output/*.zip` | `npm run zip`, `zip:firefox` | yes |
| `.output-e2e/chrome-mv3/`, `.output-e2e/playwright/` | `npm run e2e` | yes |
| `.wxt/` | `wxt prepare` | yes |

Load an unpacked build:

- **Chrome / Brave / Edge:** `chrome://extensions` → Developer mode → Load unpacked → `.output/chrome-mv3`.
- **Firefox:** `about:debugging` → This Firefox → Load Temporary Add-on → any file in `.output/firefox-mv3`.
  Then grant site access (Firefox MV3 does not grant host permissions automatically).
- **Safari:** `xcrun safari-web-extension-converter .output/safari-mv3`, build and run the generated app in
  Xcode, then enable it in Safari → Settings → Extensions. Not yet tried (README "What has been verified").

## Versioning

The single version is `version` in [package.json](../../package.json) (currently `0.1.0`); WXT copies it into
the manifest and the zip names. Every store upload needs a higher version. There is no changelog file or
release automation yet; workflow files carry their own `schemaVersion` (2 since v0.3; see `src/core/migrate.ts`), independent of the app version.

## Release steps

1. `npm run check` (and `npm run e2e` on a desktop machine).
2. Bump `version` in `package.json`.
3. `npm run zip` and `npm run zip:firefox` (Safari: `build:safari` + Xcode archive).
4. Upload: Chrome Web Store dashboard, addons.mozilla.org (with the sources zip), App Store Connect.
5. Review notes: explain `<all_urls>`, `debugger` and `userScripts`; BlockFlow sends no data off the device.

Store accounts, fees, privacy policy and review tips: [Lesson 8, Publishing](../learning/08-testing-debugging-publishing.md#publishing).

## See also

- [Tooling and Scripts](Tooling-and-Scripts.md) · [Testing](Testing.md)
- [Background Worker](Background-Worker.md) · [Browser Host](Browser-Host.md) · [Storage Keys](Storage-Keys.md)
- README: [Other browsers](../../README.md#other-browsers) · [What has been verified](../../README.md#what-has-been-verified)
- [WXT docs](https://wxt.dev)
