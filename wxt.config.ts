import { defineConfig } from 'wxt';

// One codebase, three browsers:
//   npm run build           -> .output/chrome-mv3
//   npm run build:firefox   -> .output/firefox-mv3
//   npm run build:safari    -> .output/safari-mv3 (then convert with Xcode, see README)
export default defineConfig({
  srcDir: 'src',
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
    ],
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
