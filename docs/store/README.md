# Store listings and releasing

Everything needed to publish BlockFlow, except what needs a person and an account (marked **[HUMAN]**).

| File | What |
| --- | --- |
| [chrome.md](chrome.md) | Chrome Web Store listing text, single purpose, permission justifications, data-usage answers |
| [firefox.md](firefox.md) | Firefox Add-ons (AMO) listing text, reviewer notes, known linter warnings |
| `screenshots/` | 1280×800 PNGs made by `npm run store:screenshots` (needs `BF_E2E=1 npx wxt build` first) |
| [../PRIVACY.md](../PRIVACY.md) | The privacy policy both listings link to, with every permission explained |
| `.github/workflows/release.yml` | Builds, checks, lints and zips on a `v*.*.*` tag; attaches the zips to a GitHub release; signs (AMO) and uploads a draft (Chrome) when the secrets exist |

## Release steps

1. On `main`: version in `package.json` (and `packages/*`) set, `CHANGELOG.md` updated, `npm run check` green.
2. `git tag v1.0.0 && git push origin v1.0.0` (or publish a release with a new tag in the GitHub UI) → the
   release workflow runs. The tag must equal the `package.json` version (the workflow checks). A pre-release tag
   such as `v1.0.0-alpha` or `v1.0.0-rc.1` passes when the part before `-` matches; its GitHub release is marked
   pre-release and nothing is uploaded to the stores (extension versions are numbers only, so `1.0.0` stays in
   `package.json`).
3. Download `blockflow-<version>-chrome.zip` and `…-firefox.zip` (+ `…-sources.zip`, which AMO asks for because the
   code is bundled) from the GitHub release.
4. Chrome: with the `CWS_*` secrets the workflow already uploaded a draft; otherwise upload the zip in the
   dashboard. Fill the listing from [chrome.md](chrome.md), add the screenshots, submit for review.
5. Firefox: upload the Firefox zip and the sources zip in the AMO developer hub, listing from
   [firefox.md](firefox.md). With `AMO_JWT_*` the workflow also runs `web-ext sign` (listed channel).

## One-time setup [HUMAN]

- Chrome Web Store developer account (one-time fee), create the item once by hand (the API can only update an
  existing item), note the extension id.
- Firefox Add-ons account; API credentials (JWT issuer and secret) under Tools → Manage API Keys.
- Repository secrets: `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`, `CWS_EXTENSION_ID`,
  `AMO_JWT_ISSUER`, `AMO_JWT_SECRET`. Without them the workflow still builds and creates the GitHub release.
- Fill both stores' data-usage forms from [../PRIVACY.md](../PRIVACY.md) (no data collected; everything local).
- Safari: needs a Mac and an Apple developer account, see [../SAFARI.md](../SAFARI.md).
