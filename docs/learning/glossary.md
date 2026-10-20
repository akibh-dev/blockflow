# Glossary

| Term | Meaning |
| --- | --- |
| **Manifest** | `manifest.json`, the declaration of everything an extension is and may do. |
| **MV3 (Manifest V3)** | Current manifest version. Service-worker background, declarative network rules, no remote code. |
| **Service worker (background)** | The extension's event-driven "backend". Started by events, stopped after ~30s idle; all memory lost. |
| **Event page** | Firefox/Safari's non-persistent background page. Similar sleeping behaviour, but a page with a DOM. |
| **Popup** | Small HTML page shown when the toolbar button is clicked. Destroyed on close. |
| **Content script** | JS injected into web pages. Shares the DOM, but runs in an isolated world. |
| **Isolated world** | The content script's private JS scope: it cannot see the page's variables and vice versa. |
| **Injected function** | Code sent into a page on demand with `scripting.executeScript`. Serialised; no closures. |
| **Host permission** | Permission to access particular sites (match patterns). Shown to the user at install. |
| **`activeTab`** | Temporary access to the current tab after the user clicks your button. No broad warning. |
| **Match pattern** | URL pattern like `https://*.example.com/*` or `<all_urls>`. Not a regex. |
| **`chrome.storage.local`** | Async key/value storage shared by all parts, persists across worker restarts. |
| **Alarm** | A named timer owned by the browser that can wake a stopped worker. Published minimum 30s. |
| **Heartbeat** | BlockFlow's 30s alarm kept for short timers; it revives a worker that died. |
| **Keep-alive ping** | A cheap extension API call every 20s; counts as activity so the worker is not stopped. |
| **Message passing** | `runtime.sendMessage` / `tabs.sendMessage` between the parts. |
| **Unpacked extension** | A folder loaded in developer mode (as opposed to a packaged store build). |
| **WXT** | Framework for extensions: file-based entrypoints, generated manifest, hot reload, multi-browser builds. |
| **Entrypoint** | A file under `entrypoints/` that WXT turns into part of the extension. |
| **Host (BlockFlow)** | The interface through which BlockFlow's engine touches the outside world. Fakeable in tests. |
| **Block / workflow / payload** | BlockFlow terms: a unit of work, a connected graph of them, the JSON data passed along an edge. |
| **Root block** | A block with nothing connected to its input; it starts the flow. |
| **Baseline** | Watch Element's first read of a value, stored so later reads can be compared; not itself a change. |
| **Idempotent** | Safe to run twice with the same result. Worker handlers should be, since restarts replay setup code. |
