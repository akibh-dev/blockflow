# CLI

`blockflow` runs workflow files and suites from a terminal or a CI job: it starts Chromium with the
extension in a throwaway profile, switches on "Allow outside control" there, talks to it through the
[bridge](Bridge.md), runs everything as one suite, writes JUnit / JSON / HTML reports and exits non-zero
when something failed. Read this to use the CLI, to put BlockFlow tests in CI, or to change `packages/cli`.

**Source:** [packages/cli/cli.mjs](../../packages/cli/cli.mjs) · [main.mjs](../../packages/cli/main.mjs) ·
[args.mjs](../../packages/cli/args.mjs) · [inputs.mjs](../../packages/cli/inputs.mjs) ·
[secrets.mjs](../../packages/cli/secrets.mjs) · [browser.mjs](../../packages/cli/browser.mjs) ·
[reports.mjs](../../packages/cli/reports.mjs) · [index.d.mts](../../packages/cli/index.d.mts) ·
tests: [tests/cli/](../../tests/cli)

## Install and build

The CLI is published on npm as **`blockflow-runner`** (the name `blockflow-cli` belongs to an unrelated package);
the workspace package is `packages/cli`, its command is `blockflow`, Node 20 or newer. It depends on
`blockflow-bridge` (the native host it installs into the profile) and `playwright-core` (to launch the browser).
Outside the repo: `npx blockflow-runner run tests/` (npx runs the package's only command). In the repo,
`npm install` sets everything up and `npm run blockflow -- run …` runs the local copy.

It loads an unpacked build of the extension, in this order: `--extension <dir>` / `BLOCKFLOW_EXTENSION`,
`.output-automation/chrome-mv3` in the working directory, the copy **bundled into the published package**
(`extension/`, copied by `scripts/pack.mjs` at `npm pack` / `npm publish`), then the repo's
`.output-automation/chrome-mv3`, made by:

```bash
npm run build:automation      # BF_AUTOMATION=1 wxt build: optional permissions (incl. nativeMessaging) granted
```

Any other build folder works with `--extension <dir>` (for example `BF_OUT_DIR=.output-cli BF_AUTOMATION=1 npx wxt build`).
A normal build does not: its `nativeMessaging` permission is optional and nobody is there to grant it.

You also need a Chromium-based browser (see [Browser](#browser)).

## Usage

```bash
blockflow run tests/login.script.json tests/flows/ --report junit --report html
blockflow run --suite smoke.suite.json --out reports/
blockflow validate docs/guide/examples
```

In the repo without a global install: `node packages/cli/cli.mjs run …` (or `npx blockflow run …`).

| Command | What it does |
| --- | --- |
| `blockflow run <file\|dir>...` | Runs every workflow found as one inline suite (named `BlockFlow CLI`) |
| `blockflow run --suite <file\|name>` | Runs a suite from a suite file (see [Suites](#suite-files)) |
| `blockflow validate <file\|dir>...` | Checks the files with the extension's checker (`validate` bridge method), runs nothing. Prints every issue with its JSON path and hint; exit 1 when any file has errors. Useful as a fast CI step |

Inputs: a file is sent as it is (script `blockflow-script`, graph file `blockflow-workflows`, or one
workflow). A directory is searched recursively (sorted, skipping `node_modules` and dot-folders) for
`*.script.json`, `*.blockflow.json` and other `*.json` files that look like a workflow; unrelated JSON
(`package.json`, reports, suite files) is ignored. A file given twice runs once.

Before running, `run` validates every file (issues are printed per file, `error` lines on stderr); one
file with errors means nothing runs and the exit code is 1. A file that is not JSON fails before the
browser starts.

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--suite <file\|name>` | | A suite file, `<file>#<name>` for one suite of several, or a suite name (looked up in the suite files given as inputs, else `./blockflow.suites.json`) |
| `--report <format>` | none | `junit`, `json` or `html`; repeat it or comma-separate (`--report junit,html`). Without it, no files are written |
| `--out <dir>` | `blockflow-report` | Where the reports go: `junit.xml`, `report.json`, `report.html` |
| `--secret <name=value>` | | A secret for this run; repeatable; wins over the environment |
| `--timeout <seconds>` | 1800 | Time limit for the whole `suite.run`; past it the CLI exits 2 (per-step timeouts are the workflow's own) |
| `--headed` | off | Show the browser window (headless otherwise: `--headless=new`, which supports extensions) |
| `--browser <path>` | discovered | The browser executable; also `BLOCKFLOW_BROWSER` |
| `--extension <dir>` | `.output-automation/chrome-mv3` | The unpacked build; also `BLOCKFLOW_EXTENSION` |
| `-h`, `--help` / `-v`, `--version` | | Usage / version |

`validate` takes `--headed`, `--browser` and `--extension`; the run-only flags are a usage error there.

### Suite files

The editor's saved suites (`bf:suites`) live in a browser profile, and the CLI always starts a fresh one,
so the CLI reads suites from a file instead. Paths in it are relative to the suite file and may be
directories:

```json
{
  "format": "blockflow-suite",
  "version": 1,
  "name": "Smoke",
  "stopOnFailure": true,
  "workflows": ["login.script.json", "checkout/"]
}
```

Several suites in one file: `{ "format": "blockflow-suite", "version": 1, "suites": [ {name, workflows, stopOnFailure?}, … ] }`.

| You run | Suite |
| --- | --- |
| `blockflow run --suite smoke.json` | The one suite in `smoke.json` (error if it holds several) |
| `blockflow run --suite all.json#Smoke` | Suite `Smoke` in `all.json` |
| `blockflow run --suite Smoke all.json` | Suite `Smoke` in the suite files given as inputs |
| `blockflow run --suite Smoke` | Suite `Smoke` in `./blockflow.suites.json` |
| `blockflow run smoke.json` | A suite file as the only input: its one suite |

With `--suite`, other workflow inputs are a usage error (list them in the suite). The suite is sent inline
(`suite.run` with `suite: {name, sources, stopOnFailure}`), so it never needs to exist in the browser.

## Secrets

Workflows read secrets as `{{secret.<name>}}`. The fresh profile has none, so the CLI passes them with
`suite.run` (`secrets`), for that run only; they are never stored in the profile.

| Source | Becomes |
| --- | --- |
| `BLOCKFLOW_SECRET_LOGIN_PASSWORD=…` | `LOGIN_PASSWORD` and its lowerCamel form `loginPassword` |
| `BLOCKFLOW_SECRET_apiToken=…` | `apiToken` (names that are not UPPER_SNAKE are kept as they are; an exact name beats an alias) |
| `--secret loginPassword=…` | `loginPassword`, winning over the environment |

The checker warns `secret.unknown` for secrets that do not exist in the profile; `run` drops those warnings
for secrets it brings. Prefer environment variables in CI: flags end up in shell history and process lists.

## Output and reports

Progress lines come as each workflow finishes (`[1/3] Login test: passed`), then one line per workflow and,
for a failure, the failing step (its script id, block type, error code and message), its locator and page URL
when it has them (real output of `tests/cli/cli.e2e.mjs`):

```text
Running suite "BlockFlow CLI" (2 files)
  [1/2] CLI login passes: passed
  [2/2] CLI heading fails: failed
✓ CLI login passes  448 ms
✗ CLI heading fails  654 ms  (failed)
    step "heading" (assert) assert.failed: Assert: Expected text of role=heading[level=1] equals "Not this heading", got "Sign in"
    locator: role=heading[level=1]
FAILED BlockFlow CLI: 1 passed, 1 failed in 1.1 s
report: out/junit.xml
report: out/report.json
```

The reports are the extension's combined suite reports (`toSuiteJUnit`, `toSuiteJson`, `toSuiteHtml` in
[src/core/report.ts](../../src/core/report.ts)): JUnit has one `<testsuite>` and one `<testcase>` per
workflow, the failure being the failing step's code and message. A result larger than the inline limit
arrives as a blob and is fetched with `blob.get` ([Bridge](Bridge.md)). Diagnostics (browser path, extension
version, errors) go to stderr; the summary to stdout.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Every workflow passed (`validate`: no file has errors) |
| 1 | A workflow failed or was cancelled, or a file did not validate (nothing was run then) |
| 2 | Usage error (unknown flag, missing file, ambiguous suite) or infrastructure error: no browser, no build, the extension or the bridge did not start, a bridge error, `--timeout` |
| 130 / 143 | Interrupted by Ctrl-C / SIGTERM (the browser is closed and the profile removed first) |

## How it works

1. Parse the arguments ([args.mjs](../../packages/cli/args.mjs), `node:util` `parseArgs`) and collect the
   inputs ([inputs.mjs](../../packages/cli/inputs.mjs)); both fail with exit 2 before anything starts.
2. [browser.mjs](../../packages/cli/browser.mjs) `startBridge`: find the browser and the build, make a
   throwaway profile (`$TMPDIR/blockflow-cli-*`) with its own token file and socket inside it
   (`bridge.sock`; a random named pipe on Windows), write the native host manifest into
   `<profile>/NativeMessagingHosts` (and, on Linux, every Chromium-family default folder under a throwaway
   `HOME` the browser is started with, because Brave reads only those: `isolatedHostDirs`) with
   `installHost({dirs, extensionIds: [chromiumExtensionId(ext)]})`
   (re-written with the real id if the worker reports another), and launch it with `playwright-core`
   `launchPersistentContext` (`--load-extension`, `BLOCKFLOW_SOCKET` / `BLOCKFLOW_TOKEN_FILE` in the
   browser's environment, so the host it starts listens on the private socket).
3. Through the service worker (`worker.evaluate`) set `bf:settings` `{outsideControl: true}` (and dismiss
   the onboarding card); the worker connects the native host, which opens the socket.
4. Wait up to 30 s for the socket and connect (`connectBridge` from `blockflow-bridge/client`, which sends
   `auth`). On timeout the error includes the extension's `bf:bridge-status` (storage.session).
5. [main.mjs](../../packages/cli/main.mjs): `hello`, `validate` per file, then one `suite.run`
   (`formats` from `--report`), printing `suite.progress` notifications; resolve a blob result; summary
   and reports ([reports.mjs](../../packages/cli/reports.mjs)).
6. Always: close the client and the browser (10 s cap) and remove the profile, also on errors and signals.

`main(argv, deps)` takes everything outside as injectable deps (`env`, `cwd`, `stdout`, `stderr`,
`startBridge`, `onInterrupt`), which is how [tests/cli](../../tests/cli) runs the whole flow with a fake
bridge client and no browser. [tests/cli/cli.e2e.mjs](../../tests/cli/cli.e2e.mjs) is the real thing: fixture
server, one passing (login with a secret) and one failing workflow, exit code 1 and the JUnit file.

```bash
npx vitest run tests/cli                                  # unit tests, fakes only
BF_OUT_DIR=.output-cli BF_AUTOMATION=1 npx wxt build
node tests/cli/cli.e2e.mjs --extension .output-cli/chrome-mv3   # real browser
```

## Browser

Candidates, first found wins: `--browser`, `BLOCKFLOW_BROWSER`, `BF_BROWSER` (the e2e harness's), then
`/usr/bin/chromium`, `/usr/bin/chromium-browser`, `/snap/bin/chromium`, Chromium.app, Brave, Google Chrome,
Windows install folders, Edge, and a Chromium from `npx playwright install chromium`. An explicit browser
that does not exist is an error, never silently replaced.

Plain Chromium is preferred: branded Google Chrome 137 and later ignores `--load-extension`, so the
extension never starts there. Brave works headed; headless next to a running Brave it may not start.

## CI

GitHub Actions (Forgejo Actions reads the same syntax; use a runner image with Node and the browser
dependencies):

```yaml
  blockflow:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run build:automation
      - name: Run the BlockFlow tests
        env:
          BLOCKFLOW_SECRET_LOGIN_PASSWORD: ${{ secrets.LOGIN_PASSWORD }}
        run: |
          export BLOCKFLOW_BROWSER="$(node -e "console.log(require('playwright-core').chromium.executablePath())")"
          node packages/cli/cli.mjs run tests/blockflow --report junit,html --out blockflow-report
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: blockflow-report
          path: blockflow-report/
```

Headless (the default) needs no display. For `--headed`, wrap the command in `xvfb-run -a`. A JUnit-aware
step (test reporter action, Forgejo's artifact viewer) can read `blockflow-report/junit.xml`.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `BlockFlow extension build not found … Build it first: npm run build:automation` | Build it, or point `--extension` at your build folder (the one with `manifest.json`) |
| `No Chromium-based browser found` | Install Chromium or `npx playwright install chromium`, or pass `--browser` |
| `The BlockFlow extension did not start in <browser> within 30 s` | Branded Chrome 137+ ignores `--load-extension`: use Chromium. Also check that the folder is a Chromium (`chrome-mv3`) build |
| `The BlockFlow bridge did not come up within 30 s (socket …, never created)` | The extension did not start the native host. Use the automation build (it grants `nativeMessaging`); check that `node` runs from the browser's environment and that `$TMPDIR` is not mounted `noexec` (the launcher script lives in the profile). The message includes `bf:bridge-status` when the extension wrote one, with the browser's reason |
| `Could not launch …` with `--headed` on Linux | No display: use `xvfb-run -a`, or drop `--headed` |
| `Not run: fix the validation errors above.` | Each line names the file, the JSON path and a hint; `blockflow validate` shows the same |
| `The run did not finish within N s (--timeout)` | A workflow waits for something that never happens; raise `--timeout` or the step's `timeoutSeconds` |
| `Allow outside control is off in BlockFlow` | The CLI sets it itself; seen only if something switched it off mid-run |

Windows: Chromium reads native host manifests from the registry only, not from the profile, so the private
per-profile install does not reach it. The CLI has been run on Linux only (Chromium 156 headless, Brave Origin headed: Brave does not start
headless next to a running Brave, so use `--headed` there or close Brave); macOS Chromium should read
`<profile>/NativeMessagingHosts` like Linux, but that is untested. Set `BLOCKFLOW_DEBUG=1` for stack traces of unexpected errors.
