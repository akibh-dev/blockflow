# Using the Editor

A tour of every part of the BlockFlow editor, for people building workflows by hand. If you have never used
it, do [Getting Started](Getting-Started.md) first; this page is the reference to come back to.
(How the editor is built: [Editor](Editor.md) and [Editor Components](Editor-Components.md).)

## Opening it

Click the BlockFlow toolbar icon. It opens the editor in a tab, or switches to the editor tab if one is already
open. Keep to one editor tab: two editor tabs open at once overwrite each other's changes.

Everything saves automatically, a moment after each change. There is no Save button.

## Layout

| Area | What is there |
| --- | --- |
| **Header** | The open workflow's name (click to rename), its **On/Off** switch, **● Record**, **↶ ↷** (undo, redo), **Tidy up**, **Export as script**, **▶ Run**, **◉ Run with trace**, **🐞 Debug** with **pause on error**, **■ Stop** while a run is going on, the last run's result, a red **N problems** count, and the page tabs: **Canvas**, **All workflows (N)**, **Reports**, **Data**, **Secrets** |
| **Sidebar** (left) | The workflow list and the block palette. Stays visible on every page |
| **Canvas** (middle) | The blocks of the open workflow |
| **Settings panel** (right) | The settings of the selected block. Canvas page only |
| **Bottom panel** | **Run log** and **Runs** |

## Workflows in the sidebar

At the top of the sidebar, under **Workflows**:

- **+ New ▾**: **Blank workflow**, or one from a template (see [Templates](#templates)).
- **Import**: one or more files: scripts (`.script.json`) or graphs (`.blockflow.json`).
- A **Search…** box appears once you have more than four workflows.
- Each row: the **dot** switches the workflow On (green) or Off (grey); click the name to open it; double-click to
  rename. On hover: ✎ rename, ⧉ duplicate, ⬇ export to a file, 🎭 download as a Playwright test, 🗑 delete
  (asks first in a small dialog, **Delete** or **Cancel**/Esc; cannot be undone). Deleting a workflow also
  removes what its blocks remembered (Watch Element's last value and the like) and its pending timers.

Switching a workflow On is refused, with the reasons, while it has problems or no blocks. Duplicated and
imported workflows always arrive **Off** with fresh ids.

Messages (why something was refused, import results, …) appear as small notes in the bottom right corner and
go away by themselves; × closes one sooner.

## All workflows page

Header → **All workflows (N)**: a table of every workflow with an On switch (greyed out, "Fix the problems
first", while the workflow has problems), name (and problem count), its blocks as icons, last activity (when
its latest run ended, and its result), and **Edit**, **Duplicate**, **Export**, **Playwright**, **Delete**.
The bar on top has search, **+ New ▾**, **Import**, **Export all** (or **Export selected (N)** when you tick
rows), **Turn all on** (workflows with problems stay off; one note names them) and **Turn all off**.

## Block palette

Under **Blocks** in the sidebar: every block, grouped as Start, Tabs, Page actions, Read & scrape, Test,
Logic & loops, Data, Send & log. Start, Tabs and Page actions are expanded; click a group to open it.
**Find a block…** filters by name and description.

**Click** a block to add it near the top left of the canvas, or **drag** it to where you want it. A new block
starts with its default settings and is selected.

## Canvas

- **Connect**: drag from a block's right dot (output) to another block's left dot (input). Blocks with
  several outputs show one labelled dot each (`true`/`false`, `each`/`done`, `error`); connections leaving
  those are labelled too. A block cannot be connected to itself.
- **Select**: click a block or a connection. Shift-drag draws a selection box (React Flow's default) for copying
  several blocks.
- **Delete**: select, then Delete or Backspace. Deleting a block removes its connections.
- **Move around**: drag the background to pan, scroll or pinch to zoom; the controls at the bottom left zoom
  and fit everything in view; the minimap at the bottom right can be dragged and zoomed.
- Each block shows its icon, name, a one-line summary of its settings, its note, and badges: **!** for a
  problem (hover for the reason), and after a run ✓ passed, ✕ failed, ↪ handled, ⤼ skipped, ⏳ running.
  Disabled blocks say "Disabled: passes data through".

An empty workflow shows a hint: add blocks from the left, then drag from one block's right dot to another's
left dot.

## Settings panel

Select one block to see, from top to bottom:

1. Its name and description.
2. Any optional permission it needs, with a **Grant** button (Run Script asks for `userScripts`).
3. Its **problems**, if any (a required field empty, an invalid URL, …).
4. Its **settings**, generated from the block's definition:
   - Text fields marked "supports `{{…}}`" in the [block reference](../guide/blocks.md) suggest data names when
     you type `{{`: outputs of the blocks before it, keys seen in its last run, and `secret.*`.
     Use ↑ ↓ and Enter or Tab to pick one.
   - Element fields have **🎯 Pick on page** (below).
   - Tables (Fill Form fields, Extract List fields, Start values…) have **+ Add row**, ✕ per row, 🎯 per
     locator cell, and on Fill Form, **🎯 Detect fields**.
   - Run Workflow has a list of your other workflows.
   - Open Tab has **📸 Snapshot page** ([below](#snapshot-page)).
5. **Last run**: status, duration, attempts, which output it took, the error with its small **error code**
   (`locator.strict`, `assert.failed`…, listed in the [usage guide](../guide/README.md#error-codes)) and,
   when a locator matched several elements, which ones, a screenshot if one was taken,
   and the full **Input** and **Output** data. Shows the run you picked in the Runs tab, or the latest.
   **⤵ Run from here** runs this block and what follows it with its input from the workflow's latest run that
   reached it (disabled, with the reason, when none did, or when that input was too big to keep in full or
   holds hidden secrets).
6. **Step settings**: On error, Retries, Timeout, Screenshot of the tab, Use real mouse and keyboard
   (debugger; only on blocks that act on the page: Click, Fill, Fill Form, Select Option, Check, Press Key,
   Paginate), **Pause here (breakpoint)**, **Trace this step**, Disabled, Note. Opens by itself and says "(changed)" when any is set. Meaning:
   [Concepts](Concepts.md#step-settings).
7. **Data this block passes on**: the keys it adds, as `{{key}}`.
8. **Delete block**.

## Element picker

**🎯 Pick on page** next to an Element field:

1. BlockFlow switches to a tab. For **Watch Element** and **Read Element** with a **Page URL** filled in, it
   opens that URL in a new tab. Otherwise it uses the web tab you used most recently (not the editor), so
   **open the page first**. With no web tab open it says "Open the page you want to watch in a tab, or type
   its URL first."
2. A bar appears on the page. Hover to highlight, click to choose. The page does not react to these clicks.
3. Adjust with **▲ Broader** / **▼ Narrower** (↑ / ↓). The bar shows the selector and how many elements match.
4. **✓ Use this** (Enter) fills the field and brings you back to the editor. **✕** or Esc cancels.

Action fields (Click, Fill, …) get the most readable unique locator (`role=button[name="Save"]`,
`label=Email`, `testid=…`). Watch Element and Read Element get a structural CSS selector, which keeps working
when the text changes. **Other ways to find it** lists alternatives; click one to switch.

**🎯 Detect fields** (Fill Form): click any field of a form, and every field of that form is listed with a
hint. Fill in the values you need; empty ones are skipped.

The page agent and picker are injected only when you use them; nothing runs in your pages otherwise.

## Snapshot page

**📸 Snapshot page** on an Open Tab block copies an outline of the page to the clipboard: every heading,
link, field and button with its name, state and a locator that finds exactly it, e.g.
`- button "Sign in" [ref=e12] locator=role=button[name="Sign in"]`. Paste it into a chat with a model and
ask for a workflow: the locators can be used as they are.

It opens the block's URL in the picker's tab (or reuses that tab when it already shows the page; with no
URL, the web tab you used last), takes the snapshot, and brings you back to the editor with a toast saying
how many lines were copied. Long pages are cut at 1,500 lines with a note; to see one part only, or to keep
a snapshot with a run, use the **Page Snapshot** block (it has a "Part of the page" locator). Format:
[Page Protocol: The snapshot op](Page-Protocol.md#the-snapshot-op).

## Recorder

**● Record** turns what you do on a page into blocks:

1. Press **● Record**. BlockFlow asks which page to record on (suggesting the workflow's first Open Tab URL)
   and opens it in a new tab.
2. Use the page normally. Typing, selects, checkboxes, clicks, Enter and page changes are recorded. The header
   button shows **■ Stop recording (N)** with the number of steps.
3. The toolbar on the page has **Assert text** and **Assert visible**: the next element you click is checked
   instead of clicked.
4. Press **Stop** on the page's toolbar or **■ Stop recording** in the editor.

The blocks appear on the canvas as one connected line starting with its own **Open Tab**: one Fill per field,
or **Fill Form** (with the click as submit) for two or more fields followed by a click; Click, Select Option,
Check, Press Key; **Wait For** URL after a page change; **Assert** for the toolbar checks. Passwords are never
recorded: the block uses `{{secret.password}}`, and the editor reminds you to create that secret on the
**Secrets** page.

## Templates

**+ New ▾ → From a template** (sidebar or All workflows) creates a workflow from one of the
[guide's examples](../guide/README.md#16-examples): API uptime check, Checkout test (adds two workflows: a
reusable login and a test that calls it), Daily API snapshot, Dark mode on akibh.dev, Data-driven login test,
Login test, Price drop alert, Scrape all pages to CSV, Try it: playground tour. Most use example URLs; change
URLs and locators to your site. Template workflows start **Off**.

### The Try it card

On first use a **Try BlockFlow in a minute** card sits at the top right of the canvas. It points at a
practice page in the repository (`docs/manual-test/playground.html`): run `npm run playground` in the
BlockFlow folder and the card turns to **● running**. **Create the Try-it workflow** adds *Try it: playground
tour* (Open Tab → Click → Fill → Select Option → Click → Assert → Log); press **▶ Run** and watch it work
the page. × closes the card for good. (The practice page is served from your machine rather than built into
the extension because browsers do not let an extension act on its own pages.)

## Undo, redo and shortcuts

Shortcuts work on the Canvas page, when you are not typing in a field. Cmd works in place of Ctrl on a Mac.

| Keys | Does |
| --- | --- |
| Ctrl+Z | Undo (also the ↶ button) |
| Ctrl+Shift+Z or Ctrl+Y | Redo (also ↷) |
| Ctrl+C / Ctrl+V | Copy / paste the selected blocks and the connections between them. Pasted blocks land where the mouse is (a little below and right of the copy when the mouse is off the canvas or has not moved). Paste works in another workflow too |
| Ctrl+D | Duplicate the selection (next to it) |
| Delete / Backspace | Delete the selection |
| Enter / Esc / ↑ ↓ | In the element picker: use / cancel / broader, narrower |

**Tidy up** (header) lays the open workflow out in columns, left to right in the order data flows, with
If's `true` above `false` and loop bodies above what comes after the loop. It is one undo step, so Ctrl+Z puts
the blocks back where they were.

Undo covers blocks, connections, positions and settings (quick changes in a row count as one step), up to 100
steps. Each workflow has its own history, kept while you switch between workflows (until the editor tab is
reloaded or closed).

## Run, Stop and the On switch

- **▶ Run** runs the open workflow once, now, whether it is On or Off. A Timer or Schedule at the start fires
  immediately; Watch Element reads once; Page Visited and Context Menu use the tab you are on. Disabled while
  the workflow has problems or no blocks.
- **◉ Run with trace** runs once and keeps pictures before and after every page step (see Reports).
- **🐞 Debug** runs once and pauses before every block with **Pause here (breakpoint)** ticked, and, with
  **pause on error** ticked, when a block fails. A banner shows the block, why it paused, the error and its
  input, and the element is outlined on the page: **▶ Continue** (to the next breakpoint), **⤼ Step** (this
  block, then pause again), **■ Stop**. You can close the editor while paused; the banner is back when you
  open it. A pause nobody answers ends the run after an hour.
- **■ Stop** shows while a run is going on (also a paused one), and stops it before the next block.
- Next to it, the result of the run being shown (`passed`, `failed`, …; hover for the error).
- **On/Off** runs the workflow in the background on its triggers, also with the editor closed. Editing a
  workflow while it is On restarts it.

On the **Suites** page, **↻ Re-run failed** on the last result runs only the workflows that failed or were
skipped.

When a **Manual Step** is waiting, a banner across the top says "*Workflow* is waiting for you: …" with
**Continue** and **Fail the run** (the desktop notification has the same buttons).

## Bottom panel: Run log and Runs

- **Run log**: timestamped lines from the open workflow: what started, what each block did, Log block messages,
  errors. Scrolls to the newest line.
- **Runs (N)**: one row per run, newest first: result, time, how it started (*Run button*, *turned on*,
  *schedule*, *page event*, *called by another workflow*),
  step count, duration, error. Click a row to show that run's badges on the canvas and its data in the
  settings panel.
- **all workflows**: show lines and runs of every workflow, labelled with the workflow name.
- **Clear** empties the tab you are on.

## Reports

Header → **Reports**: the last 40 runs of all workflows. Filter by workflow and result; the line on top
totals runs, passed, failed and time. Click a run for its steps (status, duration, attempts, output taken,
error and error code, screenshot), **open called run** for Run Workflow steps, and **show on canvas**.

**Export HTML** (one self-contained file with screenshots), **Export JUnit XML** (for CI dashboards) and
**Export JSON** export the runs currently shown. The JSON is versioned (`schemaVersion: 1`) and described
by [report.schema.json](../guide/report.schema.json): each step has its `code`, `locator`, page `url`,
`matches` and `sourceId` (the block's id in the file you imported). **Clear** deletes the history.

## Data

Header → **Data**: datasets written by **Save to Dataset**, newest first, with row counts. Click one to preview
its first 50 rows; **Download CSV**, **Download JSON** or **Delete**. The list refreshes every few seconds while
a run adds rows.

## Secrets

Header → **Secrets**: a table of name / value / "Use as". Add a name (letters, digits and `_`) and a value,
then **Add secret**. Values are hidden; **Show** reveals one; edit in place; **Delete** asks first. Use them
anywhere as `{{secret.name}}`. They are masked as `•••` in logs and reports, never exported, and stored
unencrypted in the browser profile.

## Import and export

- **Export** (⬇ in the sidebar, or All workflows → Export / Export all / Export selected) downloads a
  `.blockflow.json` file. Several workflows go in one file. Secrets are never included.
- **Export as script** (header) downloads the open workflow as `<name>.script.json`, a list of steps that
  is easier to read, diff and edit by hand or with an LLM. It is greyed out when the workflow cannot be
  written as steps (more than one start block, an output connected to several blocks, joins other than
  after an If); the button's tooltip says so.
- **Import** (sidebar or All workflows) reads one or more files, scripts or graphs, adds the workflows
  **Off** with new ids (Run Workflow links within a file keep working), opens the first one and switches to
  All workflows. Scripts, and graph files without positions, are laid out automatically.
  A bad file is reported and skipped; for a script the message names the step (`/steps/1/clik: Unknown
  block "clik". Did you mean "click"?`).
- The file format is documented for people and AI tools: [Workflows as Scripts](Workflows-as-Scripts.md),
  [usage guide §2](../guide/README.md#2-workflow-file-format).

## Playwright export

🎭 in the sidebar, or **Playwright** on All workflows, downloads the workflow as a Playwright test
(`.spec.ts`) to run in CI with `npx playwright test`. Secrets become environment variables
(`{{secret.loginPassword}}` → `LOGINPASSWORD`), Run Workflow calls become functions, and blocks Playwright has
no equivalent for become comments. Details: [usage guide §12](../guide/README.md#12-harder-pages).

## See also

- [Getting Started](Getting-Started.md) · [Concepts](Concepts.md)
- [Recipes](Recipes.md) · [Troubleshooting](Troubleshooting.md)
- [Usage guide §10, Building workflows in the editor](../guide/README.md#10-building-workflows-in-the-editor)
- Internals: [Editor](Editor.md) · [Editor Components](Editor-Components.md) · [Picker and Recorder](Picker-and-Recorder.md)
