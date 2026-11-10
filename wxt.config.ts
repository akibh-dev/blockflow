import { defineConfig } from 'wxt';

// One codebase, three browsers:
//   npm run build           -> .output/chrome-mv3
//   npm run build:firefox   -> .output/firefox-mv3
//   npm run build:safari    -> .output/safari-mv3 (then convert with Xcode, see README)
// `npm run e2e` builds with BF_E2E=1: the optional permissions become regular ones, because an
// automated browser cannot click the browser's "allow" prompt.
const e2e = process.env.BF_E2E === '1';
// `BF_AUTOMATION=1` (the CLI runner, packages/cli): the same granted permissions as the e2e build, so an
// unattended browser can run any block and connect to the native host, but without the test-only hooks.
const automation = process.env.BF_AUTOMATION === '1';
/** Optional permissions become regular ones: nobody is there to click "allow". */
const granted = e2e || automation;

export default defineConfig({
  srcDir: 'src',
  // Kept apart, so loading .output/chrome-mv3 in your browser never picks up the test build.
  // BF_OUT_DIR overrides it (parallel builds during development must not share a folder).
  ...(process.env.BF_OUT_DIR ? { outDir: process.env.BF_OUT_DIR } : e2e ? { outDir: '.output-e2e' } : automation ? { outDir: '.output-automation' } : {}),
  modules: ['@wxt-dev/module-react'],
  // `import.meta.env.BF_E2E` is true only in that build: test-only hooks (background.ts) compile out otherwise.
  vite: () => ({ define: { 'import.meta.env.BF_E2E': JSON.stringify(e2e) } }),
  manifestVersion: 3,
  manifest: ({ browser }) => ({
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
      ...(browser === 'firefox' ? [] : ['offscreen']),
      ...(granted && browser !== 'firefox' ? ['debugger', 'userScripts'] : []),
      ...(granted ? ['cookies', 'declarativeNetRequest', 'nativeMessaging'] : []),
      // Clear Site Data needs exact-origin filtering, which Firefox's browsingData does not offer.
      ...(granted && browser !== 'firefox' ? ['browsingData'] : []),
    ],
    // Asked for only when a block needs them: real mouse/keyboard input, Run Script, Cookies & Storage,
    // Route (browser rules), Clear Site Data and "Allow outside control" (native messaging, M4).
    ...(granted ? {} : { optional_permissions: browser === 'firefox' ? ['cookies', 'declarativeNetRequest', 'nativeMessaging'] : ['debugger', 'userScripts', 'cookies', 'declarativeNetRequest', 'browsingData', 'nativeMessaging'] }),
    // Prototype: broad host access so "watch element" works on any site.
    // Later: switch to optional_host_permissions and ask per workflow.
    host_permissions: ['<all_urls>'],
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
  }),
});
