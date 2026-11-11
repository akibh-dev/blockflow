import { defineConfig } from 'wxt';

// One codebase, three browsers:
//   npm run build           -> .output/chrome-mv3
//   npm run build:firefox   -> .output/firefox-mv3
//   npm run build:safari    -> .output/safari-mv3 (then convert with Xcode, see README)
// `npm run e2e` builds with BF_E2E=1: the optional permissions become regular ones, because an
// automated browser cannot click the browser's "allow" prompt.
// `BF_E2E_NO_HOSTS=1`: the e2e build, but without site access (`host_permissions` empty, all sites optional),
// like the store build: tests/e2e/specs/m6-hosts.mjs checks that runs refuse with `permission.missing`.
const noHosts = process.env.BF_E2E_NO_HOSTS === '1';
const e2e = process.env.BF_E2E === '1' || noHosts;
// `BF_AUTOMATION=1` (the CLI runner, packages/cli): the same granted permissions as the e2e build, so an
// unattended browser can run any block and connect to the native host, but without the test-only hooks.
const automation = process.env.BF_AUTOMATION === '1';
/** Optional permissions become regular ones: nobody is there to click "allow". */
const granted = e2e || automation;

export default defineConfig({
  srcDir: 'src',
  // Kept apart, so loading .output/chrome-mv3 in your browser never picks up the test build.
  // BF_OUT_DIR overrides it (parallel builds during development must not share a folder).
  ...(process.env.BF_OUT_DIR ? { outDir: process.env.BF_OUT_DIR } : noHosts ? { outDir: '.output-e2e-nohosts' } : e2e ? { outDir: '.output-e2e' } : automation ? { outDir: '.output-automation' } : {}),
  modules: ['@wxt-dev/module-react'],
  // `import.meta.env.BF_E2E` is true only in that build: test-only hooks (background.ts) compile out otherwise.
  vite: () => ({ define: { 'import.meta.env.BF_E2E': JSON.stringify(e2e) } }),
  manifestVersion: 3,
  hooks: {
    // WXT copies the `matches` of runtime-registered content scripts (picker, agent, recorder, e2e bridge) into
    // `host_permissions`. The store build must not ask for any site at install: drop them, the optional
    // `<all_urls>` below stays. Builds with every site granted keep what WXT generated.
    'build:manifestGenerated': (_wxt, manifest) => {
      if (granted && !noHosts) return;
      manifest.host_permissions = [];
    },
  },
  manifest: ({ browser }) => {
    /** Chrome, Edge, Brave: the browsers with the `debugger` and `userScripts` APIs. */
    const chromium = browser !== 'firefox' && browser !== 'safari';
    return {
      name: 'BlockFlow',
      description: 'Browser automation from connected blocks: fill forms, test sites, watch pages, scrape data.',
      permissions: [
        'alarms',
        'storage',
        'unlimitedStorage',
        'tabs',
        'scripting',
        'notifications',
        'webRequest',
        'downloads',
        'webNavigation',
        'contextMenus',
        // Chrome parses fetched HTML in an offscreen document; Firefox's background page can do it itself.
        // Safari has neither the offscreen API nor (reliably) a DOM in the background: the code refuses clearly.
        ...(browser === 'firefox' || browser === 'safari' ? [] : ['offscreen']),
        // Chromium-only features (CDP, user scripts, exact-origin site data): not declared for Firefox or Safari.
        ...(granted && chromium ? ['debugger', 'userScripts'] : []),
        ...(granted ? ['cookies', 'declarativeNetRequest', 'nativeMessaging'] : []),
        // Firefox: `declarativeNetRequest` is required, not optional. Firefox does not accept it in
        // `optional_permissions` (web-ext lint: MANIFEST_OPTIONAL_PERMISSIONS; permissions.request() rejects it), so
        // as an optional permission the Route block's block/redirect rules could never be granted in the store
        // build. Declaring it adds one install-time line ("Block content on any page"). It does nothing until a
        // Route block runs, its rules are session rules scoped to the workflow's tab and removed when the run ends,
        // and it gives no access to page content (docs/PRIVACY.md).
        ...(!granted && browser === 'firefox' ? ['declarativeNetRequest'] : []),
        ...(granted && browser !== 'firefox' && browser !== 'safari' ? ['browsingData'] : []),
      ],
      // Asked for only when a block needs them: real mouse/keyboard input, Run Script, Cookies & Storage,
      // Route (browser rules), Clear Site Data and "Allow outside control" (native messaging, M4).
      // Safari: only what its WebExtensions support (no debugger, userScripts, browsingData by origin); not verified on a Mac.
      ...(granted
        ? {}
        : {
            optional_permissions:
              browser === 'firefox'
                ? ['cookies', 'nativeMessaging']
                : browser === 'safari'
                  ? ['cookies', 'declarativeNetRequest', 'nativeMessaging']
                  : ['debugger', 'userScripts', 'cookies', 'declarativeNetRequest', 'browsingData', 'nativeMessaging'],
          }),
      // Store build: no site access at install. The editor asks for the sites a workflow needs when it is run or
      // switched on (src/core/origins.ts, src/entrypoints/editor/hostAccess.ts). The e2e, automation (CLI) builds
      // have every site granted up front, because nobody can click the browser's prompt there.
      ...(granted && !noHosts ? { host_permissions: ['<all_urls>'] } : { host_permissions: [], optional_host_permissions: ['<all_urls>'] }),
      action: { default_title: 'Open BlockFlow editor' },
      ...(browser === 'firefox'
        ? {
            browser_specific_settings: {
              gecko: {
                id: 'blockflow@akibh-dev',
                // Required for new AMO listings. BlockFlow sends nothing off the device.
                data_collection_permissions: { required: ['none'] },
              },
            },
          }
        : {}),
    };
  },
});
