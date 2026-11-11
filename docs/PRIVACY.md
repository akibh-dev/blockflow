# BlockFlow privacy policy and permission justification

BlockFlow is a browser extension that runs automations you build, in your own browser, with your own logins.
This page is the privacy policy for the store listings (Chrome Web Store, Firefox Add-ons) and the reference
for why each permission exists. The permission list below matches `wxt.config.ts`; when one changes, change
this page in the same commit.

## What data BlockFlow handles

- **Everything stays on your device.** Workflows, run history, logs, screenshots, datasets and secrets are
  stored in the browser's extension storage (`storage.local`, IndexedDB). BlockFlow has no server and no
  account, and does not send them anywhere.
- **No analytics, no telemetry, no advertising, no remote code.** BlockFlow makes no network request of its
  own. The only requests are the ones your workflows make: opening the sites you name, the HTTP Request and
  Download blocks you configure, and what the pages you automate load themselves.
- **Secrets** (`{{secret.name}}`) are stored on your device. You can protect them with a passphrase
  (AES-GCM encryption with a key derived from your passphrase using PBKDF2); the key is kept only in the
  browser's session storage and is gone when the browser closes. Without a passphrase they are stored
  unencrypted, like the rest of the extension's data, and the Secrets page says so.
- **Page content** read by a workflow (text, tables, screenshots, cookies you ask it to read) is kept in the
  run history and datasets on your device until you delete it (Reports → Clear, Data page) or the history
  limits remove it (Settings → Limits). Values of your secrets are masked in stored run records.
- **Outside control is off by default.** If you switch on "Allow outside control" (Settings), programs on the
  **same computer** that you installed (the BlockFlow MCP server, the `blockflow` CLI) can run workflows
  through a local native-messaging host and a per-user local socket protected by a token. Nothing is reachable
  from the network. Every outside request is listed on the Settings page.
- **Not collected:** no browsing history, no personal data, no location. (Workflows you write may read pages
  you open; that data stays in the extension's local storage as described above.)

## Permissions

### Installed with the extension

| Permission | Used for | Where in the code |
| --- | --- | --- |
| `storage` | Workflows, run history, logs, settings, encrypted or plain secrets; per-session data in `storage.session` (tab names, the secrets key, debug pauses) | `src/browser/stores.ts`, `host.ts`, `secretVault.ts` |
| `unlimitedStorage` | Screenshots, trace pictures, visual-comparison baselines and datasets in IndexedDB would otherwise hit the default quota | `src/browser/blobStore.ts`, `visual.ts` |
| `alarms` | Timers and schedules that survive the background worker sleeping | `src/browser/scheduler.ts`, `hybridScheduler.ts` |
| `tabs` | Opening, switching and closing the tabs a workflow works on; reading their URL and title; screenshots of a tab | `src/browser/tabs.ts`, `pageDriver.ts`, `screenshots.ts` |
| `scripting` | Putting the page agent (clicks, typing, reading), the element picker and the recorder into a page, only when a workflow or you ask | `src/browser/pageDriver.ts`, `picking.ts`, `recording.ts` |
| `notifications` | The Notify block and Manual Step prompts | `src/browser/prompts.ts`, `host.ts` |
| `webRequest` | Wait For "network is quiet" and "a request / response finished" (read-only observation; BlockFlow does not block or change requests with it) | `src/browser/navigation.ts` |
| `downloads` | The Download block and Wait for Download | `src/browser/downloads.ts` |
| `webNavigation` | The Page Visited trigger, single-page-app URL changes, popups and iframes | `src/entrypoints/background.ts`, `pageDriver.ts` |
| `contextMenus` | The Context Menu trigger | `src/entrypoints/background.ts` |
| `offscreen` (Chrome, Safari) | Parsing HTML that a workflow fetched (Extract List / Table) without opening a tab | `src/browser/htmlParse.ts` |

### Asked for only when you use the feature

The browser shows its own prompt, after you click **Grant**, and you can revoke it later in the browser's
extension settings.

| Permission | When | Where in the code |
| --- | --- | --- |
| **Site access** (`optional_host_permissions`: `<all_urls>`) | **Per workflow.** When you run or switch on a workflow, BlockFlow asks for the sites that workflow names (for example `https://shop.example.com/*`), or for all sites when a workflow uses a templated address or acts on a tab it did not open. Nothing is granted at install. | `src/core/origins.ts`, `src/entrypoints/editor/hostAccess.ts` |
| `debugger` | Real mouse/keyboard input, full-page and background-tab screenshots, response bodies, request mocking, device emulation, HAR and console capture. The browser shows its "debugging" bar while it is attached. Chromium only. | `src/browser/cdp.ts`, `cdpSessions.ts`, `routes.ts`, `environment.ts`, `telemetry.ts` |
| `cookies` | The Cookies & Storage block (reading and setting cookies, including HttpOnly) | `src/browser/cookies.ts` |
| `userScripts` | The Run Script block (your own JavaScript). Chrome 135+ and "Allow User Scripts". | `src/browser/host.ts` |
| `declarativeNetRequest` | The Route block's block/redirect rules, scoped to one tab | `src/browser/routes.ts` |
| `browsingData` | The Clear Site Data block (only the origins you list). Chromium only. | `src/browser/environment.ts` |
| `nativeMessaging` | "Allow outside control": the local bridge for the MCP server and CLI | `src/browser/bridge.ts` |

### Single purpose

BlockFlow has one purpose: **automating tasks in your browser with workflows you build** (testing sites,
filling forms, monitoring and scraping pages). Every permission above serves that purpose.

## Your choices

- Revoke any optional permission in the browser's extension settings; blocks that need it then fail with a
  clear message (`permission.missing`) instead of working around it.
- Turn off "Allow outside control" any time; the native connection closes at once.
- Delete everything: remove the extension, or use Reports → Clear, the Data page and the Secrets page.

## Contact

Open an issue in the BlockFlow repository for privacy questions.
