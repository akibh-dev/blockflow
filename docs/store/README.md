# Store listings and releasing

Everything needed to publish BlockFlow, except what needs a person and an account (marked **[HUMAN]**).

| File | What |
| --- | --- |
| [chrome.md](chrome.md) | Listing text written for the Chrome Web Store (**not published there**, see below); the long description and permission justifications are reused for AMO and the README |
| [firefox.md](firefox.md) | Firefox Add-ons (AMO) listing text, reviewer notes, known linter warnings |
| `screenshots/` | 1280×800 PNGs made by `npm run store:screenshots` (needs `BF_E2E=1 npx wxt build` first) |
| [../PRIVACY.md](../PRIVACY.md) | The privacy policy both listings link to, with every permission explained |
| `.github/workflows/release.yml` | Builds, checks, lints and zips on a `v*.*.*` tag; attaches the zips to a GitHub release; submits the version to AMO (with sources and `amo-metadata.json`) and uploads a Chrome draft when the secrets exist; publishes new npm package versions |
| `amo-metadata.json` | Licence and reviewer notes sent with every AMO submission |

## Release steps

1. On `main`: version in `package.json` (and `packages/*`) set, `CHANGELOG.md` updated, `npm run check` green.
2. `git tag -a v1.0.0 -m "BlockFlow 1.0.0" && git push origin v1.0.0` on Forgejo (not in the GitHub UI: tags made only
   on GitHub were removed by the mirror) → after the sync the release workflow runs on GitHub, and its `npm` job
   publishes any new npm package versions ([Build and Release](../wiki/Build-and-Release.md#release-steps)). The tag must equal the `package.json` version (the workflow checks). A pre-release tag
   such as `v1.0.0-alpha` or `v1.0.0-rc.1` passes when the part before `-` matches; its GitHub release is marked
   pre-release and nothing is uploaded to the stores (extension versions are numbers only, so `1.0.0` stays in
   `package.json`).
3. Download `blockflow-<version>-chrome.zip` and `…-firefox.zip` (+ `…-sources.zip`, which AMO asks for because the
   code is bundled) from the GitHub release.
4. Chrome, Edge, Brave: nothing to do. People download `blockflow-<version>-chrome.zip` from the GitHub release
   and load it unpacked (README "Install").
5. Firefox: with `AMO_JWT_*` the workflow submits the version (listed channel, sources zip, `amo-metadata.json`);
   Mozilla reviews it and publishes it on addons.mozilla.org. Listing text: [firefox.md](firefox.md).

**Chrome Web Store: not used** (decision 2026-11-11). Registering costs a fee, and BlockFlow is free; the Chrome
build ships as a zip on each GitHub release instead. Consequences: no automatic updates in Chrome (download the new
zip and press the reload button in `chrome://extensions`), and Developer mode must be on.

## One-time setup [HUMAN]

- Firefox Add-ons account; API credentials (JWT issuer and secret) under Tools → Manage API Keys.
- Repository secrets `AMO_JWT_ISSUER`, `AMO_JWT_SECRET` (set). Without them the workflow still builds and creates
  the GitHub release.
- Fill the AMO data-usage form from [../PRIVACY.md](../PRIVACY.md) (no data collected; everything local).
- Safari: needs a Mac and an Apple developer account, see [../SAFARI.md](../SAFARI.md).
