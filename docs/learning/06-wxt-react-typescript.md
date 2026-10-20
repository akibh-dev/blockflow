# Lesson 6: The professional stack, WXT + React + TypeScript

> **Status: not run end to end.** Lessons 2 to 5 were loaded and exercised in real Chromium. This lesson was
> written from the WXT docs and BlockFlow's own config, in an environment without npm access. If a command
> or API name here is off, check <https://wxt.dev> and fix this file (see [MAINTAINING.md](MAINTAINING.md)).

Goal: take what you hand-built and see what a framework buys you, so you can choose it deliberately.

## What was painful by hand

| Pain in lessons 2 to 5 | WXT's answer |
| --- | --- |
| Editing `manifest.json` by hand, in sync with the files | Manifest is **generated** from your folder structure + `wxt.config.ts` |
| Click ↻ on `chrome://extensions` after every change | Dev server with hot reload and an auto-opened browser (`npm run dev`) |
| `chrome.*` vs `browser.*`, MV2/MV3 differences | One `browser` import, builds for Chrome, Firefox, Safari |
| No TypeScript, no React, no imports between parts | Normal bundling (Vite): TS, React, shared modules |
| Zipping for the store | `wxt zip` |

You already know the Next.js feel: **file-based entrypoints**. A file in `entrypoints/` becomes a part of
the extension, like a file in `app/` becomes a route.

## Entrypoint cheat sheet

| File in `src/entrypoints/` | Becomes | Hand-written equivalent |
| --- | --- | --- |
| `background.ts` | background worker | `background.service_worker` |
| `popup/index.html` + `main.tsx` | popup | `action.default_popup` |
| `editor/index.html` (any name) | a full page, opened with `browser.runtime.getURL('/editor.html')` | an extension page |
| `something.content.ts` | content script (declared) | `content_scripts` |
| content script with `registration: 'runtime'` | injected on demand | `scripting.executeScript({files})` |
| `options/index.html` | options page | `options_ui` |

In BlockFlow: `background.ts`, `picker.content.ts` (runtime-registered), `editor/` (React app). Compare
with `wxt.config.ts` for the manifest parts WXT cannot infer (permissions).

## Start a fresh WXT project (do this yourself)

```bash
npx wxt@latest init my-watcher       # choose: npm, template "react"
cd my-watcher
npm run dev                          # opens a Chromium with the extension loaded, hot reload on
```

Look at what it generated: `wxt.config.ts`, `entrypoints/`, `.wxt/` (generated types, git-ignored). Then
build once and read the output: `npm run build`, open `.output/chrome-mv3/manifest.json`. That file is
what you wrote by hand in lesson 2.

## Port the Page Watcher

Do it as an exercise, in this order. After each step the extension should still work:

1. **Worker.** `entrypoints/background.ts`:

   ```ts
   import { browser } from 'wxt/browser';

   export default defineBackground(() => {
     // everything from lesson 5's background.js, with types.
     // Rules do not change: listeners at the top of this function, state in storage.
   });
   ```

   `defineBackground` is auto-imported by WXT. The body runs when the worker starts, which is why the
   "register listeners synchronously" rule still holds.
2. **Types for your data.** Create `shared/types.ts` with `interface Watch { url: string; selector: string;
   minutes: number; enabled: boolean }` and `HistoryEntry`. Now the popup and the worker cannot disagree
   about the shape of storage (they could, silently, in plain JS).
3. **Storage helper.** One small module with `getWatch()`, `saveWatch()`, `getHistory()` (BlockFlow:
   `src/browser/stores.ts`). Do not sprinkle `browser.storage.local.get('watch')` through the code.
4. **Popup in React.** A hook that subscribes to storage replaces the manual `render()`:

   ```tsx
   import { useEffect, useState } from 'react';
   import { browser } from 'wxt/browser';

   export function useStored<T>(key: string, initial: T): T {
     const [value, setValue] = useState<T>(initial);
     useEffect(() => {
       let alive = true;
       browser.storage.local.get(key).then((r) => alive && setValue((r[key] as T) ?? initial));
       const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
         if (area === 'local' && key in changes) setValue((changes[key].newValue as T) ?? initial);
       };
       browser.storage.onChanged.addListener(listener);
       return () => { alive = false; browser.storage.onChanged.removeListener(listener); };
     }, [key]);
     return value;
   }
   ```

   Compare with `src/entrypoints/editor/hooks.ts` (`useLogs`), the same idea.
5. **Run it in Firefox:** `npm run dev:firefox`. What broke? (Likely: host permission must be granted by the
   user in Firefox MV3; background is an event page, not a worker.)

## TypeScript habits that matter here

- Messages between parts are your *API*. Define them as a union with a type guard
  (`src/shared/messages.ts`) so `switch (message.type)` is checked.
- `import type` for types (BlockFlow has `verbatimModuleSyntax`). Not a style choice: bundlers need it.
- Keep browser-free logic in plain modules and pass the browser in through an interface. BlockFlow's
  `Host` (`src/core/types.ts`) is this; it is why the engine runs in tests with no browser at all.

## Exercises

1. In your port, add `entrypoints/options/` with a React form and open it from the popup with
   `browser.runtime.openOptionsPage()`.
2. Change `wxt.config.ts` so `host_permissions` is replaced by `optional_host_permissions` and request
   access with `browser.permissions.request({ origins: [url] })` when Start is pressed. This is the road
   to a store-friendly BlockFlow.
3. Run `npm run build:firefox` and diff the two manifests. List every difference.

Next: [Lesson 7: BlockFlow code tour](07-blockflow-code-tour.md)
