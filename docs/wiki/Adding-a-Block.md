# Adding a Block

Step-by-step guide to adding a block type to BlockFlow, and a new page ability (agent op) when a block
needs to do something in a web page that no op covers yet. Read [Block Internals](Block-Internals.md) first
for the contract; this page is the recipe and the checklist.

**Source:** [src/core/blocks/](../../src/core/blocks/) (especially [index.ts](../../src/core/blocks/index.ts),
[setVariable.ts](../../src/core/blocks/setVariable.ts), [pressKey.ts](../../src/core/blocks/pressKey.ts)),
[src/core/page.ts](../../src/core/page.ts), [src/dom/agent.ts](../../src/dom/agent.ts),
[tests/helpers/fakeHost.ts](../../tests/helpers/fakeHost.ts), [scripts/guide.ts](../../scripts/guide.ts).

## The short version

1. Write `src/core/blocks/<name>.ts` exporting a `BlockDefinition<YourConfig>`.
2. Import it in `src/core/blocks/index.ts`, add it to the `export { … }` list, and put it in the right
   group of `BLOCK_GROUPS` (that sets its palette category and order).
3. Test it in `tests/core/*.test.ts` with `harness()` and `flow()` from `tests/helpers/fakeHost.ts`.
4. `npm run guide:sync`, and check `docs/guide/README.md` still tells the truth.
5. Update the learning material (`docs/learning/07-blockflow-code-tour.md` exercises, per
   `docs/learning/MAINTAINING.md`).
6. `npm run check`.

The editor, the background worker and the Playwright exporter need **no changes** for a block to work:
they all read the registry.

## Decide what kind of block it is

| It… | Implement | Model it on |
| --- | --- | --- |
| transforms the data and passes it on | `run` returning `{ ...input, … }` | [setVariable.ts](../../src/core/blocks/setVariable.ts), [transform.ts](../../src/core/blocks/transform.ts) |
| chooses between outputs | `ports` + `run` returning `routeTo(port, payload)` | [ifBlock.ts](../../src/core/blocks/ifBlock.ts) |
| outputs that depend on settings | `ports: (config) => [...]` (dynamic ports) + `routeTo` | [switchBlock.ts](../../src/core/blocks/switchBlock.ts) |
| loops | `ports: ['each', 'done']`, `await ctx.emit(…, 'each')` per item, return `routeTo('done', …)`, long `timeoutSeconds` | [forEach.ts](../../src/core/blocks/forEach.ts) |
| acts on the run's tab | `inPage(ctx, input, request)` + `locatorField()` + `tabField`, `timeoutSeconds: PAGE_TIMEOUT_SECONDS` | [pressKey.ts](../../src/core/blocks/pressKey.ts), [click.ts](../../src/core/blocks/click.ts) |
| calls something outside (HTTP, notifications, datasets) | a `ctx.host.*` method (add one to `Host` if needed, see below) | [notify.ts](../../src/core/blocks/notify.ts), [httpRequest.ts](../../src/core/blocks/httpRequest.ts) |
| starts the flow on a schedule | `start` (set timers), `onTimer` (emit), `trigger` (Run button) | [timer.ts](../../src/core/blocks/timer.ts), [scheduleBlock.ts](../../src/core/blocks/scheduleBlock.ts) |
| starts the flow on a browser event | `start` (log), `trigger`, pass-through `run`, plus a listener in `background.ts` calling `runner.handleEvent()` | [pageVisited.ts](../../src/core/blocks/pageVisited.ts) |
| needs to wait later (delay) | `ctx.timers.set(name, …, payload)` + `onTimer` → `ctx.emit` (the rest continues in a new run) | [timer.ts](../../src/core/blocks/timer.ts) |

Rules from [CLAUDE.md](../../CLAUDE.md) that apply to every block:

- `src/core` has no browser APIs or DOM types. Anything outside goes through `ctx.host`.
- No `setTimeout`/`setInterval` for workflow timing; use `ctx.timers` + `onTimer`, or `ctx.host.sleep()` for a
  short wait inside one step.
- Remember things in `ctx.state`, not in module variables (the worker restarts).
- Payloads, timer data and state stay JSON-serialisable.
- `import type` for type-only imports, relative imports only.
- **Dynamic ports** (`ports` as a function of the config, like Switch): return names in a stable order,
  never `error`, and never throw (they are computed for half-typed configs in the editor). Never read
  `def.ports` directly anywhere; call `nodePorts(def, { config, step })` (`src/core/ports.ts`), which every
  consumer (engine, check, validate, script, layout, exporter, editor) already does. Names must also work
  as script branch keys: avoid `id`, `step`, `onError`, the block's own type, and `out`/`done` (a port
  of that name becomes the script's continue port). When an output is renamed or removed, the editor
  moves or deletes its connections (`followPortChanges`); give a row being edited a stand-in name so
  typing reads as a rename.

## Worked example: a Split Text block

A data block that turns `"red, green, blue"` into a list For Each can loop over. It is modelled on Set
Variable (templated text in, one new key out) and Data Table (an `into` setting). This exact code was run
against the real engine with `FakeHost`.

### 1. The block file

`src/core/blocks/splitText.ts`:

```ts
import { DATA_ACCENT } from './dataCommon';
import type { BlockDefinition } from '../types';

/** Split Text settings: the (templated) text, the separator, and the payload key for the list. */
export interface SplitTextConfig {
  text: string;
  separator: string;
  into: string;
}

/** Split Text — turns "a, b, c" into a list, e.g. for For Each. Empty parts are dropped. */
export const splitTextBlock: BlockDefinition<SplitTextConfig> = {
  type: 'split-text',
  label: 'Split Text',
  description: 'Split a text into a list, e.g. "a, b, c" for For Each.',
  icon: '✂️',
  accent: DATA_ACCENT,
  defaultConfig: { text: '', separator: ',', into: 'items' },
  fields: [
    { key: 'text', label: 'Text', kind: 'text', required: true, templated: true, placeholder: '{{value}}' },
    { key: 'separator', label: 'Separator', kind: 'text', placeholder: ',', help: 'Empty = one item per line.' },
    { key: 'into', label: 'Save the list as', kind: 'text', placeholder: 'items' },
  ],
  summary: (config) => `split by "${config.separator || '\\n'}" → {{${config.into || 'items'}}}`,
  outputs: [
    { key: 'items', description: 'The parts, trimmed, without empty ones (or the name you chose).' },
    { key: 'count', description: 'How many parts.' },
  ],

  async run(ctx, input) {
    const parts = ctx.config.text.split(ctx.config.separator || '\n').map((part) => part.trim()).filter(Boolean);
    ctx.log('info', `Split into ${parts.length} part${parts.length === 1 ? '' : 's'}`);
    return { ...input, [ctx.config.into.trim() || 'items']: parts, count: parts.length };
  },
};
```

Things worth noticing:

- **`templated: true`** on `text` means the engine renders `{{tags}}` against the input before `run`, and
  the editor offers `{{…}}` suggestions. `separator` and `into` are not templated: they are literal.
- **`required: true`** is checked *after* rendering, so `{{missing}}` fails the step with
  `Split Text: Text is required` and `run` is never called. You do not re-check required fields in `run`.
- **`defaultConfig`** must have a value for every field key. Old workflows saved before you add a field get
  the default.
- **`summary`** gets the raw saved config (templates unrendered) and must never throw.
- **Rules between settings** ("`separator` is required when `mode` is `custom`") go in an optional
  `validate(config)` that returns `{ key, code, message }[]` (code `config.required` or `config.value`).
  Import checking (`check.ts`) reports them with the JSON path of the key and refuses the file; the
  editor shows the message on the block. See Wait For or Assert, and
  [Block Internals](Block-Internals.md#the-definition-contract).
- **Import is strict**: a config key that is not a field is `config.key.unknown`. If `run` still reads an
  old key, list it in `legacyKeys`.
- **Return `{ ...input, … }`** so `$session` (the run's tabs) and everything upstream keep flowing.

### 2. Register it

In `src/core/blocks/index.ts`: add `import { splitTextBlock } from './splitText';`, add `splitTextBlock` to
the `export { … }` list, and add it to the `data` group of `BLOCK_GROUPS` where it should appear in the
palette. Do not set `category` in the block; `createDefaultRegistry()` does that.

### 3. Test it

Block tests run the real `WorkflowRunner` against `FakeHost` (Node, no browser). `flow()` builds a
workflow from nodes and `[from, to]` / `[from, to, port]` edges; `harness()` wires a runner with the default
registry and collects logs and run records.

```ts
import { describe, expect, it } from 'vitest';
import { flow, harness } from '../helpers/fakeHost';

describe('Split Text', () => {
  it('splits a templated value into a list For Each can use', async () => {
    const h = harness(
      flow(
        [
          { id: 'v', type: 'set-variable', config: { name: 'tags', value: 'red, green,, blue' } },
          { id: 's', type: 'split-text', config: { text: '{{tags}}', into: 'colours' } },
          { id: 'each', type: 'for-each', config: { list: 'colours', as: 'colour' } },
          { id: 'log', type: 'log', config: { message: '{{index}}={{colour}}' } },
        ],
        [['v', 's'], ['s', 'each'], ['each', 'log', 'each']],
      ),
    );
    const run = await h.runner.runOnce();
    expect(run.status).toBe('passed');
    expect(run.steps[1]?.output).toMatchObject({ colours: ['red', 'green', 'blue'], count: 3 });
    expect(h.messages('info')).toEqual(expect.arrayContaining(['0=red', '1=green', '2=blue']));
  });

  it('fails clearly when the text renders empty', async () => {
    const h = harness(flow([{ id: 's', type: 'split-text', config: { text: '{{missing}}' } }], []));
    const run = await h.runner.runOnce();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('Text is required');
  });
});
```

Useful `FakeHost` / `harness` knobs (full list in [Testing](Testing.md)):

| Need | Use |
| --- | --- |
| Run the workflow once (Run button) | `await h.runner.runOnce()` → `RunRecord` |
| Switch it on, then fire a timer | `await h.runner.start(); await h.fire('tick')` (first timer whose name starts with `tick`) |
| Simulate a worker restart | `const fresh = h.restart(); await fresh.handleTimer(key)` |
| Control page-agent answers | `h.host.agent = async (tabId, request) => ({ … })` (throw to fail); inspect `h.host.actions` |
| Control HTTP | `h.host.httpHandler = async () => ({ status, ok, body })`; inspect `h.host.requests` |
| Move the clock | `h.host.advance(ms)`; `h.host.now()` is fixed at 2026-01-01 otherwise |
| Logs | `h.messages('info')`, `h.logs` |

Page blocks need an Open Tab before them in the test (`{ type: 'open-url', config: { url: 'https://shop.test' } }`)
or `$session` in the input; see the `chain()` helper in `tests/core/pageBlocks.test.ts`.

### 4. Docs and learning material

- `npm run guide:sync` regenerates `docs/guide/blocks.md`, `blocks.json` and the workflow JSON schema from
  the registry. `npm run guide:check` (part of `npm run check`) fails until you do.
- Check `docs/guide/README.md`: if the block is a start block, add it to the "Starting a workflow" table; if
  it changes how something is best done, fix the relevant section. Example workflows in
  `docs/guide/examples/*.blockflow.json` are validated by `tests/core/guideExamples.test.ts`.
- `README.md` lists every block in "The idea" table and states the block count; update both.
- Learning material: `docs/learning/MAINTAINING.md` maps "New block type" to the exercises at the end of
  `docs/learning/07-blockflow-code-tour.md` (remove an exercise if you just built it). If the block teaches
  a new extension concept, extend the lesson that covers it and run `node docs/learning/tools/sync-examples.mjs`.
- Optional: a Playwright mapping in `src/core/playwright.ts` (`statement()` switch; unmapped blocks export as
  `// <label>: no Playwright equivalent, skipped.`), a recorder mapping in `src/core/recording.ts`, a
  template in `src/entrypoints/editor/templates.ts`.

## When the block needs a new Host method

If the block needs something from the browser that `Host` does not offer (clipboard, cookies API…):

1. Add the method to `Host` in `src/core/types.ts` (plain data in and out).
2. Implement it in `createExtensionHost()` in `src/browser/host.ts` (or a new `src/browser/*.ts` module it
   calls). Add any permission to `wxt.config.ts`; optional ones can be offered with the block's
   `permissions` (only `'debugger'` and `'userScripts'` are typed today).
3. Add a fake to `FakeHost` in `tests/helpers/fakeHost.ts` that records calls, so tests can assert them.
4. Then write the block. See [Browser Host](Browser-Host.md).

## Adding a page op

Blocks never touch the DOM. They send an `AgentRequest` (`src/core/page.ts`) through
`ctx.host.page.act(tabId, request, timeoutMs)`; the browser side injects the page agent
(`src/dom/agent.ts`) and asks it again and again until it answers `done`/`error` or the time runs out. See
[Page Protocol](Page-Protocol.md) and [Page Agent](Page-Agent.md).

Example: a `focus` op ("put the cursor in this field" without typing), in the order CLAUDE.md asks for.

### 1. The request type, `src/core/page.ts`

Add a member to the `AgentRequest` union. Keep it plain JSON (it travels through `scripting.executeScript`):

```ts
  /** Focus an element (waits until it is visible and enabled). */
  | { op: 'focus'; locator: string }
```

TypeScript now reports the agent's `switch (request.op)` as not returning on every path, which is your
to-do list.

### 2. The agent, `src/dom/agent.ts`, test first

Write the jsdom test in `tests/dom/agent.test.ts` (it uses the real agent on `document`):

```ts
it('focus puts focus on the element', async () => {
  page('<input id="a"><input id="b">');
  expect(await run({ op: 'focus', locator: '#b' })).toMatchObject({ status: 'done' });
  expect(document.activeElement?.id).toBe('b');
});
```

Then add the case next to the other actions:

```ts
      case 'focus': {
        const element = one(request.locator);   // strict: 0 matches = Pending, 2+ = Fatal
        ready(element, { enabled: true });      // throws Pending until visible, enabled, stable
        focus(element);
        return { focused: describeElement(element) };
      }
```

How the agent answers:

| In the op | Agent answer | Driver (`src/browser/pageDriver.ts`) does |
| --- | --- | --- |
| return an object | `{status: 'done', result}` | resolves `act()` with `result` |
| `throw new Pending(reason, code)` | `{status: 'pending', reason, code, url}` | asks again (every ≤ 2 s) until the timeout, then `CodedError(code, 'Timed out after Ns: <reason>')` |
| `throw new Fatal(message, code?, matches?)` / locator syntax error | `{status: 'error', message, code?, url, matches?}` | rejects at once with a `CodedError`, no retry |

Pick the code from [errors.ts](../../src/core/errors.ts) that tells a reader (or a model) what to fix; see
[Page Protocol: Error codes](Page-Protocol.md#error-codes).

Results must be JSON-friendly, and Chrome sorts object keys in `executeScript` results; return
`{columns, values}` when key order matters (see `tableToObjects`). The same agent also runs on fetched HTML
without layout (`Host.html.act`), where geometry checks are skipped; jsdom tests behave like that too.

### 3. Real input and frames

- If the op is a user action that real (debugger) input should perform, add it to `ACTIONS` in
  `src/browser/pageDriver.ts` and to `actWithRealInput()` (and the `locate` op's `purpose`). Otherwise
  `step.realInput` is ignored for it, which is correct for reads.
- `frame=` locators work for free: the agent enters same-origin frames itself, and for a cross-origin one
  answers `{status: 'frame'}` so the driver re-runs the request inside that frame.
- Also note that an action op whose page navigates away mid-call is reported as `{navigated: true}` only for
  ops in `ACTIONS`.

### 4. The block

```ts
async run(ctx, input) {
  await inPage(ctx, input, { op: 'focus', locator: ctx.config.locator });
  return input;
}
```

with `fields: [locatorField(), tabField]`, `accent: PAGE_ACCENT`, `timeoutSeconds: PAGE_TIMEOUT_SECONDS`,
and a `defaultConfig` with `tab: 'main'`. `inPage` finds the tab with `requireSessionTab` and passes
`pageWaitMs(ctx)` and `realInput`. Test it with `h.host.agent` and `h.host.actions` as in
`tests/core/pageBlocks.test.ts`.

## Checklist

- [ ] `src/core/blocks/<name>.ts`: `BlockDefinition<Config>` with TSDoc on the config and the block
- [ ] unique, final `type` (stored in saved workflows; never rename later)
- [ ] every field key has a value in `defaultConfig`; `templated` only on string fields meant for `{{…}}`
- [ ] `run` returns `{ ...input, … }`, `routeTo(…)`, or `null` deliberately; errors are user-readable, and
      failures with a known cause throw `CodedError(code, message)` (src/core/errors.ts) so the step
      records a [code](Core-Engine.md#error-codes-errorsts) other than `step.failed`
- [ ] rules between settings in `validate(config)` (plus a fixture in `tests/core/check.test.ts`); old keys
  `run` still reads in `legacyKeys`
- [ ] timing via `ctx.timers` / `ctx.host.sleep`, memory via `ctx.state`, all values JSON
- [ ] registered in `index.ts`: import, `export { … }`, `BLOCK_GROUPS`
- [ ] tests with `harness()` / `FakeHost` (and a jsdom agent test for a new op)
- [ ] new page op: `page.ts` → `agent.ts` (+ test) → `pageDriver.ts` `ACTIONS` if it is an action
- [ ] new Host method: `types.ts`, `src/browser/host.ts`, `FakeHost`, permissions in `wxt.config.ts`
- [ ] `npm run guide:sync`; `docs/guide/README.md` and `README.md` (block table and count) still correct
- [ ] learning material updated per `docs/learning/MAINTAINING.md`
- [ ] `npm run check` passes

## See also

- [Block Internals](Block-Internals.md): the contract, `ctx`, fields and every existing block
- [Page Protocol](Page-Protocol.md) and [Page Agent](Page-Agent.md)
- [Testing](Testing.md): `FakeHost`, `harness()`, jsdom and e2e tests
- [Tooling and Scripts](Tooling-and-Scripts.md): `guide:sync`, `learn:sync`, `npm run check`
- [Browser Host](Browser-Host.md): implementing a new `Host` method
- [Learning lesson 7: BlockFlow code tour](../learning/07-blockflow-code-tour.md)
