# BlockFlow on Safari

**Status: builds; not verified on a Mac.** The Safari build compiles and CI builds it on every change, but
nobody has loaded it into Safari yet. The checklist at the end is for the person who does.

## What the Safari build contains

`npm run build:safari` writes `.output/safari-mv3` (a Manifest V3 WebExtension). Compared with Chrome it leaves out
what Safari does not provide, and the code refuses clearly (error `permission.missing`) instead of crashing:

| Feature | Safari | What happens |
| --- | --- | --- |
| Real mouse/keyboard input, background-tab and full-page screenshots, response bodies, Route mocking, Emulate, HAR, console capture (`debugger`) | No | the step fails with `permission.missing` ("needs the debugger permission, Chromium only") |
| Run Script (`userScripts`) | No | fails with `permission.missing` |
| Clear Site Data by origin (`browsingData`) | No | fails with `permission.missing`; nothing is deleted |
| HTML parsing in the background (`offscreen`) | Not declared | uses the background page's DOM when it has one, otherwise fails with `permission.missing` ("use Extract on a page in a tab") |
| Route with browser rules (`declarativeNetRequest`) | Optional, unverified | abort/redirect rules may work; if the API is missing the Route block fails with `permission.missing` |
| Outside control (MCP server, CLI) | No | Settings shows "Not available in Safari": Safari starts native helpers only from the containing app, so the Node bridge cannot connect |
| Everything else (editor, page agent, Open Tab, Click, Fill, Assert, Timer, Watch Element, datasets, reports, suites) | Expected to work | **not verified** |

Unit tests (`tests/browser/safariGuards.test.ts`) remove each missing API from a mocked `browser` and check
the message.

## Convert and run (needs a Mac with Xcode)

```bash
npm run build:safari
xcrun safari-web-extension-converter .output/safari-mv3 \
  --project-location safari-app --app-name BlockFlow --bundle-identifier dev.akibh.blockflow
```

Open the generated Xcode project, build and run it, then in Safari: **Settings → Extensions → BlockFlow** →
switch it on and allow access to websites ("Always Allow on Every Website" while testing: the store build
asks per workflow, see [PRIVACY](PRIVACY.md)). During development enable **Develop → Allow Unsigned Extensions**.

## Manual verification checklist [HUMAN]

Run each, note the result in `docs/M6-NOTES.md`, then update "What has been verified" in the README.

1. The BlockFlow toolbar button opens the editor; create, save and reload a workflow.
2. Timer (10 s, repeat) → Log: runs while the workflow is On; survives Safari closing the background page
   for a minute (the heartbeat alarm).
3. Open Tab (a local page, e.g. `docs/manual-test/playground.html` via `npm run playground`) → Click → Fill →
   Assert: passes.
4. Element picker and recorder work on a page.
5. Watch Element on a changing value starts a run.
6. Reports page: step details, screenshot of a failed step (`tabs.captureVisibleTab`).
7. Extract List on a page; Extract List on fetched HTML (`HTTP Request` → Extract) — note whether it works or
   which message appears.
8. The unsupported features above each show their `permission.missing` message (add a Run Script block, a Click
   with "Use real mouse and keyboard", a Clear Site Data block, an Emulate block).
9. Settings → Outside control shows "Not available in Safari".

## Known risks

- Safari may not support some `optional_permissions` names or `optional_host_permissions`; if the converter
  prints warnings, record them.
- `storage.session`, `scripting.executeScript` with `func`, and `webNavigation` events need Safari 16.4+.
- Safari ends non-persistent background pages quickly; the timer design (alarms as heartbeat) is written for
  this ([Scheduling and Timers](wiki/Scheduling-and-Timers.md)) but unverified there.
