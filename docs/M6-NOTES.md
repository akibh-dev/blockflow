# M6 notes: what was built, what was not verified, what differs from the plan

Written at the end of M6 (see [M6-PLAN.md](M6-PLAN.md) for the plan). Version **1.0.0**, branch `m6-ship`.

## Per task

| Task | Commits | What |
| --- | --- | --- |
| M6.1 Encrypted secrets | `M6.1a`–`M6.1d` | `src/browser/secretVault.ts`, Host decrypts, locked runs fail (`secrets.locked`), Secrets page states, e2e `m6-secrets` |
| M6.2 Site access per workflow | `M6.2a`–`M6.2d` | `src/core/origins.ts`, store manifest without `host_permissions`, `hostAccess.ts` + `HostAccessNote`, `permission.missing` naming the site, `docs/PRIVACY.md`, e2e `m6-hosts` (needs `BF_E2E_NO_HOSTS=1`), `docs/manual-test/M6-permissions.md` |
| M6.3 Safari | `M6.3` | manifest without unsupported permissions, guards tested (`tests/browser/safariGuards.test.ts`), Settings note, CI builds Safari, `docs/SAFARI.md` |
| M6.4 Store releases | `M6.4a`, `M6.4b` | `release.yml`, `npm run lint:firefox` (+ CI), `docs/store/*`, `npm run store:screenshots` and 5 PNGs |
| M6.5 Performance and limits | `M6.5a`, `M6.5b` | `src/core/limits.ts` + Settings → Limits, `onlyRenderVisibleElements` (open 3.8–4.9 s → 2.4 s), e2e `m6-perf`, large For Each test |
| M6.6 Docs | `M6.6` | lesson 10 (verified in Chromium), `sync.ts` and view documentation in the Editor wiki, `CHANGELOG.md` |
| M6.7 Release | `M6.7` | versions 1.0.0, status docs; npm packages ready (`blockflow-runner` bundles the extension at pack time), canvas virtualised only above 150 blocks (it hid off-screen blocks from the page in smaller workflows) |

## Remaining for a person [HUMAN]

- [ ] Create the Chrome Web Store and AMO developer accounts, the API keys, and the repository secrets
      (`CWS_*`, `AMO_JWT_*`); upload the first version by hand ([store/README.md](store/README.md)).
- [ ] Fill the stores' data-usage forms from [PRIVACY.md](PRIVACY.md); publish the privacy policy at a public URL.
- [ ] Run [manual-test/M6-permissions.md](manual-test/M6-permissions.md) in Chrome and Firefox (the browser's
      real permission prompt cannot be automated).
- [ ] Safari: convert and run on a Mac, then fill in [SAFARI.md](SAFARI.md)'s checklist and the README.
- [ ] Tag `v1.0.0` (the workflow checks the tag equals `package.json`).
- [ ] `npm login`, then publish `blockflow-bridge` first, then `blockflow-mcp` and `blockflow-runner` (they depend on it).
- [ ] Decide the Firefox `declarativeNetRequest` question below.
- [ ] Optional: small/marquee promo tiles for Chrome; Firefox-specific screenshots.

## Open decisions and risks

- **Firefox `declarativeNetRequest`.** `web-ext lint` says Firefox does not accept it as an *optional*
  permission, so on the store build the Route block's browser-rule backend probably cannot be granted in
  Firefox (it fails with `permission.missing`); the e2e build, which grants it up front, works. Not verified in a
  non-temporary install. Options: make it a required permission for Firefox, or drop the Firefox claim in the
  docs (several wiki pages and the guide say "also on Firefox").
- **Sidebar switches.** The On switch asks for site access only for the *open* workflow (a prompt needs a click and
  a precomputed list of sites). Switching another workflow on from the sidebar enables it; its background runs
  fail with `permission.missing` until the sites are granted (open it and press Grant access).
- **No site access in the e2e builds.** They grant every site up front; only `m6-hosts` (a special build) tests
  the refusal path.
- **Limits cache.** A changed limit applies within about 2 seconds (`src/browser/limits.ts`).
- **Virtualised canvas.** Above 150 blocks only the blocks in view are in the DOM (`onlyRenderVisibleElements`);
  smaller workflows keep every block, because the virtualised version broke finding off-screen blocks (three e2e
  specs). Fit view works through the nodes' `initialWidth/initialHeight`.
- **Bridge on other systems.** Chrome, Edge, macOS and Windows for the bridge are still unverified (see README).

## Where this differs from M6-PLAN.md

- M6.2: `activeTab` was already absent (`grep -rn activeTab src wxt.config.ts` finds nothing), nothing to drop.
  WXT copies the `matches` of runtime content scripts into `host_permissions`; a `build:manifestGenerated` hook strips
  them (the plan did not anticipate it).
- M6.1b: the plan said the locked-run failure carries a code; a run has no run-level code field, so it is the
  message of the run error plus the `secrets.locked` row in the guide and Troubleshooting.
- M6.4: the release workflow reads the secrets at job level (a step's `if` cannot see its own `env`).
- M6.5b: the 5000-item For Each test became 2000 items with a raised limit and a longer timeout: each step
  publishes a copy of the bounded record, which made 5000 items take seconds under load.
- M6.6: the wiki gap finder found one unmentioned file (`editor/sync.ts`); every other file was already covered.
- A step's guide schemas had to be regenerated after M6.1 (`secrets.locked` is in the error-code enum).
