# Capabilities and Limitations

What BlockFlow can do today, what it can't, and why. Read this before you commit to BlockFlow for a
job, or when something you'd do in Playwright has no obvious block.

✅ supported · 🟡 partly · ❌ not yet · ⛔ not possible in an extension. "Chromium only" means Chrome, Edge
and Brave, using the optional `debugger` permission.

## Pages and elements

| Capability | Status | How |
| --- | --- | --- |
| Open pages, navigate, back/forward/reload | ✅ | Open Tab, Navigate |
| Several tabs, popups, `target=_blank` | ✅ | named tabs, Wait for Popup |
| Locators: CSS, text, role, label, placeholder, testid, alt, title, XPath, chaining, `nth` | ✅ | [usage guide §4](../guide/README.md#4-elements-locators) |
| Iframes, including cross-origin | ✅ | `frame=<css> >> …`; Pick on page and Record write it |
| Open shadow roots (web components) | ✅ | `host >>> inner`; Pick on page and Record see inside |
| Closed shadow roots | ⛔ | the page hides them from everyone |
| Locator filters (`has`, `has-text`, `visible`, or) | ❌ | planned |
| Click, double, right, hover, fill, type key by key, select, check, press keys | ✅ | page blocks |
| Click with modifiers, any button, at a position, n clicks | ✅ | Click (`button`, `modifiers`, `position`, `clickCount`; real input too) |
| Focus, blur, clear, scroll into view, dispatch an event | ✅ | Element Action |
| Trusted (`isTrusted`) input | 🟡 | `realInput` step setting, Chromium only (also inside iframes) |
| Record a task as blocks (also in iframes, web components and popups it opens) | ✅ | ● Record; continues an existing workflow after the selected block |
| File upload through `<input type=file>` | ✅ | Upload File: text, a URL, or base64 data (HTTP Request `responseType: base64`) |
| File drop zones | ✅ | Upload File `target: dropzone` (synthetic drop with a DataTransfer) |
| Drag and drop | ✅ | Drag: HTML5 (draggable) and pointer-event drags (sliders, sortables); with real input through CDP drag interception (Chromium) |
| `alert` / `confirm` / `prompt` | ✅ | Dialogs |
| Run your own JavaScript in the page | 🟡 | Run Script: Chrome 135+ with user scripts allowed |

## Waiting and checking

| Capability | Status | How |
| --- | --- | --- |
| Auto-wait for visible, enabled, stable, not covered | ✅ | every action |
| Wait for element, text, URL, load, network idle, API response | ✅ | Wait For |
| Assert text, value, attribute, count, visible/hidden, enabled, checked, URL, title | ✅ | Assert (retries like `expect`) |
| Soft asserts | ✅ | `soft: true` |
| Assert class, CSS, focus, in-viewport | ❌ | planned |
| Visual comparison (screenshots against a baseline) | ❌ | planned |

## Data and scraping

| Capability | Status | How |
| --- | --- | --- |
| Lists and tables from a page or from HTML | ✅ | Extract List, Extract Table |
| Pagination and infinite scroll | ✅ | Paginate, Scroll |
| HTTP requests (APIs, static pages) | ✅ | HTTP Request |
| Expressions, loops, filters, CSV/JSON input | ✅ | Transform, For Each, Filter, Data Table |
| Keep results, download CSV/JSON | ✅ | Save to Dataset, Download, the Data page |
| Read page storage and cookies | ✅ | Page Info |
| Set or clear cookies and storage | ❌ | planned |
| Wait for a file the page downloads | ❌ | planned |

## Running

| Capability | Status | How |
| --- | --- | --- |
| Run by hand, on a timer, on a schedule | ✅ | ▶ Run, Timer, Schedule |
| Run when a page opens, from the right-click menu, when an element changes | ✅ | Page Visited, Context Menu, Watch Element |
| Reuse workflows (login once, call it from tests) | ✅ | Run Workflow |
| Retries, timeouts, error branches per step | ✅ | step settings |
| Wait for a person (CAPTCHA, 2FA) | ✅ | Manual Step |
| Reports: HTML, JUnit XML, JSON, with screenshots | ✅ | Reports page |
| Run in CI | 🟡 | export to Playwright; a CLI runner is planned |
| Headless | ⛔ | an extension lives in a visible browser (the CLI runner will start one for you) |
| Fresh browser profile per test | ⛔ / ❌ | profiles are shared; "clean site data before run" is planned |
| Test suites with parallel workers | ❌ | planned: a Suite view runs several workflows in sequence with one report |
| Mock or block network requests | ❌ | planned (Chromium) |
| Emulate device, viewport, location, timezone, offline | ❌ | planned (Chromium) |
| Step-through debugging, trace viewer | ❌ | planned; today, click a block after a run to see its input and output |

## Driving it from outside

| Capability | Status | How |
| --- | --- | --- |
| Write workflows as JSON (people or LLMs) | ✅ | [Workflows as Scripts](Workflows-as-Scripts.md) |
| JSON Schema and generated block reference | ✅ | [workflow.schema.json](../guide/workflow.schema.json), [blocks.md](../guide/blocks.md) |
| Strict validation with exact error locations | 🟡 | validation exists; unknown settings are ignored today |
| Let an LLM run a workflow and read the result itself (MCP) | ❌ | planned |
| Export to Playwright | 🟡 | most blocks; BlockFlow-only blocks become comments |

## Browsers

| Browser | Status |
| --- | --- |
| Chrome, Brave, Edge | ✅ main target. End-to-end tests run in Chromium 131 and Brave; Chrome and Edge use the same build |
| Firefox | ✅ verified with `npm run e2e:firefox` (Firefox 159): page actions, forms, scraping, datasets, uploads, popups, dialogs, screenshots. No `realInput`, no Run Script (Chromium only) |
| Safari | 🟡 builds; never converted or run |

## Things no extension can do

- Automate `chrome://` / `about:` pages, the web stores, other extensions or the built-in PDF viewer.
- Automate `file://` pages unless you enable "Allow access to file URLs".
- Solve CAPTCHAs (use Manual Step).
- Keep background tabs running at full speed: browsers throttle them. Open test tabs with
  `where: "window"`.

## See also

- [Roadmap](Roadmap.md): when the ❌ items are planned
- [Troubleshooting](Troubleshooting.md) · [What is BlockFlow](What-is-BlockFlow.md)
- [Usage guide: Limits](../guide/README.md#17-limits-what-a-browser-extension-cannot-do-or-blockflow-does-not-do-yet)
- [Home](Home.md)
