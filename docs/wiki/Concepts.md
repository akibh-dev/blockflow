# Concepts

The ideas behind BlockFlow in plain words, for anyone building workflows in the editor or writing them as
JSON. Each section is short and links to the [usage guide](../guide/README.md), which has the exact details.

## Workflows and blocks

A **workflow** is a set of **blocks** joined by **connections**. A block does one step: open a tab, click,
fill a form, read a value, compare, loop, notify. There are 53 blocks, grouped in the palette as Start, Tabs,
Page actions, Read & scrape, Test, Logic & loops, Data, and Send & log. Every one is listed, with its
settings and defaults, in the [block reference](../guide/blocks.md).

Each block has **settings** (in the file: `config`) and **step settings** shared by all blocks (below).

Detail: [usage guide §1 Concepts](../guide/README.md#1-concepts).

## Connections and outputs

A connection goes from a block's **output** (right dot) to another block's **input** (left dot). One output
can feed several blocks: each branch runs in turn with its own copy of the data.

Most blocks have one output. Some have more, called **ports**:

- **If**: `true` and `false`.
- **For Each**, **Repeat**, **Paginate**: `each` (once per item or page) and `done` (afterwards).
- Any block whose **On error** step setting is *Send to the "error" output* gets an extra `error` output.

A path simply ends at a block whose output is not connected.

Detail: [§6 Branching](../guide/README.md#6-branching).

## Data (the payload)

A small JSON object travels along the connections. Each block receives it, and passes it on, usually
unchanged plus a few keys of its own. Read Element adds `value`, `previous`, `changed`, `count` and `url`;
HTTP Request adds `status`, `ok`, `body` and `data`. Each block's settings panel lists what it adds under
**Data this block passes on**.

After a run, click a block to see the exact **Input** and **Output** it had. That is the fastest way to
learn what is available.

Data has to stay plain JSON (text, numbers, true/false, lists, objects), because it is saved between steps
so a run can survive the browser putting the extension's worker to sleep.

## Templates `{{…}}` and expressions

Settings marked "supports `{{…}}`" in the block reference can use the data:

- `{{value}}`, `{{data.items[0].title}}`, `{{$json.value}}` (n8n style): a value from the data.
- `{{secret.loginPassword}}`: a secret.
- `{{ price * 1.1 }}`, `{{ upper(name) }}`, `{{ len(rows) > 0 ? 'some' : 'none' }}`: an **expression**.

Expressions are a small, safe formula language (no JavaScript runs) with math, comparisons, `&& || !`,
`a ? b : c`, and functions such as `sum`, `pluck`, `sort`, `split`, `replace`, `matches`, `extract`,
`today()`. Some settings take an expression directly, without braces: For Each / Filter **list**,
Transform, Save to Dataset and Download **value**.

A template always produces text; a missing key becomes empty text. Typing `{{` in the editor suggests names.

Detail: [§3 Data and templates](../guide/README.md#3-data-and-templates) and
[Expressions](../guide/README.md#expressions).

## Start blocks and triggers

A block that nothing feeds is a **start block**. Some start blocks have their own **trigger**:

| Start block | Starts a run when… |
| --- | --- |
| Start | only by hand (▶ Run) or when another workflow calls it; gives named starting values |
| Timer | every N seconds (or once) |
| Schedule | at set times: daily at 09:00, weekdays, every hour, every N minutes |
| Page Visited | you load a page whose URL matches |
| Context Menu | you choose its item in the right-click menu |
| Watch Element | an element's text on a page changes |

Triggers only work while the workflow is switched **On**. **▶ Run** runs a workflow once, now, On or Off.
Any other block at the start runs once when the workflow is switched on. Timer has a second role: placed
**after** another block, it delays the flow by N seconds.

Detail: [§8 Starting a workflow](../guide/README.md#8-starting-a-workflow).

## Runs and steps

A **run** is one trip of data through the workflow. Each block it passes is a **step** with a status:
passed, failed, handled (it failed but the error was dealt with), or skipped. A run ends as passed, failed,
cancelled (■ Stop), or interrupted (the browser stopped the extension's worker in the middle; there is no
resume yet).

Runs are listed in the **Runs** tab under the canvas and on the **Reports** page, which keeps the last 40 runs
with step details and screenshots and exports them as HTML, JUnit XML or JSON. A run stops after 1000 blocks
as a guard against endless loops.

Detail: [§9 Running, results, reports](../guide/README.md#9-running-results-reports).

## Step settings

Every block has the same **Step settings** (collapsed under its settings):

| Setting | Meaning |
| --- | --- |
| On error | *Stop this path* (default; the run fails), *Continue with the same data*, or *Send to the "error" output* (`{{error}}` holds the message) |
| Retries | 0 to 5 extra attempts, after 1 s, 2 s, 4 s… |
| Timeout | how long before the step fails (page actions 30 s, Open Tab 45 s, Assert 10 s, most others 60 s) |
| Screenshot of the tab | when something goes wrong (default), always, or never |
| Use real mouse and keyboard | trusted input through the browser debugger, for sites that ignore synthetic events (Chromium, optional permission) |
| Pause here (breakpoint) | a **🐞 Debug** run pauses before this block (Continue / Step / Stop); normal runs ignore it |
| Trace this step | keep pictures before and after this block (and its element's box) in the run's trace, also in a normal run |
| Disabled | skip the block, pass the data through |
| Note | a comment shown on the block |

Detail: [§7 Step settings](../guide/README.md#7-step-settings-every-block),
[§5 Waiting and timeouts](../guide/README.md#5-waiting-and-timeouts).

## Tabs and named sessions

Page blocks (Click, Fill, Read Element without a URL, Extract List, Assert on the page, …) act on a tab that
belongs to the run. **Open Tab** opens it and gives it a **name**, `main` by default. Later blocks find the
tab by that name through their **Tab** setting. That is why every page block needs an Open Tab (or a Page
Visited / Context Menu start, which provide `main`) earlier on the same path.

Use a second name (`admin`, `popup`) to work with two tabs in one run: another Open Tab, or **Wait for Popup**
for a tab the page opens itself. A workflow called with **Run Workflow** gets the caller's tabs, so a
reusable "Log in" workflow works in the caller's tab.

Open Tab can open a new tab, the workflow's own tab (reused every run), a new window (best for tests and
screenshots: background tabs are throttled), or the tab you are looking at.

Watch Element, and Read Element with a **Page URL**, are different: they use BlockFlow's own background tab,
never yours.

## Locators

Every "Element" setting takes a **locator**, Playwright style: CSS (`#save`), or readable forms like
`text=Sign in`, `role=button[name="Save"]`, `label=Email`, `testid=submit`, combined with `>>`
(`#cart >> text=Remove`, `li >> nth=0`) and reaching into iframes with `frame=#pay >> …`. **🎯 Pick on page**
writes one for you.

Actions are **strict**: a locator that matches two elements makes the step fail instead of clicking the wrong
one. Every action **waits** until its element exists, is visible, enabled, still and not covered.

Detail: [§4 Elements: locators](../guide/README.md#4-elements-locators); internals: [Locators](Locators.md).

## Secrets

Passwords and tokens go on the **Secrets** page as name/value pairs and are used as `{{secret.name}}`.
They are shown as `•••` in the log, the step inspector and reports, never enter the run data, and are never
exported with a workflow. They are stored unencrypted in the browser profile's extension storage. The
recorder never records passwords; it writes `{{secret.password}}` and asks you to create that secret.

Detail: [§11 Secrets](../guide/README.md#11-secrets).

## Datasets

**Save to Dataset** adds rows to a named **dataset** kept in the browser (append or replace), so data can grow
over many runs: scraped products, an API's daily numbers. The **Data** page shows each dataset and downloads it
as CSV or JSON. **Download** writes a CSV/JSON/text file to your Downloads folder directly. **Data Table**
goes the other way: paste CSV or JSON rows to feed a data-driven test.

Detail: [§14 Scraping and data](../guide/README.md#14-scraping-and-data).

## Workflow files

A workflow is a JSON document. Export writes `.blockflow.json` files; Import reads them (they arrive **Off**,
with new ids). Because the format is documented and has a [JSON Schema](../guide/workflow.schema.json),
an AI tool can write workflows for you. See [Workflows as Scripts](Workflows-as-Scripts.md) and
[§2 Workflow file format](../guide/README.md#2-workflow-file-format).

## See also

- [Getting Started](Getting-Started.md) · [Using the Editor](Using-the-Editor.md)
- [Workflows as Scripts](Workflows-as-Scripts.md) · [Recipes](Recipes.md)
- [Capabilities and Limitations](Capabilities-and-Limitations.md)
- [Usage guide](../guide/README.md) · [Block reference](../guide/blocks.md)
