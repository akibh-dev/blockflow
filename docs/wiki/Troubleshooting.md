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

## Error codes

Every failed step has an error code next to its message (in the settings panel's Last run, in Reports, and
as `code` in the JSON export, with the step's `locator`, page `url` and, for strict-mode errors, `matches`).
The code says what kind of failure it was; the message says the details. Defined in
[errors.ts](../../src/core/errors.ts).

| Code | What to do | Section |
| --- | --- | --- |
| `locator.not-found` | Check the locator against a **Page Snapshot** of that page; wait for the page or element first | [Element not found](#element-not-found) |
| `locator.strict` | Make it more specific (the `matches` say what it found) or add `>> nth=0` | [Locator matches several elements](#locator-matches-several-elements) |
| `locator.invalid` | Fix the syntax | [Invalid locator](#invalid-locator) |
| `element.not-visible`, `element.disabled`, `element.not-editable`, `element.covered`, `element.unstable` | Do what reveals, enables or uncovers it first | [Element found but not actionable](#element-found-but-not-actionable) |
| `element.wrong-type` | Use the block that fits the element (Select Option for `<select>`, Check for checkboxes, Upload File for file inputs) | [Element found but not actionable](#element-found-but-not-actionable) |
| `option.not-found` | Use one of the options the message lists | [Element found but not actionable](#element-found-but-not-actionable) |
| `timeout` | Raise the step timeout or wait for the right thing (text, URL, response, popup) | [Timeouts](#timeouts) |
| `assert.failed` | The page is not what the test expects: fix the expectation or the steps before it | [Where to see what happened](#where-to-see-what-happened) |
| `http.status`, `http.network` | Check URL, method, headers, body, and the host permission | [Other messages](#other-messages) |
| `navigation.failed` | Check the URL; raise the timeout for slow pages | [Timeouts](#timeouts) |
| `tab.missing`, `tab.closed` | Open the tab (Open Tab with that name) before the step; do not close it mid-run | [No tab named "main"](#no-tab-named-main-in-this-run) |
| `frame.unreachable` | Check the `frame=` part; the frame may not have loaded | [Iframes](#iframes) |
| `page.restricted` | Use a normal web page (not chrome://, the web store, about:) | [Permissions](#permissions) |
| `permission.missing` | Grant the permission on the block or in the extension settings | [Permissions](#permissions) |
| `script.error` | Fix the Run Script code | [Other messages](#other-messages) |
| `config.invalid` | Fix the setting the message names | [Importing a file fails](#importing-a-file-fails) |
| `workflow.failed` | Open the called run and fix its failing step | [Other messages](#other-messages) |
| `step.failed` | Anything else: read the message | |

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
permission the first time. It works inside iframes too (same-site and cross-site); if clicks inside a frame
land beside the element, the page is probably zoomed or the frame is CSS-transformed, which real input does
not account for.

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
- When `frame=` matches several iframes, each same-site one is searched; a cross-site one is used only when
  they find nothing. Point `frame=` at one iframe (`#id`, `[name=…]`, `[src*=…]`) if that is ambiguous.
- **Pick on page** and **● Record** work inside frames and write the `frame=` part for you. If picking in a
  frame says `Could not work out which frame this element is in`, the page around it did not answer
  BlockFlow's question (it blocks `message` events): write the `frame=` locator by hand. Frames the page
  adds after it has loaded are not recorded.

## Shadow DOM

Open shadow roots work (`text=`/`role=`/`label=` search inside them; CSS needs `host >>> inner`), and the
picker and recorder see inside them. **Closed**
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
- A recording names one secret per password field after its label or name (`{{secret.password}}`,
  `{{secret.adminPassword}}`…) and lists the names to create when it stops. Create them with exactly those
  names, or rename the `{{secret.…}}` in the blocks.

## Recording

- **The recording added a second chain.** Recording into a workflow that already has blocks continues
  after the selected block (or the last block of the main path) and connects to it. A recorded Open Tab is
  only left out when the workflow already has an Open Tab on the same site (same origin); otherwise the
  recorded one stays, connected after the anchor.
- **Steps in a popup.** The recorder follows tabs the page opens: a Wait for Popup block, then the steps
  there with `tab: "popup"`. With two popups open at once, steps in the older one are attributed to the
  newer one; fix their `tab` by hand.

## Importing a file fails

A file with any error is refused as a whole, and a **Cannot import <file>** dialog lists every problem:
level, code, the JSON path in your file, the message and a hint (often "Did you mean …?"). **Copy** copies
the list as text, e.g. to paste back to the AI tool that wrote the file. A file with only warnings imports;
the toast's **Details** shows them. Every code is explained in the guide's
[Repair table](../guide/README.md#repair-what-import-errors-mean); more in
[Workflows as Scripts: how errors show up](Workflows-as-Scripts.md#how-errors-show-up). The common ones:

- `json.invalid`: a trailing comma or a comment. JSON allows neither. The message gives the position.
- `node.type.unknown`: the type is not in the [block reference](../guide/blocks.md) (`openUrl` should be
  `open-url`, `navigate-to` does not exist…). The hint suggests the closest type.
- `config.key.unknown`: a typo (`locater`) or a key from another block. The hint names the right key or
  lists the valid ones.
- `config.required`: a required config key is missing or empty (or one another setting needs, like
  `locator` for an Assert on an element).
- `edge.endpoint.missing` / `node.id.duplicate`: fix the edge's `source`/`target`, or give each node its own
  `id`.
- `page.no-tab` (warning): a page block with no Open Tab before it on some path. Add one, or fix `tab`.

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
