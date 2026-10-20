# Lesson 7: BlockFlow code tour

Goal: read the real project with the vocabulary you now have, then extend it by yourself.

Read in this order. Each stop says what to look for and what to try. Budget one evening.

## 0. Setup

```bash
npm install && npm run check     # typecheck + tests
npm run dev                      # Chrome with hot reload
```

Then use the extension once: the "Try it end to end" section of the root `README.md`.

## 1. The product in one picture

A **workflow** is blocks (nodes) joined by connections (edges). A block's **output payload** becomes the
next block's **input**. A block with nothing feeding it is a **root** and starts the flow itself (a Timer
ticking, a Watch Element polling). Open `docs/ARCHITECTURE.md` for the diagram.

## 2. A block, the smallest unit: `src/core/blocks/timer.ts`

Find: `defaultConfig`, `fields` (the form the editor renders), `outputs` (documentation for wiring),
`start` (root behaviour), `run` (when fed), `onTimer` (when its timer fires).

Notice what it does **not** do: no `setInterval`, no variables for the tick count. `ctx.timers.set` and
`ctx.state` are the lesson 4 rules turned into an API. Then read `openUrl.ts` (the simplest block) and
`watchElement.ts` (the most realistic).

Try: change the Timer's `summary()` text, see it update on the block in the editor. You did not touch the
editor, because the editor renders whatever the registry contains.

## 3. The engine: `src/core/engine.ts`

`WorkflowRunner` wires blocks together. Find `start`, `handleTimer`, the function that passes a payload to
each outgoing connection, and `maxDepth` (loop guard). Read `tests/core/engine.test.ts` next to it; the
tests are the specification.

Key idea: **the engine never talks to the browser.** It talks to `Host` (`src/core/types.ts`):
`tabs.open`, `page.readElement`, `scheduler`, `state`, `now`. In tests that is `tests/helpers/fakeHost.ts`;
in the extension it is `src/browser/host.ts`. This is dependency inversion, and it is what let us test the
whole engine without a browser.

Try: add `console.log` to `run` of Open URL and run the Timer test. Remove it.

## 4. Templating: `src/core/template.ts`

`{{tick}}`, `{{$json.x}}`, `{{rows[0]}}`. Small, pure, heavily tested; a good "how would I write this"
exercise: read the tests first and try to implement `renderTemplate` yourself before reading it.

## 5. The browser layer: `src/browser/`

| File | What it is | Lesson |
| --- | --- | --- |
| `hybridScheduler.ts` | timers: alarms + in-memory + keep-alive | 4 |
| `scheduler.ts` | plugs the real `browser.alarms`/storage into it | 4 |
| `pageReader.ts`, `tabs.ts` | Watch Element's engine: own tab, reload, read | 5 |
| `picking.ts` | start/finish the element picker | 3 |
| `stores.ts` | storage wrappers | 4 |
| `host.ts` | assembles the `Host` | 6 |

Read `hybridScheduler.ts` with its test file `tests/browser/hybridScheduler.test.ts` open. The test uses a
fake clock; advancing time by hand is how you test timing code without waiting.

## 6. The worker: `src/entrypoints/background.ts`

About 140 lines. Check against lesson 4: top-level synchronous listeners ✔, no state in variables ✔,
`restoreAll()` at each start ✔, storage as the bus between editor and worker ✔ (`storage.onChanged` +
`diffWorkflows`).

## 7. The element picker: `src/dom/` + `src/entrypoints/picker.content.ts`

`selector.ts` decides *which* selector to propose (prefers stable ids, `data-testid`, avoids generated
class names like `css-1x2y3`). `picker.ts` is the overlay UI in Shadow DOM. The picker is a content script
(lesson 3) that talks to the worker by messages (`src/shared/messages.ts`).

## 8. The editor: `src/entrypoints/editor/`

An ordinary React app (React Flow for the canvas). The interesting file is `flow/convert.ts`: it converts
between the saved `Workflow` and React Flow's nodes/edges. Everything else is UI. If you know React you
can already read this directory.

## Project exercises (pick any, in rising difficulty)

1. **Delay-free logger block.** New block `log` that writes `{{message}}` to the run log and passes the
   payload on. Steps: `src/core/blocks/log.ts` → register in `index.ts` → a test using `fakeHost.ts`.
   The editor needs no change.
2. **Notification block.** Needs the `notifications` permission and a new `Host` method (`notify`). Touch
   `types.ts`, `fakeHost.ts`, `host.ts`, `wxt.config.ts`. This is how you extend the Host.
3. **IF block** with two outputs ("true"/"false"). The engine currently sends a payload to every outgoing
   connection; you must teach connections a "port". Read `convert.ts`, `types.ts` and `engine.ts` first and
   write the plan before the code.
4. **Cron-ish Timer** ("every day at 09:00"): needs `when` alarms and `restoreAll()` thinking.
5. **Import/export workflows** as JSON. Mostly validation: reuse `validate.ts`.

Rule for all of them (from `CLAUDE.md`): `src/core` stays free of browser APIs; payloads stay
JSON-serialisable; tests first for engine and block changes.

Next: [Lesson 8: Testing, debugging, publishing](08-testing-debugging-publishing.md)
