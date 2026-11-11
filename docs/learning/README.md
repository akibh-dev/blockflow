# Learn browser extension building by hand

Goal: by the end you can write **your own extension from an empty folder, by hand**, and you understand
every line of BlockFlow, the real extension in this repo.

You said you know React, Next.js and SaaS apps. These lessons lean on that: an extension is "a few small
web apps that each run in a different place and talk by messages". Most of it will feel familiar. The new
parts are *where* code runs and *what it is allowed to touch*.

## How to use this

1. Do the lessons **in order** and **type the code yourself** (do not paste). The examples folder is the
   finished version to compare against when something does not work.
2. Each lesson ends with a checkpoint (what you should see) and exercises. Do the exercises; that is where
   it sticks.
3. Lessons 1 to 5 need **no build tools**: plain JavaScript, load the folder in Chrome. Lesson 6 moves to
   the real stack (WXT, React, TypeScript). Lesson 7 is a guided tour of BlockFlow.

| # | Lesson | You build / learn |
| --- | --- | --- |
| 1 | [The mental model](01-mental-model.md) | Where extension code runs, what it can do, how it differs from a web app |
| 2 | [Hello extension](02-hello-extension.md) | `manifest.json` + a popup; load it unpacked |
| 3 | [Content scripts and messaging](03-content-scripts-and-messaging.md) | Read and change a web page; popup ⇄ page messages |
| 4 | [Background, storage, alarms](04-background-storage-alarms.md) | A service worker that survives sleeping; timers |
| 5 | [Capstone: Page Watcher](05-capstone-page-watcher.md) | A complete extension you wrote yourself |
| 6 | [WXT + React + TypeScript](06-wxt-react-typescript.md) | The same ideas on the professional stack |
| 7 | [BlockFlow code tour](07-blockflow-code-tour.md) | Read and extend the real project |
| 8 | [Testing, debugging, publishing](08-testing-debugging-publishing.md) | Ship it |
| 9 | [Native messaging](09-native-messaging.md) | Let programs on your computer (CLI, MCP server) talk to your extension |
| 10 | [The DevTools Protocol](10-cdp-debugger.md) | Real (trusted) clicks and page control through `chrome.debugger` |
| | [Glossary](glossary.md) · [Web dev → extension cheat sheet](#cheat-sheet) | |

## What you need

- Chrome (or any Chromium browser) and a code editor. Node.js only from lesson 6.
- Load an extension: open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked**,
  choose the folder that contains `manifest.json`. After editing code click the ↻ button on the extension's
  card (popup/HTML changes show on reopening; background and content-script changes need the reload).

## Cheat sheet

| In a web app you know | In an extension |
| --- | --- |
| `next.config.js`, `package.json` entry | `manifest.json`: the single file that declares everything |
| A page / route | A **popup**, **options page** or **side panel** (HTML files in the extension) |
| Server / API route / cron | **Background service worker** (event driven, sleeps), `chrome.alarms` |
| Browser code on someone else's site | **Content script** (runs inside a web page, isolated world) |
| `fetch('/api')` to your server | `chrome.runtime.sendMessage` between parts (+ `fetch` to anything you have host permission for) |
| `localStorage` / DB | `chrome.storage.local` (shared by all parts, survives the worker sleeping) |
| OAuth scopes | `permissions` and `host_permissions`, shown to the user at install |
| Deploy to Vercel | Zip and submit to the Chrome Web Store / AMO / App Store |
| Hot reload | Reload button on `chrome://extensions` (WXT adds real HMR in lesson 6) |

## Keeping this folder up to date

If you are Claude or a contributor: read [MAINTAINING.md](MAINTAINING.md) first. Code in lessons is
extracted into `examples/` by `node docs/learning/tools/sync-examples.mjs`.
