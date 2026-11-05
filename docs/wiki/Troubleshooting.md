# Troubleshooting

For anyone whose workflow fails or does not start, and for LLMs repairing a workflow from its error
message. Answers are organised by the message you see; the quoted texts are the real messages from the code
(`<locator>`, `<element>` and numbers vary).

Where messages come from: the page agent ([src/dom/agent.ts](../../src/dom/agent.ts),
[src/dom/locator.ts](../../src/dom/locator.ts)), the page driver
([src/browser/pageDriver.ts](../../src/browser/pageDriver.ts),
[src/browser/navigation.ts](../../src/browser/navigation.ts)), the blocks
([src/core/blocks](../../src/core/blocks)) and validation ([src/core/validate.ts](../../src/core/validate.ts),
[src/core/config.ts](../../src/core/config.ts)).

## Where to see what happened

| Place | What it shows |
| --- | --- |
| The canvas after a run | ✓ passed, ✕ failed, ↪ error handled. Click a block to see its **input and output** and the error for that run. |
| **Run log** tab (bottom panel) | Log lines of the open workflow, including retries and Log blocks. Tick **all workflows** to see every workflow's lines. |
| **Runs** tab (bottom panel) | Recent runs (by ▶ Run and in the background). Click one to show it on the canvas. |
| **Reports** (header) | The last 40 runs with each step's status, attempts, duration, error and screenshot. Export HTML, JUnit XML or JSON. |
| Service worker console | Errors outside a run (a trigger that failed to start, storage problems), logged as `[BlockFlow] … failed`. Chrome/Brave/Edge: `chrome://extensions` → Developer mode → BlockFlow → **Inspect views: service worker**. Firefox: `about:debugging` → This Firefox → BlockFlow → **Inspect**. |

Screenshots are taken when a step fails (step setting `screenshot`, default `error`), of the run's tab,
and only while that tab is showing in its window. Use Open Tab with `"where": "window"` for tests.

## Element not found

> `Timed out after 30s: waiting for <locator>: no element matches`

Nothing on the page matched the locator for the whole timeout.

- Open the page and check the locator with **🎯 Pick on page** in the block's settings, or in DevTools.
- Text and role locators match the **accessible name**, not the HTML. `role=button[name="Save"]` needs a
  button whose visible text, `aria-label` or `aria-labelledby` contains "Save".
- The element may be in an iframe: prefix `frame=<iframe css> >> `. See [iframes](#iframes).
- CSS does not enter shadow roots by itself: use `host-element >>> inner-css`. The `text=`, `role=`,
  `label=`, `placeholder=`, `testid=` locators already look inside open shadow roots.
- The page may still be on the previous URL. Add a **Wait For** `mode: "url"` after the action that
  navigates.
- An Assert that cannot find its element fails with `Expected <check>, got no matching element`.

## Locator matches several elements

> `<locator> matches 3 elements (button.primary, button.primary, …). Make it more specific, or add ">> nth=0" for the first one.`

Actions (Click, Fill, Select Option, Check…) are strict like Playwright: they refuse to guess. Narrow the
locator (`#cart >> role=button[name="Remove"]`), use an exact name (`role=button[name="Save"][exact]`), or
pick one with `>> nth=0` (first) / `>> nth=-1` (last). Reads (Read Element, Assert text) use the first match
and do not complain.

## Element found but not actionable

Before acting, BlockFlow waits until the element is visible, enabled, editable (for Fill), still, and not
covered. If the timeout ends first, the message says which check failed:

| Message | Meaning and fix |
| --- | --- |
| `waiting for <element> to be visible` | Hidden by CSS, `[hidden]`, or zero size. Open the menu or tab that reveals it first. |
| `waiting for <element> to be enabled` | Disabled until something else happens (form valid, terms ticked). Do that first. |
| `waiting for <element> to be editable (it is read-only)` | A read-only field. Fill cannot change it. |
| `waiting for <element> to stop moving` | An animation never settles. Wait For a later state, or set `force: true` on Click. |
| `<element> is covered by <other>` | A cookie banner, modal or overlay sits on top. Click it away first (Click on its close button). |

`force: true` on Click skips these checks; use it only when the page really is clickable.

Wrong element type (fails at once, no waiting):

| Message | Fix |
| --- | --- |
| `<element> cannot be typed into. Use Select Option, Check or Click instead.` | Fill was pointed at a select, checkbox or button. |
| `<element> is not a <select>. Use Click to open custom dropdowns.` | A custom dropdown: Click it, then Click the option. |
| `waiting for option "X" in <element> (has: …)` | The option text or value does not exist (yet). The message lists what does. |
| `<element> is not a checkbox, radio or switch` | Check works on checkboxes, radios and `role=switch`/`checkbox` elements. |
| `A radio button cannot be unchecked; check another one instead` | Check the other radio. |
| `<element> is not a file input. Point at the <input type="file"> (it may be hidden).` | Upload File needs the input or its label, not a styled button. |

## Invalid locator

These fail at once: `Invalid role locator: role=…`, `Unknown role option [x]. Use name, exact, checked, level.`,
`Invalid CSS selector: …`, `Invalid XPath: …`, `Invalid regular expression: …`, `nth needs a whole number: nth=…`,
`Unknown locator type "x"`. Compare with the [locator table](../guide/README.md#4-elements-locators). Quotes
inside JSON need escaping: `"role=button[name=\"Sign in\"]"`.

## The site ignores clicks or typing

Some sites only react to real input (`event.isTrusted`). Turn on the step setting **Use real mouse and
keyboard** (`"step": { "realInput": true }`) on Click, Fill, Fill Form, Check or Press Key. It works in
Chrome, Edge and Brave, shows a "debugging this browser" bar while it acts, and asks for the `debugger`
permission the first time. It does not work inside cross-origin iframes.

## Timeouts

| Message | What timed out |
| --- | --- |
| `Timed out after 30s: <reason>` | A page action; the reason is the last thing it was waiting for (see above). |
| `Timed out after 45s waiting for <url> to load` | Open Tab or Navigate. Slow page: raise `step.timeoutSeconds`, or set `waitUntil: "none"` and Wait For an element. |
| `Timed out after 30s waiting for the network to be idle (N requests still loading)` | `networkidle` on a page that polls or streams. Use `load` plus a Wait For element instead. |
| `Timed out after 30s waiting for the URL to match <pattern> (it is <url>)` | Wait For URL. Check the pattern: plain text means "contains"; `*` stops at `/`, `**` does not. |
| `Timed out after 30s waiting for a response from <pattern> with status 2xx (saw status 500)` | Wait For response. The "saw status" part shows what came back. |
| `Timed out after 30s: no new tab was opened by this page` | Wait for Popup. The click did not open a window, or opened it before the block started watching. |
| `Timed out after Ns` | The block's whole step timeout (`step.timeoutSeconds`). |

Defaults: page actions 30 s, Open Tab and Navigate 45 s, Assert 10 s, Dialogs 15 s, Scroll 120 s, Run
Workflow 300 s, Paginate 1800 s, For Each and Repeat 3600 s (for all iterations together), most others
60 s. Change one block with `"step": { "timeoutSeconds": 90 }`; add `"retries": 2` for flaky steps.

## "No tab named "main" in this run"

> `No tab named "main" in this run. Put an Open Tab block (tab name "main") before this block.`

Page blocks act on a tab opened earlier **in the same run, on the same path**. Add an Open Tab before it,
or make the `tab` names match (Wait for Popup creates `popup`; Page Visited and Context Menu starts provide
`main`). A workflow called by Run Workflow inherits the caller's tabs. Also:

- `The tab was closed`: you (or a Close Tab block) closed it during the run.
- `The browser does not let extensions work on this page: …`: `chrome://` pages, the Web Store, other
  extensions, the PDF viewer. `file://` pages work only after "Allow access to file URLs" in the
  extension's details.

## Short timers pause or fire late

Browsers stop an extension's background worker when it is idle, and their alarms cannot fire more often
than every 30 seconds. BlockFlow handles this for you:

- Timers of **30 s or more** use browser alarms. They are reliable and cost nothing.
- Timers **under 30 s** (Timer, Watch Element interval) run in memory and keep the worker awake while the
  workflow is On. If the browser still stops the worker, a 30-second heartbeat alarm revives it: expect a
  gap of **up to 30 s**. This costs a little battery. Verified on Chromium; Firefox and Safari untested.
- If the worker is stopped **during** a run, that run is marked **interrupted**. There is no resume yet; the
  next trigger starts a fresh run.

Never build timing with Run Script `setTimeout`: the worker may be gone before it fires.

## A workflow does not start on schedule

Check in this order:

1. **Is it On?** Only workflows switched On run their triggers. ▶ Run runs once and does not schedule.
2. **Was turning it on refused?** A workflow with errors cannot be turned on; the notice lists the reasons.
   Fix the blocks with a problem badge.
3. **Is the browser running?** An extension cannot run while the browser is closed. After a restart:
   an overdue Schedule fires once about a second later (no burst of catch-up runs); a repeating Timer
   waits one full period.
4. **Page Visited** never fires for tabs BlockFlow opened itself, and fires on SPA route changes only with
   `when: "any"`.
5. **Context Menu** items appear only while the workflow is On.
6. Look at the service worker console (above) for `[BlockFlow] … failed`.

Good to know: a workflow whose first block has no trigger of its own (Open Tab, HTTP Request…) runs once
when you switch it **On**, not again when you edit it or the browser starts. **Start** runs only from ▶ Run
or a Run Workflow call. A Timer used as a delay waits inside the run for up to 600 s; longer delays continue
as a new run.

## Permissions

| Feature | Permission | What to do |
| --- | --- | --- |
| Real mouse and keyboard (`realInput`) | `debugger` (optional) | `Real input needs the "debugger" permission (Chrome, Edge, Brave). Tick "Use real mouse and keyboard" in the step settings again to grant it.` The browser only asks after a click in the editor. Not available in Firefox. |
| Run Script | `userScripts` (optional) | `Run Script needs Chrome 135 or newer, the "userScripts" permission (press Grant on the block), and "Allow User Scripts" (or developer mode) switched on for BlockFlow in chrome://extensions.` Not available in Firefox. |
| Any page access in **Firefox** | host access | Firefox does not grant site access on install: `about:addons` → BlockFlow → Permissions → allow all sites. Without it the picker, Watch Element and page blocks fail with a permissions error. Not yet verified on a real Firefox install. |

Blocks that need an optional permission show a **Grant** button in their settings until it is granted.

## Iframes

- Use `frame=<css of the iframe> >> <locator>`, e.g. `frame=#payment >> label=Card number`. Same-site and
  cross-site frames both work.
- While the frame is still loading you will see `waiting for the frame <src> to load`.
- Real input (`realInput`) inside cross-origin frames is not supported (clicks land at the wrong place).
- The picker and recorder do not reach inside iframes yet: write the `frame=` locator by hand.

## Shadow DOM

Open shadow roots work (`text=`/`role=`/`label=` search inside them; CSS needs `host >>> inner`). **Closed**
shadow roots cannot be reached by an extension's page script and are not supported. Run Script cannot reach
them either.

## Secrets

- Create them in the header → **Secrets** and use `{{secret.name}}` in any templated setting.
- A secret that does not exist renders as an **empty string**, with no error. If a login types nothing into
  the password field, check the secret's name (case matters).
- Values are shown as `•••` in logs, the step inspector, run records and reports. Values shorter than
  3 characters are not masked.
- Secrets are **not encrypted**: they live in the browser profile's extension storage. They are never
  included in exported workflows.
- In a Playwright export, `{{secret.loginPassword}}` becomes the environment variable `LOGINPASSWORD`.

## Importing a file fails

See [Workflows as Scripts: how errors show up](Workflows-as-Scripts.md#how-errors-show-up) for every
import and validation message. The common ones:

- `Import failed: This file is not valid JSON.`: a trailing comma or a comment. JSON allows neither.
- `Unknown block type "x"`: the type is not in the [block reference](../guide/blocks.md) (`openUrl` should be
  `open-url`, `navigate-to` does not exist…).
- `<Setting> is required`: a required config key is missing or empty.
- `A connection in "…" points at "x", which is not a block id.` / `Two blocks in "…" have the id "x".`: fix the
  edge's `source`/`target`, or give each node its own `id`.

## Other messages

| Message | Meaning |
| --- | --- |
| `Stopped: this run went through more than 1000 blocks. Is there a loop?` | A connection loops back. Use For Each, Repeat or Paginate for loops. |
| `Run Workflow is nested more than N levels deep. Does a workflow call itself?` | A workflow calls itself, directly or through another. |
| `The workflow to run was deleted` | Run Workflow points at a workflow id that no longer exists. Choose it again in the block. |
| `Failed by the user at a manual step` | Someone pressed Fail on a Manual Step. |
| `Element is required for this check` / `Attribute name is required` | Assert settings missing for the chosen `subject`. |
| `Element is required for "visible"` / `Text is required for the text modes` / `URL pattern is required for …` | Wait For settings missing for the chosen `mode`. |
| `sent data to an output it does not have: "x"` | An internal block error; report it. |

HTTP Request with **Stop the flow on HTTP errors** on currently ends the path without marking the run
failed. For monitoring, set `failOnError: false` and check `{{status}}` with Assert or If, as in the
[uptime recipe](Recipes.md#uptime-monitor).

## See also

- [Workflows as Scripts](Workflows-as-Scripts.md) and [Recipes](Recipes.md)
- [Capabilities and Limitations](Capabilities-and-Limitations.md)
- [Usage guide: waiting and timeouts](../guide/README.md#5-waiting-and-timeouts),
  [harder pages](../guide/README.md#12-harder-pages), [limits](../guide/README.md#17-limits-what-a-browser-extension-cannot-do-or-blockflow-does-not-do-yet)
- Internals: [Page Agent](Page-Agent.md), [Scheduling and Timers](Scheduling-and-Timers.md)
