# Lesson 1: The mental model

No code yet. Ten minutes here saves hours later.

## An extension is several programs, not one

A Next.js app has a server and a browser. An extension has up to **five places code runs**, each with its
own powers, its own console, and its own lifetime:

```text
                   ┌───────────────────────────────────────────┐
                   │  Background service worker (one, hidden)  │
                   │  chrome.alarms, tabs, storage, scripting  │
                   │  event driven, STOPS after ~30s idle      │
                   └───────▲───────────────▲───────────────▲───┘
         messages          │               │               │ chrome.scripting
 ┌───────────────┐   ┌─────┴───────┐ ┌─────┴────────┐ ┌────┴────────────────┐
 │ Popup         │   │ Options /   │ │ Content      │ │ Web page itself     │
 │ (small HTML,  │   │ editor page │ │ script       │ │ (not yours; you may │
 │ dies on close)│   │ (a full tab)│ │ (inside page,│ │ inject code into it)│
 └───────────────┘   └─────────────┘ │ isolated JS) │ └─────────────────────┘
                                     └──────────────┘
```

| Part | Think of it as | Can use `chrome.*`? | Can touch the page DOM? | Lifetime |
| --- | --- | --- | --- | --- |
| **Popup** | A tiny React app | Yes | No (only its own) | Exists while open |
| **Options / editor page** | A normal page of your own app | Yes | No | While the tab is open |
| **Background service worker** | Your "backend", but in the browser | Yes, all of it | No DOM at all | Starts on an event, **stopped when idle** |
| **Content script** | Your code running *inside* someone else's website | Only a few (`runtime`, `storage`) | **Yes** | As long as the page |
| **Injected function** (`scripting.executeScript`) | One-off code sent into a page | No | Yes | Runs once |

Everything else is *messages between these*.

## The three rules that explain 90% of bugs

1. **Different places, different consoles.** `console.log` in a popup shows in the popup's DevTools (right
   click the popup → Inspect), in the worker in "Inspect views: service worker" on `chrome.extensions`, and
   in a content script in the *web page's* DevTools. "My log doesn't appear" nearly always means "wrong console".
2. **The background worker is not a server.** Chrome stops it after about 30 seconds without events and
   throws away every variable. Anything it must remember goes in `chrome.storage`; anything it must do later
   goes through `chrome.alarms`. Never rely on `setTimeout`/`setInterval` surviving. (Lesson 4 covers this and
   how BlockFlow deliberately works around it for short timers.)
3. **Permissions are declared up front.** If an API is missing (`chrome.tabs.query is undefined`, or
   `url` is `undefined` on a tab), you forgot a line in `manifest.json`.

## `chrome.*` vs `browser.*`

Chrome gives you `chrome.*` (callbacks and, in Manifest V3, promises). Firefox and Safari give you
`browser.*` (promises). The `wxt/browser` import in BlockFlow hides the difference. In lessons 2 to 5 we
use `chrome.*` with `await`; it works in Chrome, and Firefox also accepts `chrome.*`.

## Manifest V3

The current format. What matters to you: the background is a **service worker** (the sleeping thing above),
network blocking is done declaratively, and you cannot load remote code. Firefox's and Safari's MV3 differ
slightly (event pages rather than service workers); lesson 6 shows how WXT covers that.

## Checkpoint

Without looking back, answer:

1. Where would you put code that reads the price from a product page? (content script / injected function)
2. Where would you put code that checks it every 5 minutes? (background + alarm)
3. Where do you save the last price seen? (`chrome.storage.local`, never a variable)
4. Why does your `setInterval` in the background stop working after a while? (worker was stopped)

That is exactly BlockFlow's *Watch Element* block. You will build a small version in lesson 5.

Next: [Lesson 2: Hello extension](02-hello-extension.md)
