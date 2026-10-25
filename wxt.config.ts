import { defineConfig } from 'wxt';

// One codebase, three browsers:
//   npm run build           -> .output/chrome-mv3
//   npm run build:firefox   -> .output/firefox-mv3
//   npm run build:safari    -> .output/safari-mv3 (then convert with Xcode, see README)
// `npm run e2e` builds with BF_E2E=1: the optional permissions become regular ones, because an
// automated browser cannot click the browser's "allow" prompt.
const e2e = process.env.BF_E2E === '1';

export default defineConfig({
  srcDir: 'src',
  // Kept apart, so loading .output/chrome-mv3 in your browser never picks up the test build.
  ...(e2e ? { outDir: '.output-e2e' } : {}),
  modules: ['@wxt-dev/module-react'],
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
      'activeTab',
      'notifications',
      'webRequest',
      'downloads',
      'webNavigation',
      'contextMenus',
      // Chrome parses fetched HTML in an offscreen document; Firefox's background page can do it itself.
      ...(browser === 'firefox' ? [] : ['offscreen']),
      ...(e2e && browser !== 'firefox' ? ['debugger', 'userScripts'] : []),
    ],
    // Asked for only when a block needs them: real mouse/keyboard input, and Run Script.
    ...(browser === 'firefox' || e2e ? {} : { optional_permissions: ['debugger', 'userScripts'] }),
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
