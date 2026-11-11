# Firefox Add-ons (AMO) listing

**Name:** BlockFlow  **Add-on id:** `blockflow@akibh-dev`  **Categories:** Developer Tools, Other

**Summary** (limit 250 characters):

> Playwright-compatible automation in your browser. Build tests, form fillers, scrapers and monitors from connected blocks or short JSON scripts, and run them with your own logins. Everything stays on your device.

**Description:** use the detailed description in [chrome.md](chrome.md), leaving out the Chromium-only paragraph
details that do not apply: Firefox has no debugger-based features (real input, request mocking, emulation, HAR,
console capture, full-page and background-tab screenshots use `captureTab` instead, Clear Site Data).

**Privacy policy:** `docs/PRIVACY.md`. Data collection (the manifest declares `data_collection_permissions:
required: ["none"]`): none.

## Notes for the reviewer (paste into "Notes to reviewer")

- The package is built with WXT (Vite). `blockflow-<version>-sources.zip` contains the sources;
  `npm ci && npm run build:firefox` reproduces `.output/firefox-mv3` with Node 22.
- No remote code, no analytics, no network request of its own. Network requests are only those the user's
  workflows make.
- `innerHTML` warnings from the linter: `src/dom/picker.ts` and `src/dom/recorder.ts` set `shadow.innerHTML`
  to **constant** strings (their own style and toolbar markup) inside a closed shadow root; React (in the
  editor chunk) uses `innerHTML` internally for its own elements. No page or user content is assigned.
- Site access is **optional** and requested per workflow; no `host_permissions` at install.
- Request rules (`declarativeNetRequest`, **required on Firefox**): the Route block's block/redirect rules.
  Firefox does not accept this permission as optional (see the linter note below), so the Firefox build declares
  it at install; Firefox shows it as "Block content on any page". It is used only while a Route block runs: the
  rules are session rules limited to the workflow's tab and are removed when the run ends. It gives no access to
  page content, and redirects still need the site access the workflow was granted. Chrome keeps it optional.
- Native messaging (`nativeMessaging`, optional): only used when the user switches on "Allow outside control",
  to talk to a local helper (`blockflow-bridge`) the user installs; off by default.

## Known linter output (`npm run lint:firefox`: 0 errors, 6 warnings)

- 6× `UNSAFE_VAR_ASSIGNMENT` (innerHTML, explained above).
- (Gone since 1.0.0: `MANIFEST_OPTIONAL_PERMISSIONS` for `declarativeNetRequest`. Firefox does not accept that
  permission as optional, so as an optional one the Route block's browser rules could never be granted on the
  store build. It is now a required permission in the Firefox build only; see "Permissions" above.)

## Images

The same screenshots as Chrome (`screenshots/`). **[HUMAN]** Firefox screenshots of the Firefox build are better
if time allows.
