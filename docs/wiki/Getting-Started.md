# Getting Started

A hands-on first session for people who have [installed](Installing.md) BlockFlow and want to build
something. In about fifteen minutes you will run a template, build a small workflow yourself (open a page,
read a value from it, log it and show a notification), read the results, and switch it on so it runs by itself.

Words in **bold** are labels you will see on screen. For the ideas behind them, see [Concepts](Concepts.md).

## 1. Open the editor

Click the BlockFlow icon in the toolbar (its tooltip says "Open BlockFlow editor"). The editor opens in a tab;
clicking the icon again brings that tab back instead of opening a second one.

The page has five areas (full tour: [Using the Editor](Using-the-Editor.md)):

```text
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ BlockFlow [workflow name] [Off]  ● Record  ↶ ↷  ▶ Run      Canvas · All workflows ·   │
│                                                            Reports · Data · Secrets   │
├──────────────┬───────────────────────────────────────────────────┬────────────────────┤
│ Workflows    │                                                   │ settings of the    │
│  + New ▾     │              canvas (your blocks)                 │ selected block     │
│  Import      │                                                   │                    │
│ Blocks       │                                                   │                    │
│  (palette)   │                                                   │                    │
├──────────────┴───────────────────────────────────────────────────┴────────────────────┤
│ Run log · Runs                                                                        │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

## 2. Run a template

Templates are ready-made workflows. Start with one that works against a real public site:

1. In the sidebar, next to **Workflows**, click **+ New ▾** and choose **Dark mode on akibh.dev**.
   It opens on the canvas: **Timer → Read Element → If → Notify**.
2. Click each block to see its settings on the right. Read Element opens `https://akibh.dev` in BlockFlow's own
   background tab and checks whether `<html>` has the class `dark`. If checks `{{changed}}`, and only the
   **true** output leads to Notify.
3. Press **▶ Run** in the header. A Timer at the start fires straight away when you press Run.
4. Watch the blocks: each gets a badge, ✓ passed, ✕ failed, ↪ error handled. The header shows the run's
   result (`passed`). Notify did not run: on the first read there is nothing to compare with, so `changed`
   is false and If sent the data down its **false** output, which goes nowhere.
5. Click **Read Element**. Under its settings, **Last run: passed** shows the exact **Input** and **Output**
   data. The output has `value` (`"true"` or `"false"`), `previous`, `changed` and `count`.

That is the whole loop: build, Run, look at what each block received and produced. The template stays
**Off**, so it does nothing more on its own.

Other templates in **+ New ▾** (Login test, Price drop alert, Scrape all pages to CSV, …) point at
example URLs such as `shop.example.com`; change the URLs and locators before running them. They are the
same files as the [usage guide's examples](../guide/README.md#16-examples).

## 3. Build a workflow from scratch

We will build: **Open Tab → Read Element → Log → Notify**, which opens `https://example.com`, reads its
heading, writes it to the log and shows it in a notification.

### Create it

1. **+ New ▾** → **Blank workflow**. It is called "Workflow N"; click the name in the header and type a better
   one, such as "My first workflow". (In the sidebar you can also double-click a name, or use ✎.)
2. In another browser tab, open `https://example.com`. You need the page open for the element picker in a
   moment.

### Add the blocks

The **Blocks** palette in the sidebar is grouped (Start, Tabs, Page actions, Read & scrape, …) and has a
**Find a block…** search box. Click a block to add it, or drag it onto the canvas.

1. **Tabs → Open Tab.** In the settings panel:
   - **URL**: `https://example.com`
   - **Open in**: *this workflow's own tab (reused every run)*. Runs then reuse one tab instead of opening
     a new one each time.
   - Leave **Tab name** as `main`. The blocks after it find the tab by this name.
2. **Read & scrape → Read Element.**
   - Leave **Page URL** empty. Empty means "read the run's tab", the one Open Tab opened. (With a URL, Read
     Element would load that page in BlockFlow's own background tab instead.)
   - **Element**: press **🎯 Pick on page**. BlockFlow switches to the web tab you used most recently (the
     `example.com` tab from step 2) and shows a bar at the top of the page. Hover the heading
     "Example Domain" and click it. Use **▲ Broader** / **▼ Narrower** (or the ↑ / ↓ keys) if the highlight
     is too small or too big, then **✓ Use this** (or Enter). Esc cancels.
   - Back in the editor, the field holds a locator such as `h1` and a note says *Picked: "Example Domain"*.
     Below it, **Other ways to find it** offers alternatives; click one to use it instead.
   - **Read**: *its text*.
3. **Send & log → Log.** Its **Message** is already `{{value}}`: the value Read Element produced.
4. **Send & log → Notify.** **Title** `BlockFlow`, **Message** `The heading says: {{value}}`.
   When you type `{{` in a field, the editor suggests the names available there.

### Connect them

Every block has an input dot on the left and an output dot on the right. Drag from **Open Tab**'s right dot to
**Read Element**'s left dot. Then Read Element → Log, and Log → Notify. To remove a connection or a block,
click it and press Delete (or Backspace).

While something is wrong, the header shows **N problems**, the block gets a **!** badge (hover it for the
reason, or read the list at the top of its settings) and **▶ Run** is disabled. Typical ones: a required
field is empty, a URL is not valid, two blocks are not connected.

Changes save automatically. There is no Save button.

## 4. Run it and read the result

Press **▶ Run**. You should see:

- A tab opening `example.com` (Open Tab has **Switch to it** on by default; untick it to open quietly).
- The badges turning ✓ one after the other.
- A desktop notification "The heading says: Example Domain". (If none appears, check that your operating
  system allows notifications from the browser.)
- In the **Run log** at the bottom: a line from **Log** with `Example Domain`, plus BlockFlow's own lines.

Then look closer:

- Click **Read Element**: **Last run** shows its **Input** (what Open Tab passed on: `url`, `tabId`, …) and
  **Output** (the same plus `value`, `previous`, `changed`, `count`).
- Open the **Runs** tab next to **Run log**. Each run is a row with its result, time, how it started
  (*Run button*), step count and duration. Click an older run to show its badges and data on the canvas.
- Header → **Reports** lists every run with its steps and errors, and exports HTML, JUnit XML or JSON.

If a step fails, the block shows ✕, its **Last run** shows the error (for example "waiting for h1: no element
matches", or a timeout that says what it was waiting for), and a screenshot of the tab when one could be taken.
Fix the setting and press Run again. [Troubleshooting](Troubleshooting.md) lists common errors.

While a run is going on, **▶ Run** turns into **■ Stop**, which stops it before the next block.

## 5. Switch it on with a trigger

**▶ Run** runs once, now. To run by itself, a workflow needs a **start block** with a trigger and must be
switched **On**.

1. Add **Start → Timer**. Set **Seconds** to `300` (five minutes), leave **Repeat** ticked.
   (For fixed times, use **Start → Schedule** instead: every day at 09:00, every hour, every N minutes.)
2. Connect **Timer → Open Tab**. Now Timer is the only block with nothing feeding it, so it is the start block.
3. On **Open Tab**, untick **Switch to it** so it does not steal focus every five minutes.
4. Click the **Off** switch in the header so it reads **On** (or click the dot next to the workflow in the sidebar;
   a green dot means On).

The Run log shows "Timer started: every 300s"; the first run comes after 300 seconds. The workflow keeps
running while the browser is open, also with the editor closed. Switch it **Off** the same way.

Good to know:

- Editing a workflow while it is **On** restarts it (a Timer starts counting again).
- A workflow that is **On** but has no trigger block runs **once** when you switch it on, and again each time
  the browser or extension starts. Usually you want a trigger.
- For pure monitoring you often need no tab of your own: **Timer → Read Element (with a Page URL) → If → Notify**
  checks a page in BlockFlow's background tab, as the template in step 2 does. `{{previous}}` and
  `{{changed}}` compare with the last run.
- Timers under 30 seconds keep the browser's background worker awake (a little battery); 30 seconds and up
  use browser alarms.

## Next steps

- Fill a form: **Fill Form** with **🎯 Detect fields**, or press **● Record** and do it once by hand.
  See [Using the Editor](Using-the-Editor.md#recorder).
- Test a site: end with **Assert** blocks and read results in Reports.
- Scrape: **Extract List** → **Save to Dataset**, then the **Data** page.
- Have an AI write the workflow: [Workflows as Scripts](Workflows-as-Scripts.md).
- Ideas: [Recipes](Recipes.md).

## See also

- [Concepts](Concepts.md) · [Using the Editor](Using-the-Editor.md)
- [Usage guide](../guide/README.md) and [block reference](../guide/blocks.md)
- [Troubleshooting](Troubleshooting.md) · [Capabilities and Limitations](Capabilities-and-Limitations.md)
