# Chrome Web Store listing

**Name:** BlockFlow

**Category:** Developer Tools

**Short description** (limit 132 characters, 111 used):

> Playwright-compatible automation in your browser: build tests, form fillers and scrapers from connected blocks.

**Detailed description:**

> BlockFlow turns your own browser into an automation tool. Build workflows from connected blocks, like n8n,
> or write them as short JSON scripts, and run them with your own logins: nothing leaves your computer.
>
> **Test websites.** Open pages, click, fill forms and assert text, URLs and accessibility structure, with
> Playwright-style locators (`role=button[name="Sign in"]`, `label=Email`) that wait for the page. Failed steps come with a screenshot, the
> locator and the error code. Visual comparison against a baseline, a trace timeline with before/after
> pictures, breakpoints with Step / Continue, and "Run from here" help you find out why a run failed.
> Export a workflow as a real Playwright test.
>
> **Fill forms, scrape and watch.** Extract lists and tables across pages into datasets and CSV, watch a
> price or status and get a notification, run on a timer or schedule.
>
> **Mock and emulate (Chromium).** Mock, block or change network requests, emulate a phone, a location or a
> language, record network metadata as HAR, and fail a run on console errors.
>
> **For teams and AI agents.** Group workflows into suites with one JUnit report. Optionally let a local MCP
> server (for Claude and other assistants) or the `blockflow` command line runner validate, run and repair
> workflows in your browser: off by default, local only.
>
> **Private by design.** No account, no server, no analytics. Secrets can be protected with a passphrase. The
> extension asks for access to a site only when a workflow you run or switch on uses it.
>
> Open source. Some features need extra permissions (debugger, cookies, user scripts) that BlockFlow asks for
> only when a block needs them.

**Privacy policy URL:** the published `docs/PRIVACY.md` (the repository's raw or rendered page; fill in the URL
when the repository is public).

**Single purpose:** Automate tasks in the user's browser with workflows the user builds (testing sites,
filling forms, monitoring and scraping pages).

## Permission justifications (the dashboard asks for each)

| Permission | Justification |
| --- | --- |
| `storage`, `unlimitedStorage` | Stores the user's workflows, run history, settings and secrets on the device; screenshots and datasets can exceed the default quota |
| `alarms` | Timers and schedules that keep working when the background worker sleeps |
| `tabs` | Opens, switches and closes the tabs a workflow works on; reads their URL and title; takes screenshots of a tab |
| `scripting` | Injects the page agent (click, type, read), the element picker and the recorder into pages the user's workflow targets |
| `notifications` | The Notify block and prompts for steps that wait for a person |
| `webRequest` | Read-only observation to wait for network idle or a request/response; it does not block or change requests |
| `downloads` | The Download block and waiting for a download a workflow starts |
| `webNavigation` | The Page Visited trigger, single-page-app navigation and popup/iframe tracking |
| `contextMenus` | The Context Menu trigger |
| `offscreen` | Parses HTML a workflow fetched (Extract List / Table) without opening a tab |
| Optional: site access (`<all_urls>`) | Requested per workflow, for the sites that workflow uses; nothing at install |
| Optional: `debugger` | Real mouse/keyboard input, full-page screenshots, request mocking, device emulation, HAR and console capture; only when a block needs it |
| Optional: `cookies`, `userScripts`, `declarativeNetRequest`, `browsingData` | Cookies & Storage block; Run Script block; Route block browser rules; Clear Site Data block (only the origins the user lists) |
| Optional: `nativeMessaging` | "Allow outside control": a local bridge so the user's own MCP server or CLI can run workflows; off by default |

**Remote code:** none. All code ships in the package. (Run Script executes code the user writes, in the user
scripts world; BlockFlow never downloads code.)

## Data usage form

- Collects personal or sensitive user data: **No**. Everything stays on the device (see PRIVACY.md).
- Certify: not sold or transferred to third parties; not used for unrelated purposes; not used for creditworthiness.

## Images

Screenshots (1280×800) in `screenshots/`: canvas after a run, a traced report, suites, settings, secrets.
Store icon 128×128: `public/icon/128.png`. **[HUMAN]** create the small/marquee promo tiles if wanted.
