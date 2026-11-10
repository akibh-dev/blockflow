# M6: Ship (v1.0) — step-by-step coding plan

This plan is written so that a smaller coding model (Claude Sonnet or Haiku) can implement M6 one task at a
time without needing to redesign anything. Every task says **which files to touch, the exact shapes to
use, the tests to write, the commands to run and when it is done**. When something is a decision, it has
already been made here. If the code does not match what this plan says (a file moved, a name changed),
stop and write the difference in `docs/M6-NOTES.md` instead of guessing.

Branch: `m6-ship` (from `main` after M5, v0.6.0). Target version: **1.0.0**.

---

## 0. Rules for whoever implements this (read first)

1. Read `CLAUDE.md` (codebase rules) and this whole file before the first task. Do the tasks **in the order
   given** (M6.1 → M6.7). Each numbered step is small; do not merge steps.
2. **One commit per task** (or per sub-task where marked), message `M6.x: <what>`, ending with the
   `Co-Authored-By` line from the session's instructions. Never commit with failing checks.
3. Before every commit run, and paste the last lines of, these commands:
   ```bash
   npm run check                      # typecheck + unit tests + guide/learning/wiki checks
   npm run build && npm run build:firefox
   ```
   And for tasks that say so, the e2e command given in the task. If a check fails, fix it; do not delete or
   weaken an existing test to make it pass. If you cannot fix it in 3 attempts, stop and write the failure
   (command + output) in `docs/M6-NOTES.md`.
4. `src/core` must not use browser APIs (`browser.*`, `chrome.*`, `document`, `window`). WebCrypto
   (`crypto.subtle`) is allowed **only** in `src/browser/` and editor files, never in `src/core`.
5. Use `import type` for types; relative imports only; no new npm dependencies unless the task names one.
6. Error codes: a new code goes in `src/core/errors.ts`, **and** needs a row in the guide's error table
   (`docs/guide/README.md`, section "Error codes") **and** a row in `docs/wiki/Troubleshooting.md`, or
   `tests/core/errors.test.ts` fails.
7. New or changed block settings / step settings: run `npm run guide:sync` (regenerates `docs/guide/blocks.*`
   and the schemas), then `npm run check`.
8. New storage keys go in `src/shared/keys.ts` with a doc comment, and a row in `docs/wiki/Storage-Keys.md`.
9. e2e: build first, then run specs. Headless is fine:
   ```bash
   BF_E2E=1 npx wxt build && BF_HEADLESS=1 node tests/e2e/run.mjs <spec-name> [<spec-name>…]
   BF_E2E=1 npx wxt build -b firefox && node tests/e2e/firefox.mjs
   ```
   The e2e build (`BF_E2E=1`) grants every optional permission up front. Read `tests/e2e/harness.mjs` and one
   existing spec (e.g. `tests/e2e/specs/m4-bridge.mjs`) before writing a new spec.
10. Steps marked **[HUMAN]** need an account, money, a Mac or a person clicking a browser prompt. Do not try
    them. Prepare everything around them and list them in the final report.
11. Never print or commit secrets, tokens or the user's personal data. Never write to the real home folder in
    tests (use temporary folders).

---

## M6.1 Encrypted secrets

**Goal.** Secrets (`{{secret.name}}`) are stored encrypted with a key derived from a passphrase. The key
lives only in `storage.session` (gone when the browser closes). Without a passphrase, today's behaviour
stays, with a visible warning. Turning encryption on encrypts the existing secrets.

**Today.** `bf:secrets` in `storage.local` is a plain `Record<string, string>`. It is read by:
- `src/browser/host.ts` `allSecrets()` (around line 130) → `Host.secrets.all()`, used by the engine
  (`src/core/engine.ts` `inRun`: `run.secrets = await this.host.secrets.all()`) and the bridge
  (`src/entrypoints/background.ts`, `secretNames`).
- `src/entrypoints/editor/components/SecretsPage.tsx` (the Secrets page, read + write).
- `src/entrypoints/editor/Editor.tsx` (~line 363, only the **names**, for import/issue checks).

### Step 1: storage format and vault module (commit `M6.1a`)

Create `src/browser/secretVault.ts`. All crypto goes here. Accept an injected `SubtleCrypto` so Node tests can
use `globalThis.crypto.subtle` (Node 20+ has it).

```ts
/** bf:secrets, v2 when encrypted. A plain Record<string,string> (v1) is still valid: "no passphrase" mode. */
export interface Sealed { iv: string; data: string }          // base64; iv = 12 random bytes
export interface EncryptedSecrets {
  format: 'blockflow-secrets';
  version: 2;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string }; // salt = 16 random bytes, base64
  check: Sealed;                     // seal('blockflow-check') — proves the passphrase is right
  names: string[];                   // secret names in plain text (the editor needs them while locked)
  values: Record<string, Sealed>;    // one sealed value per name
}
export type StoredSecrets = Record<string, string> | EncryptedSecrets;

export const PBKDF2_ITERATIONS = 600_000;
export function isEncrypted(stored: unknown): stored is EncryptedSecrets;
export function secretNames(stored: StoredSecrets | undefined): string[];          // works in both modes
export async function deriveKey(passphrase: string, salt: Uint8Array, iterations?: number, subtle?: SubtleCrypto): Promise<Uint8Array>; // 32 raw bytes
export async function seal(key: Uint8Array, plaintext: string, subtle?: SubtleCrypto): Promise<Sealed>;   // AES-GCM 256
export async function unseal(key: Uint8Array, sealed: Sealed, subtle?: SubtleCrypto): Promise<string>;    // throws on tamper/wrong key
export async function encryptAll(plain: Record<string, string>, passphrase: string, options?: { iterations?: number; subtle?: SubtleCrypto }): Promise<{ stored: EncryptedSecrets; key: Uint8Array }>;
export async function unlock(stored: EncryptedSecrets, passphrase: string, subtle?: SubtleCrypto): Promise<Uint8Array>; // throws Error('Wrong passphrase') if check fails
export async function decryptAll(stored: EncryptedSecrets, key: Uint8Array, subtle?: SubtleCrypto): Promise<Record<string, string>>;
export async function setSecret(stored: EncryptedSecrets, key: Uint8Array, name: string, value: string, subtle?: SubtleCrypto): Promise<EncryptedSecrets>;
export function removeSecret(stored: EncryptedSecrets, name: string): EncryptedSecrets;
export async function changePassphrase(stored: EncryptedSecrets, key: Uint8Array, next: string, options?: { iterations?: number; subtle?: SubtleCrypto }): Promise<{ stored: EncryptedSecrets; key: Uint8Array }>;
```

Implementation notes (follow exactly):
- `deriveKey`: `subtle.importKey('raw', utf8(passphrase), 'PBKDF2', false, ['deriveBits'])`, then
  `subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)` → `Uint8Array`.
- `seal`: `subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt'])`, random 12-byte IV
  (`crypto.getRandomValues`), `subtle.encrypt({ name: 'AES-GCM', iv }, k, utf8(plaintext))`, base64 both.
- `unseal`: same with `decrypt`; a wrong key throws (AES-GCM authenticates) — let it throw.
- base64 helpers: write `toBase64(bytes)` / `fromBase64(text)` with `btoa`/`atob` over a binary string
  (they exist in Node 20 too). Put them at the bottom of the same file.
- The session key: add `STORAGE_KEYS.secretsKey = 'bf:secrets-key'` documented as **storage.session**
  (value: base64 of the 32 key bytes). Add `STORAGE_KEYS` comment + `Storage-Keys.md` row (session section).

Tests: `tests/browser/secretVault.test.ts` (Node env; pass `iterations: 1000` to keep tests fast):
1. `encryptAll` → `decryptAll` round trip; `names` equals the plain keys, sorted as given.
2. `unlock` with the right passphrase returns a key that decrypts; a wrong passphrase throws `Wrong passphrase`.
3. The stored JSON contains none of the plain values (`JSON.stringify(stored).includes(value) === false`).
4. Tampering one byte of `values.x.data` makes `unseal` throw.
5. `setSecret` adds/replaces one value and keeps `names` unique; `removeSecret` removes it from both.
6. `changePassphrase`: old passphrase no longer unlocks, new one does, values unchanged.
7. `secretNames` works for a plain map and for `EncryptedSecrets`.
8. Two `seal` calls of the same text give different IVs.

### Step 2: the Host reads encrypted secrets; locked runs fail clearly (commit `M6.1b`)

1. `src/core/errors.ts`: add code `secrets.locked` (look at how other codes are declared and described). Add
   the guide error-table row ("Secrets are encrypted and locked: open the BlockFlow editor and enter your
   passphrase on the Secrets page") and a `Troubleshooting.md` row.
2. `src/core/types.ts`: extend `Host.secrets` to
   `{ all(): Promise<Record<string, string>>; state?(): Promise<'plain' | 'unlocked' | 'locked'> }`.
3. `src/browser/host.ts` `allSecrets()`:
   - stored is plain → return it (today's behaviour);
   - stored is encrypted and `storage.session['bf:secrets-key']` exists → `decryptAll` with it;
   - encrypted and no key → return `{}`.
   Add `secretsState()` returning the three states and wire it as `secrets.state`.
4. `src/core/engine.ts` `inRun`, right after `run.secrets = await this.host.secrets.all();`: if
   `(await this.host.secrets.state?.()) === 'locked'` **and** the workflow uses secrets, fail the run:
   `run.failed = true; run.record.error = 'Secrets are locked…'`, with no steps run. "Uses secrets" =
   a new pure helper `usesSecrets(workflow: Workflow): boolean` in `src/core/secrets.ts` that returns true when
   `JSON.stringify(node.config)` of any node contains `secret.` inside `{{ }}` (regex
   `/\{\{[^}]*\bsecret\./`). Put the error code on the run: there is no run-level code field, so use the
   message only, and also make the first step-less failure visible: `run.record.error`. (Check how
   `runRoots` reports "Nothing to start" and copy that pattern.)
5. `tests/helpers/fakeHost.ts`: add `secretsState: 'plain' | 'unlocked' | 'locked' = 'plain'` and
   `secrets.state = async () => this.secretsState`.
6. Tests: `tests/core/secrets.test.ts` for `usesSecrets` (true/false cases, a `{{ secret.x }}` with spaces,
   a literal "secret." outside braces is false); `tests/core/engineSecrets.test.ts`: locked + uses secrets →
   run failed with the message and zero steps; locked + no secrets → passes; unlocked → passes.
7. Bridge: in `src/entrypoints/background.ts`, `secretNames` must use `secretNames(stored)` from the vault so it
   works while locked (read `bf:secrets` directly).

### Step 3: editor Secrets page (commit `M6.1c`)

Edit `src/entrypoints/editor/components/SecretsPage.tsx` (keep its existing table look; read the whole file
first). States and what the page shows:

| State | Shows |
| --- | --- |
| plain, no secrets | today's page + a short note "Secrets are stored unencrypted. Protect them with a passphrase." with a **Protect with a passphrase** button |
| plain, has secrets | same note in warning style |
| encrypted, locked | names only (values hidden), a passphrase input + **Unlock** button; editing disabled |
| encrypted, unlocked | today's editing, plus **Lock now**, **Change passphrase**, **Remove passphrase** |

- Protect: two password inputs (passphrase + confirm, at least 8 characters, must match) → `encryptAll` →
  save `bf:secrets` (encrypted) → save the key (base64) to `storage.session['bf:secrets-key']`.
- Unlock: `unlock(stored, input)` → store the key in session; on `Wrong passphrase` show the error inline.
- Lock now: remove `bf:secrets-key` from session.
- Add/edit/delete while unlocked: `setSecret` / `removeSecret`, then save.
- Remove passphrase: confirm dialog → `decryptAll` → save the plain map → remove the session key.
- `Editor.tsx` ~line 363: replace reading values with `secretNames(stored)` (it only needs names).
- Never log values, never put them in error messages.

Tests: `tests/dom/secretsPage.test.ts` (jsdom; mock `wxt/browser` with an in-memory `storage.local` and
`storage.session`, like other tests/dom files do — copy the pattern from an existing editor DOM test): protect
→ stored is encrypted; lock → values hidden; wrong passphrase → error text; unlock → values editable.

### Step 4: e2e (commit `M6.1d`)

`tests/e2e/specs/m6-secrets.mjs`:
1. Open the editor (`h.editor`), go to Secrets, add `loginPassword` = the fixture password (`h.PASSWORD`).
2. Protect with passphrase `correct horse battery`.
3. Read `chrome.storage.local` from `h.worker.evaluate`: the password string must not appear anywhere.
4. Run a workflow that types `{{secret.loginPassword}}` on `login.html` and asserts the welcome text → passes
   (copy the login workflow from an existing spec).
5. Remove `bf:secrets-key` from `chrome.storage.session` (simulates a browser restart) → run again → run
   `failed`, `error` mentions locked; no steps.
6. Unlock through the page with the passphrase → run passes again.

Run: `BF_E2E=1 npx wxt build && BF_HEADLESS=1 node tests/e2e/run.mjs m6-secrets`.

**Docs:** guide section 11 "Secrets" (passphrase, what is protected: the disk/profile copy and backups; what is
not: a running unlocked browser, other code running inside the extension), wiki `Browser-Host.md`
(secretVault), `Storage-Keys.md`, `Using-the-Editor.md`.

**Done when:** all tests above pass; plaintext never appears in `storage.local` once protected; locked runs
fail with a clear message; "no passphrase" mode behaves exactly as before.

---

## M6.2 Permissions review (optional host access per workflow)

**Goal.** The store build no longer asks for access to every site at install. It asks for the sites a
workflow needs when the user runs or switches it on. `activeTab` is already not used (verify with
`grep -rn activeTab src wxt.config.ts` → no results; note it in the report).

**Today.** `wxt.config.ts`: `host_permissions: ['<all_urls>']`. e2e and automation builds (`granted`) must
keep `<all_urls>` granted.

### Step 1: origins a workflow needs (commit `M6.2a`)

Create `src/core/origins.ts` (pure):

```ts
export interface WorkflowOrigins {
  /** Match patterns like "https://shop.example.com/*" (scheme + host, any path). Sorted, unique. */
  origins: string[];
  /** True when some URL is templated ("{{…}}") or a block can reach any site: the user must allow all sites. */
  anySite: boolean;
}
export function workflowOrigins(workflow: Workflow, registry: BlockRegistry): WorkflowOrigins;
export function originPattern(url: string): string | null; // "https://a.com/x?y" → "https://a.com/*"; non-http(s) → null
```

Rules (implement exactly; write each as a test):
- For every node, for every field of its block definition with `kind: 'url'` **or** key `url` (`navigate`
  uses `kind: 'text'`), read `node.config[field.key]`. Empty → skip. Contains `{{` → `anySite = true`.
  Else `originPattern(value)`; null (not http/https) → skip.
- `page-visited` (`src/core/blocks/pageVisited.ts`): its `url` is a **pattern** — a pattern that contains `*`
  in the host, or is empty → `anySite = true`; otherwise use its scheme+host.
- Blocks that act on "the tab you are on" without a URL (any page block that runs on a tab the workflow did
  not open itself, e.g. a workflow whose start block is `context-menu`): `anySite = true` when the workflow
  has no URL-bearing block at all but has a page block (`def.category === 'page'`; `BlockDefinition.category` is
  optional, `BlockCategory` in `src/core/types.ts`).
- `http-request`, `download`, `read-element`/`watch-element` with a URL: included by the URL rule.

Tests `tests/core/origins.test.ts`: open-url + http-request on two hosts → two patterns; templated URL →
anySite; page-visited `*://*.example.com/*` → anySite; a navigate to `https://x.com/a` → `https://x.com/*`;
`about:blank`/`file://` ignored; duplicates removed and sorted.

### Step 2: manifest and the grant flow (commit `M6.2b`)

1. `wxt.config.ts`: when **not** `granted`: `host_permissions: []` and add
   `optional_host_permissions: ['<all_urls>']` (Chrome MV3 and Firefox MV3 both support it). When `granted`:
   keep `host_permissions: ['<all_urls>']`. Update the comment above it.
2. Create `src/entrypoints/editor/hostAccess.ts`:
   ```ts
   /** Missing origins for a workflow (asks the browser with permissions.contains). */
   export async function missingAccess(workflow: Workflow): Promise<{ origins: string[]; anySite: boolean }>;
   /** Must be called directly inside a click handler (browsers only show the prompt then). */
   export async function requestAccess(need: { origins: string[]; anySite: boolean }): Promise<boolean>;
   ```
   `anySite` → request `{ origins: ['<all_urls>'] }`; else request the patterns.
3. Editor: in the Run handler (`runNow` in `Editor.tsx`) and the On switch handler: **first** `await
   requestAccess(await missingAccess(active))` — careful: `permissions.request` must be called in the same user
   gesture. Compute what is missing on render (keep it in state, updated when the workflow changes), so the click
   handler can call `requestAccess` immediately without awaiting other work first. If the user declines, show a
   toast "BlockFlow needs access to … to run this workflow" and do not run.
4. Show the needed sites in the config area / workflow header: a small `HostAccessNote` component (copy the
   style of `PermissionNote.tsx`) listing missing sites with a **Grant access** button.
5. Background: when a page operation fails because the host is not granted, the run must fail with code
   `permission.missing` and a message naming the origin. Find where tabs are scripted
   (`src/browser/pageDriver.ts`, `scripting.executeScript`) and map Chrome's "Cannot access contents of the page"
   / "Missing host permission" and Firefox's "Missing host permission" errors to
   `new CodedError('permission.missing', 'BlockFlow has no access to <origin>. Run the workflow from the editor to grant it.')`.
   Add a unit test with a fake executeScript that throws those messages.
6. Background timers / Watch Element runs start without a click: if access is missing, they fail with the
   same code (no prompt is possible there). Document this.

### Step 3: privacy document (commit `M6.2c`)

Create `docs/PRIVACY.md`: one table row per permission in `wxt.config.ts` (required and optional) with *what
uses it* (file names) and *why*; a "Data" section: everything stays in the browser; the bridge is local only
(native messaging + a local socket with a token); no analytics; network requests only to sites the user's
workflows open. Link it from `README.md` and `docs/wiki/Installing.md`. This is the store privacy policy text
too (M6.4).

### Step 4: tests in a real browser (commit `M6.2d`)

Playwright cannot click the browser's permission prompt, so test the parts that do not need it:
- Add a build flag `BF_E2E_NO_HOSTS=1` in `wxt.config.ts`: like `BF_E2E=1` but **without** `<all_urls>`
  (`host_permissions: []`, `optional_host_permissions: ['<all_urls>']`), output `.output-e2e-nohosts`.
- `tests/e2e/specs/m6-hosts.mjs` (run with `BF_EXTENSION_DIR=.output-e2e-nohosts/chrome-mv3`): a workflow that
  opens the fixture page and clicks → run fails with `permission.missing` naming `http://127.0.0.1`; the editor
  shows the "Grant access" note for that workflow.
- **[HUMAN]** manual check (write it in `docs/manual-test/M6-permissions.md` as a checklist): load the normal
  build, run a workflow, accept the prompt, run passes; decline, run refuses with the toast; Firefox the same.

**Done when:** the store build's manifest has no `host_permissions`; unit + e2e above pass; PRIVACY.md lists
every permission.

---

## M6.3 Safari (prepare on Linux; verify on a Mac)

**Goal.** `npm run build:safari` produces a build without features Safari does not have, and the code fails
clearly instead of crashing where a feature is missing.

1. `wxt.config.ts`: when `browser === 'safari'`, do not list `offscreen`, `debugger`, `userScripts`,
   `browsingData`, `declarativeNetRequest` (check Safari's MV3 support table in the wiki
   `Capabilities-and-Limitations.md`; when unsure, leave it out) and keep `nativeMessaging` (Safari supports it
   through the containing app — note "not verified").
2. Grep for feature use and confirm each has a guard that throws `permission.missing` with a readable message
   when the API is undefined: `browser.offscreen` (`src/browser/htmlParse.ts`: Safari must parse like Firefox
   does, in the background page — check how Firefox is detected there and treat Safari the same),
   `browser.debugger` (`src/browser/cdp.ts`), `browser.userScripts`, `browser.browsingData`
   (`src/browser/environment.ts`), `browser.declarativeNetRequest` (`src/browser/routes.ts`). Add a unit test
   per guard with the API removed from the mocked `browser` object.
3. `npm run build:safari` must succeed; add it to the `check` job in `.github/workflows/ci.yml` after
   `build:firefox`.
4. Write `docs/SAFARI.md`: the conversion command (`xcrun safari-web-extension-converter .output/safari-mv3
   --project-location safari-app --app-name BlockFlow --bundle-identifier dev.akibh.blockflow`), enabling it in
   Safari → Settings → Extensions, and a **[HUMAN]** checklist: editor opens, a Timer workflow runs, Open Tab +
   Click + Assert on a local page, Watch Element, what fails and with which message. Update README "What has been
   verified" only after a human ran it.

**Done when:** the Safari build succeeds in CI, guards are tested, SAFARI.md exists. Mac verification is
**[HUMAN]**.

---

## M6.4 Store releases

### Step 1: release workflow (commit `M6.4a`)

Create `.github/workflows/release.yml`, triggered on tags `v*.*.*`:
1. checkout, setup-node 22, `npm ci`, `npm run check`, `npm run build`, `npm run build:firefox`,
   `npm run zip`, `npm run zip:firefox` (WXT writes zips to `.output/`; list them with `ls .output/*.zip`).
2. `npx web-ext lint --source-dir .output/firefox-mv3` (add `web-ext` as a **devDependency** with
   `npm install -D web-ext` in this step only; commit the lockfile change).
3. Upload the zips as a GitHub release (`softprops/action-gh-release@v2` with `files: .output/*.zip`).
4. Firefox signing, only when the secrets exist: `if: ${{ secrets.AMO_JWT_ISSUER != '' }}`:
   `npx web-ext sign --source-dir .output/firefox-mv3 --channel listed --api-key "$AMO_JWT_ISSUER" --api-secret
   "$AMO_JWT_SECRET"`.
5. Chrome Web Store upload, only when secrets exist (`CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`,
   `CWS_EXTENSION_ID`): `npx chrome-webstore-upload-cli@3 upload --source <chrome zip> --extension-id … --client-id
   … --client-secret … --refresh-token …` (no auto-publish; a human publishes).
Also add `npm run lint:firefox` (= the web-ext lint command) to package.json and to the `check` CI job.

### Step 2: listing material (commit `M6.4b`)

Create `docs/store/`:
- `chrome.md` and `firefox.md`: name "BlockFlow", the short description (≤ 132 chars, Chrome limit) using the
  positioning "Playwright-compatible automation in your browser", the long description (features, Chromium-only
  features marked, privacy summary linking PRIVACY.md), category (Developer Tools), the single-purpose statement,
  and the permission justifications copied from PRIVACY.md (the Chrome form asks for each).
- `scripts/store-screenshots.mjs`: launches the e2e build like `tests/e2e/harness.mjs` (copy its launch code),
  seeds the `playground-tour` example (`docs/guide/examples/playground-tour.blockflow.json`) and saves 1280×800
  PNGs of: the canvas with a workflow, a run with ✓ marks, Reports with a trace filmstrip, Suites, Settings.
  Output to `docs/store/screenshots/` (commit the PNGs). Add `npm run store:screenshots`.
- **[HUMAN]**: create the Chrome Web Store developer account ($5) and the AMO account; create API keys; add the
  repository secrets; do the first upload by hand in the dashboards (the API can only update an existing item);
  fill the data-usage forms using PRIVACY.md.

**Done when:** a pushed tag on a fork builds zips, lints Firefox, and creates a release (verify the workflow
syntax with `npx --yes @action-validator/cli .github/workflows/release.yml` if available, else by reading it
carefully); listing texts and screenshots exist.

---

## M6.5 Performance and limits

### Step 1: configurable limits (commit `M6.5a`)

Today the limits are constants: `MAX_RUNS = 40`, `MAX_LOG_ENTRIES = 300` (`src/shared/keys.ts`),
`MAX_SCREENSHOTS = 150` (`src/browser/blobStore.ts`), `DEFAULT_MAX_STEPS = 1000` (`src/core/engine.ts`, the loop
guard), `MAX_STEPS_KEPT = 300` (`src/core/runs.ts`).

1. Extend the settings stored in `bf:settings` (type `BridgeSettings` in `src/core/bridgeProtocol.ts`; rename the
   type to `Settings`, keep `BridgeSettings` as an alias so nothing breaks) with optional fields:
   `runHistory?: number` (10–500, default 40), `logEntries?: number` (100–5000, default 300),
   `screenshots?: number` (20–1000, default 150), `maxStepsPerRun?: number` (100–100000, default 1000).
2. A pure helper `src/core/limits.ts`: `resolveLimits(settings?: Partial<Settings>): Limits` that applies
   defaults and clamps; unit tests for defaults, clamping, non-numbers.
3. Use them: `stores.ts` `saveRun`/`updateRuns`/`appendLog` read the limits (cache the settings in memory, refresh
   on `storage.onChanged` for `bf:settings`); `blobStore.ts` screenshot pruning uses `screenshots`; background
   `newRunner`/`runWorkflow` pass `maxSteps: limits.maxStepsPerRun` to `WorkflowRunner`.
4. Settings page (`SettingsPage.tsx`): a "Limits" section with four number inputs (min/max as above), saved on
   blur, with one line each explaining it. Keep the existing outside-control section first.
5. Docs: guide section 17 "Limits" mentions the settings; wiki Storage-Keys / Editor-Components.

### Step 2: large workflows (commit `M6.5b`)

1. `tests/e2e/specs/m6-perf.mjs`: generate a workflow of 500 `log` blocks in a chain (positions in a grid),
   seed it (`h.seedWorkflows`), open it, measure: time until the canvas shows (`.react-flow__node` count > 0),
   time to drag one node and see `bf:workflows` saved. Assert: open < 5 s, save < 1 s (headless). Print the
   numbers.
2. If too slow: in `Editor.tsx` pass `onlyRenderVisibleElements` to `<ReactFlow>`, memoise node components
   (`BlockNode.tsx` with `React.memo`). Autosave is already debounced (`SAVE_DELAY_MS` in `Editor.tsx`): keep it,
   and check that one drag causes one save, not one per pixel.
   Re-measure and write the before/after numbers in the commit message.
3. For Each memory: `tests/core/forEachLarge.test.ts` with FakeHost: For Each over 5000 items with one `log`
   inside, `maxSteps: 20000` → run passes, `record.steps.length <= MAX_STEPS_KEPT`, `droppedSteps` > 0. With the
   default limit (1000) → run fails with the loop-guard message (documents the limit).

**Done when:** limits are configurable and tested; the perf spec passes with numbers recorded.

---

## M6.6 Docs complete

1. **Wiki:** for every file under `src/` and `packages/` changed since M2 that has no wiki mention, add a short
   section to the right page. Find candidates with:
   `for f in $(git ls-files src packages | grep -E '\.(ts|tsx|mjs)$'); do b=$(basename $f); grep -rq "$b" docs/wiki || echo $f; done`
   Then `npm run wiki:check`.
2. **Learning:** add `docs/learning/10-cdp-debugger.md` ("Driving a page with the Chrome DevTools Protocol from an
   extension"), plain JS like lessons 1–5 and 9, following `docs/learning/MAINTAINING.md` (template, `file=`
   fences, `node docs/learning/tools/sync-examples.mjs`). Example extension `examples/06-cdp-click/`: manifest with
   `debugger` permission, a popup button that attaches to the active tab (`chrome.debugger.attach({tabId}, '1.3')`),
   sends `Input.dispatchMouseEvent` (pressed + released) at the center of a button found with `Runtime.evaluate`,
   then detaches; shows `isTrusted: true` on the page. **Verify it in real Chromium** with a scratch Playwright
   script like the one used for lesson 9 (see the verification note in lesson 9) before removing the `Status`
   note. Add it to `docs/learning/README.md`, the glossary, and point to `src/browser/cdp.ts` /
   `cdpSessions.ts` in "In BlockFlow".
3. Create `CHANGELOG.md`: one section per version (0.2.0 … 1.0.0) built from `git log --oneline` and the
   milestone sections of `docs/IMPLEMENTATION.md` (features, not commits).

---

## M6.7 Release 1.0.0

1. Versions: `package.json` and `packages/*/package.json` (`version` and the `blockflow-bridge` dependency) →
   `1.0.0`; `packages/cli/main.mjs` `VERSION`; run `npm install` to refresh the lockfile.
2. Status: README "Status" line → 1.0.0; "What has been verified" gets an M6 row with the exact commands and
   counts you ran; `docs/IMPLEMENTATION.md` M6 section ticked (with what was **not** verified: everything
   **[HUMAN]**) and the Tracking table row; `docs/PLAN.md` status; wiki `Roadmap.md` and `Home.md`.
3. Full verification, all must pass, paste the summary lines in the report:
   ```bash
   npm run check && npm run build && npm run build:firefox && npm run build:safari
   BF_E2E=1 npx wxt build && BF_HEADLESS=1 node tests/e2e/run.mjs
   BF_E2E=1 npx wxt build -b firefox && node tests/e2e/firefox.mjs
   npm run build:automation && node tests/cli/cli.e2e.mjs
   ```
4. Commit `M6: ship 1.0.0`, push the branch, and **stop**: the human opens the PR and tags `v1.0.0`.

---

## Final report (write it at the end, in `docs/M6-NOTES.md` and in your last message)

- Per task: commit hash, files changed, commands run with their last output lines.
- Everything **[HUMAN]** that remains, as a checklist.
- Anything in this plan that did not match the code, and what you did instead.
