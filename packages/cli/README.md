# blockflow-runner

Run [BlockFlow](https://github.com/akibh-dev/blockflow) workflows and suites from the command line or CI. It starts Chromium with the BlockFlow
extension in a throwaway profile (bundled in this package, nothing to install in your own browser), runs
everything as one suite, writes JUnit / JSON / HTML reports and exits with a code your CI understands.

```bash
npx blockflow-runner run tests/ --report junit --out report/      # the command is `blockflow`
npx blockflow-runner validate tests/                              # check files without running them
```

- Inputs: `*.script.json`, `*.blockflow.json` files or folders; `--suite <file>` for a suite file.
- Secrets: `BLOCKFLOW_SECRET_LOGIN_PASSWORD` → `{{secret.LOGIN_PASSWORD}}` and `{{secret.loginPassword}}`, or
  `--secret name=value`. Used for that run only, never stored.
- Browser: Chromium, Brave or Edge (branded Google Chrome 137+ ignores `--load-extension`); `--browser <path>` or
  `BLOCKFLOW_BROWSER`. Headless by default, `--headed` to watch.
- Exit codes: `0` all passed, `1` a workflow failed, `2` usage or setup error, `130`/`143` interrupted.

GitHub Actions:

```yaml
- run: npx playwright install --with-deps chromium
- run: |
    export BLOCKFLOW_BROWSER="$(node -e "console.log(require('playwright-core').chromium.executablePath())")"
    npx blockflow-runner run tests/ --report junit --out report/
```

Full documentation: [CLI wiki](https://github.com/akibh-dev/blockflow/wiki/CLI).

License: MIT.
