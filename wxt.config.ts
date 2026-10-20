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
    description: 'Build small browser automations by connecting blocks: timers, open a URL, watch part of a page.',
    permissions: ['alarms', 'storage', 'tabs', 'scripting', 'activeTab'],
    // Prototype: broad host access so "watch element" works on any site.
    // Later: switch to optional_host_permissions and ask per workflow.
    host_permissions: ['<all_urls>'],
    action: { default_title: 'Open BlockFlow editor' },
    ...(browser === 'firefox'
      ? { browser_specific_settings: { gecko: { id: 'blockflow@akibh-dev' } } }
      : {}),
  }),
});
