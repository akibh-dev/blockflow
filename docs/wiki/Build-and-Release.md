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
| `debugger` (optional, again) | Route mocking (`Fetch`), Emulate (`Emulation.*`), HAR Record and console capture (`Network.*`, `Runtime.*`) (`src/browser/routes.ts`, `environment.ts`, `telemetry.ts`) |
| `declarativeNetRequest` (optional on Chrome; required on Firefox, which rejects it as optional) | Route with browser rules: tab-scoped session rules that block or redirect (`src/browser/routes.ts`) |
| `browsingData` (optional, Chrome/Safari only) | Clear Site Data by exact origin (`src/browser/environment.ts`). Left out on Firefox, whose `browsingData` cannot filter every data type by origin |
| `optional_host_permissions` `<all_urls>` | Site access, asked **per workflow** (`src/core/origins.ts` works out the sites; `src/entrypoints/editor/hostAccess.ts` asks when you Run or switch on). The store build has **no** `host_permissions`: a `build:manifestGenerated` hook in `wxt.config.ts` removes the ones WXT copies from the runtime content scripts. e2e and automation builds keep `<all_urls>` granted; `BF_E2E_NO_HOSTS=1` builds the e2e build without it (`.output-e2e-nohosts`). See [PRIVACY](../PRIVACY.md) |

`debugger` and `userScripts` are **optional** on Chrome/Safari: the editor's `PermissionNote` component asks
for them with `permissions.request` only when a block needs them, and `cdp.ts` checks
`permissions.contains`. They show a scary install warning, so asking up front would hurt installs and review.

### Per-browser differences

| | Chrome (`chrome-mv3`) | Firefox (`firefox-mv3`) | Safari (`safari-mv3`) |
| --- | --- | --- | --- |
| `offscreen` permission | yes | no | yes (same branch as Chrome) |
| `optional_permissions` | `debugger`, `userScripts`, `cookies`, `declarativeNetRequest`, `browsingData` | `cookies`, `nativeMessaging`; `declarativeNetRequest` is in `permissions` (Firefox does not accept it as optional). Real input, Run Script and the CDP features are unavailable | same as Chrome (untested whether Safari honours them) |
| `browser_specific_settings` | none | `gecko.id: blockflow@akibh-dev`, `data_collection_permissions: { required: ['none'] }` (required for new AMO listings) | none |
| Background | service worker | event page (WXT) | per WXT |
| Host access | granted at install | user must grant site access after install (see README) | per Safari settings |
| E2E build (`BF_E2E=1`) | `debugger`, `userScripts`, `cookies`, `declarativeNetRequest`, `browsingData` move to `permissions` | `cookies`, `declarativeNetRequest` move to `permissions` | same as Chrome |

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

Two kinds of version, each bumped on its own:

- **The extension**: `version` in [package.json](../../package.json). WXT copies it into the manifest and the zip
  names; every store upload needs a higher one. Numbers only (stores reject `1.0.1-rc.1`); a release tag is `v` +
  this version, optionally with a pre-release suffix (`v1.0.1-rc.1`).
- **The npm packages**: `version` in `packages/bridge`, `packages/mcp`, `packages/cli` (`blockflow-bridge`,
  `blockflow-mcp`, `blockflow-runner`). Bump one only when its code changed. `blockflow-runner` bundles the
  extension's automation build, so bump it too when a new extension version should reach CLI users; `mcp` and
  `cli` pin `blockflow-bridge` exactly, so a new bridge version needs their dependency updated.

Changes per version: [CHANGELOG.md](../../CHANGELOG.md). Workflow files carry their own `schemaVersion` (2 since
v0.3; see `src/core/migrate.ts`), independent of both.

## Release steps

1. On `main`: bump the version(s), update `CHANGELOG.md`, `npm run check` green (and `npm run e2e` on a desktop
   machine).
2. Tag on Forgejo: `git tag -a v1.0.1 -m "BlockFlow 1.0.1" && git push origin v1.0.1`. The sync copies the tag
   to GitHub. Do not tag in the GitHub UI: on 2026-11-11 tags made only on GitHub disappeared, with their releases
   (most likely the mirror removing refs Forgejo does not have).
3. [`release.yml`](../../.github/workflows/release.yml) runs on GitHub:
   - job `release`: checks the tag against `package.json`, `npm run check`, builds, lints Firefox, zips, attaches
     `blockflow-<version>-{chrome,firefox,sources}.zip` to the GitHub release. With the AMO secrets it submits the
     version to addons.mozilla.org (listed, with the sources zip and the reviewer notes and licence of
     [docs/store/amo-metadata.json](../../docs/store/amo-metadata.json); it does not wait for the review); with
     the Chrome secrets it uploads a draft. Pre-release tags: release marked pre-release, no store steps.
   - job `npm` (not for pre-release tags): `npm run build:automation`, then publishes each package whose version
     is not on npmjs.com yet, `blockflow-bridge` first. Nothing new → nothing published.
   - **npm without a new extension version** (a package fix): bump that package's version on `main`, then on GitHub
     **Actions → Release → Run workflow** (branch `main`). Only the `npm` job runs, with `npm run check` first.
4. Stores: submit in the dashboards ([docs/store/README.md](../../docs/store/README.md)); Safari: `build:safari` + Xcode.

### Firefox Add-ons (one-time setup)

1. The first version is submitted by hand (done for 1.0.0); later versions go through `release.yml`. The add-on
   is matched by its id `blockflow@akibh-dev` (manifest `browser_specific_settings.gecko.id`).
2. Create API credentials at <https://addons.mozilla.org/developers/addon/api/key/> (a JWT issuer and secret).
3. Add them as GitHub repository secrets (Settings → Secrets and variables → Actions, or
   `gh secret set AMO_JWT_ISSUER -R akibh-dev/blockflow` and the same for `AMO_JWT_SECRET`).
4. The step runs `web-ext sign --channel listed --upload-source-code … --amo-metadata docs/store/amo-metadata.json
   --approval-timeout 0`. A failed review or a validation error shows in the run log and in the AMO dashboard.
   Keep `amo-metadata.json`'s notes current when permissions or build steps change.

### npm trusted publishing (one-time setup)

The `npm` job publishes without a token: npmjs.com trusts this workflow through OIDC (`id-token: write`) and adds
[provenance](https://docs.npmjs.com/generating-provenance-statements) (the repository is public). For **each** of
the three packages, on npmjs.com → the package → **Settings** → **Trusted Publisher** → **GitHub Actions**:

| Field | Value |
| --- | --- |
| Organization or user | `akibh-dev` |
| Repository | `blockflow` |
| Workflow filename | `release.yml` |
| Environment name | (empty) |

The fields are case-sensitive and must match exactly, and each package's `repository.url` must be
`git+https://github.com/akibh-dev/blockflow.git` (it is). npm checks the settings only at the first publish, and a
new trusted publisher that has not published within 2 days expires. Afterwards, **Settings → Publishing access →
"Require two-factor authentication and disallow tokens"** blocks token publishing without affecting the
workflow. Needs npm 11.5.1+ (Node 26 ships 11.20) and a GitHub-hosted runner. Write `bin` paths without `./`
(`"blockflow": "cli.mjs"`): npm 11 drops `./cli.mjs` from the published package (it did for `blockflow-runner`
1.0.1); `tests/bridge/packageBins.test.ts` checks it.

Store accounts, fees, privacy policy and review tips: [Lesson 8, Publishing](../learning/08-testing-debugging-publishing.md#publishing).

## See also

- [Tooling and Scripts](Tooling-and-Scripts.md) · [Testing](Testing.md)
- [Background Worker](Background-Worker.md) · [Browser Host](Browser-Host.md) · [Storage Keys](Storage-Keys.md)
- README: [Other browsers](../../README.md#other-browsers) · [What has been verified](../../README.md#what-has-been-verified)
- [WXT docs](https://wxt.dev)
