# Installing

For anyone who wants BlockFlow running in their own browser. BlockFlow is not in any extension store yet,
so you build it from the source and load it as an unpacked (developer) extension. It takes about five minutes.

## What works where

Be clear about this before you start. The table follows the README's
[What has been verified](../../README.md#what-has-been-verified) section.

| Browser | Status |
| --- | --- |
| **Brave, Chromium** | Built, loaded and driven end to end many times (Brave Origin 155, Playwright's Chromium 131). This is the reference browser. |
| **Chrome, Edge** | Same build as Brave/Chromium (`.output/chrome-mv3`). Expected to work, but no test run is recorded on them specifically. |
| **Firefox** | Builds and passes `web-ext lint`. Loading it, granting site access and running workflows have **not** been tried yet. Real mouse/keyboard input and Run Script are not available in Firefox. |
| **Safari** | The build exists, but converting it into a Safari app has **not** been tried. Treat it as unknown. |

If you just want to try BlockFlow, use a Chromium browser.

## You need

- **Node.js 20 or newer** and npm.
- The repository: `git clone` it and `cd` into it.
- For Safari only: a Mac with Xcode.

## Build

```bash
npm install          # installs dependencies and runs `wxt prepare`
npm run build        # Chrome, Brave, Edge, Chromium  ->  .output/chrome-mv3
npm run build:firefox  # Firefox                      ->  .output/firefox-mv3
npm run build:safari   # Safari                       ->  .output/safari-mv3
```

`npm run build:all` does all three. If you plan to change the code, `npm run dev` opens a separate Chrome
with the extension loaded and reloads it on every save (see [Build and Release](Build-and-Release.md)).
That browser uses a temporary profile, so your normal logins are not there.

## Load it

### Chrome, Brave, Edge, Chromium

1. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
2. Switch on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `.output/chrome-mv3` folder.
4. Pin the BlockFlow icon to the toolbar (puzzle-piece menu → pin). Clicking it opens the editor.

On first install BlockFlow creates two example workflows, both **Off**:
"Example: open a page every 5 minutes" and "Example: open the page when part of it changes".

### Firefox (untested)

1. Open `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
2. Choose any file inside `.output/firefox-mv3` (for example `manifest.json`).
3. **Grant site access.** Firefox does not give Manifest V3 extensions their site permissions on install.
   Open `about:addons` → BlockFlow → **Permissions** and allow access to all websites. Without it,
   Watch Element, Read Element, the picker and every page block fail with a permission error.

A temporary add-on is removed when Firefox closes, so you load it again after every restart. Installing it
permanently needs a signed build from addons.mozilla.org, which does not exist yet.

### Safari (untested)

1. `npm run build:safari`
2. `xcrun safari-web-extension-converter .output/safari-mv3`
3. Open the generated Xcode project, build and run the app.
4. Safari → Settings → Extensions → enable BlockFlow, and allow it on websites.
   For an unsigned build you may need Safari's Develop menu → "Allow Unsigned Extensions".

Nobody has run these steps yet. If you do, please report what happened.

## Permissions, and why each one is there

BlockFlow asks for these when you load it. Nothing is sent off your device: workflows, runs, secrets and
datasets stay in the browser profile. (The [HTTP Request](../guide/blocks.md#-http-request--http-request)
block calls whatever URL *you* give it.)

| Permission | What BlockFlow uses it for |
| --- | --- |
| Access to all sites (`<all_urls>`) | Reading and acting on the pages your workflows name. A prototype choice; asking per workflow is planned (see [Roadmap](Roadmap.md)) |
| `tabs` | Opening, switching and closing tabs; reading their URL and title; screenshots |
| `scripting` | Putting the page agent, the element picker and the recorder into a page when needed. Nothing is injected into pages otherwise |
| `storage`, `unlimitedStorage` | Workflows, run history, logs, secrets; screenshots and datasets can grow past the default quota |
| `alarms` | Timers and schedules that survive the background worker sleeping |
| `notifications` | The Notify block, and Manual Step's "Continue / Fail" prompt |
| `webRequest` | Wait For "network is quiet" and "a network request finishes" |
| `webNavigation` | The Page Visited trigger, single-page-app URL changes, popups, iframes |
| `contextMenus` | The Context Menu trigger |
| `downloads` | The Download block |
| `offscreen` (Chrome, Safari) | Parsing fetched HTML for Extract List / Extract Table without a tab (Firefox does not need it) |

### Optional permissions (asked only when you need them)

Two permissions come with a strong install warning, so BlockFlow asks for them only when you use the
feature. Browsers only show the prompt after a click, so you grant them from the editor:

| Permission | Feature | How to grant |
| --- | --- | --- |
| `debugger` | **Use real mouse and keyboard** for sites that ignore synthetic clicks and typing; also screenshots of background tabs | Select the block, open **Step settings**, tick **Use real mouse and keyboard (debugger)**. The browser asks; accept. While it acts, Chrome shows a "BlockFlow started debugging this browser" bar. |
| `userScripts` | The **Run Script** block | Add a Run Script block. The settings panel shows "Needs the **userScripts** permission…" with a **Grant** button. Then, in `chrome://extensions` → BlockFlow → Details, switch on **Allow User Scripts** (on some Chrome versions this is the Developer mode switch instead). Needs Chrome 135 or newer. |

Both are Chromium only. In Firefox the Grant button explains that the browser does not offer them.

To take a permission back: `chrome://extensions` → BlockFlow → Details → Permissions / Site access.

## Updating

```bash
git pull
npm install
npm run build
```

Then press the reload arrow (↻) on BlockFlow's card in `chrome://extensions`. Your workflows, secrets and
history stay, because they belong to the extension, not to the build folder.

Things to know:

- **Keep loading the same folder.** Chrome derives an unpacked extension's id from its folder path. Load
  a copy from another folder and you get a second, empty BlockFlow.
- **Reload any open editor tab** after reloading the extension. An old editor tab can no longer reach the
  background worker ("Could not reach the background worker. Try reloading the extension.").
- Workflows that are **On** start again after the reload.
- Firefox: load the temporary add-on again from `about:debugging` (its **Reload** button).

## Backing up, uninstalling and your data

Everything BlockFlow keeps lives in the browser profile's extension storage and IndexedDB:
workflows, run history (last 40 runs), logs, screenshots, secrets and datasets.

- **Back up workflows** with **All workflows → Export all** (one `.blockflow.json` file). See
  [Using the Editor](Using-the-Editor.md#import-and-export).
- **Secrets are never exported.** Write them down somewhere safe (a password manager) if you need them again.
- **Datasets**: download them as CSV/JSON from the **Data** page.
- **Uninstall**: `chrome://extensions` → BlockFlow → **Remove**. The browser deletes all of the data
  above with it. Re-installing starts empty (with the two examples).

## See also

- [Getting Started](Getting-Started.md): your first workflow, step by step
- [Troubleshooting](Troubleshooting.md)
- [Capabilities and Limitations](Capabilities-and-Limitations.md)
- [Build and Release](Build-and-Release.md): the build and manifest, for developers
- README: [Other browsers](../../README.md#other-browsers) · [Known limitations](../../README.md#known-limitations)
