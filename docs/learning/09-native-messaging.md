# Lesson 9: Talking to programs outside the browser (native messaging)

Goal: an extension that sends a message to a small Node program on your computer and shows its answer.
You will learn: why an extension cannot open a server, `runtime.connectNative`, the host manifest, the
4-byte message framing, and how BlockFlow's MCP server and CLI reach the extension.
Finished version: [examples/05-native-echo](examples/05-native-echo)

## The problem, in web-app terms

In a Next.js app, another program talks to you over HTTP: you listen on a port. An extension **cannot
listen on a port**. It can only be a *client* (`fetch`, `WebSocket`). So how does Claude Desktop, a CLI or a
CI job reach code inside the browser?

| Option | Who listens | Catch |
| --- | --- | --- |
| Local web server + WebSocket client in the extension | a program you run | must be running first; any web page on your machine can try to connect too |
| **Native messaging** | the **browser** starts your program for you | a one-time install of a small manifest file |

Native messaging is like a child process you `spawn()` in Node: the browser starts your program and talks
to it over **stdin/stdout**. Only the extension ids you list may start it.

```text
 extension ──connectNative('dev.example.echo')──▶ browser reads the host manifest ──spawns──▶ your program
          ◀────────────── messages over stdin / stdout ──────────────────────────────────────┘
```

## Step 1: the extension

```json file=05-native-echo/manifest.json
{
  "manifest_version": 3,
  "name": "Native echo",
  "version": "1.0",
  "permissions": ["nativeMessaging", "storage"],
  "background": { "service_worker": "background.js" },
  "action": { "default_popup": "popup.html" }
}
```

The worker opens the port when the popup asks, and forwards the answer.

```js file=05-native-echo/background.js
// One long-lived port. While it is open, Chrome keeps this service worker awake.
let port = null;

function connect() {
  port = chrome.runtime.connectNative('dev.example.echo');
  port.onMessage.addListener((message) => {
    chrome.storage.session.set({ lastAnswer: message });
  });
  port.onDisconnect.addListener(() => {
    // lastError says why: host not found, not allowed, or the program exited.
    chrome.storage.session.set({ lastAnswer: { error: chrome.runtime.lastError?.message ?? 'disconnected' } });
    port = null;
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'send') return;
  if (!port) connect();
  port.postMessage({ text: message.text, at: Date.now() });
});
```

```html file=05-native-echo/popup.html
<!doctype html>
<html>
  <body style="width: 260px; font-family: sans-serif">
    <input id="text" value="hello" />
    <button id="send">Send</button>
    <pre id="answer"></pre>
    <script src="popup.js"></script>
  </body>
</html>
```

```js file=05-native-echo/popup.js
const answer = document.getElementById('answer');
document.getElementById('send').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'send', text: document.getElementById('text').value });
});
// The worker stores each answer; show it as it arrives.
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.lastAnswer) answer.textContent = JSON.stringify(changes.lastAnswer.newValue, null, 2);
});
```

Load the folder unpacked (lesson 2) and copy its **ID** from `chrome://extensions`. You need it next.

## Step 2: the host program

Each message is **4 bytes of length (little-endian) followed by UTF-8 JSON**, in both directions. Like a
WebSocket frame, but you parse it yourself. stdout is the channel: never `console.log` there, it would
corrupt a frame. Log to stderr.

```js file=05-native-echo/host/echo-host.mjs
#!/usr/bin/env node
// Started by the browser. Reads framed JSON on stdin, answers on stdout.
let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  // One chunk can hold half a message or several: loop until a whole one is not there.
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < 4 + length) break;
    const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
    buffer = buffer.subarray(4 + length);
    console.error('host got', message); // stderr: safe
    send({ echo: message.text, pid: process.pid });
  }
});

// The browser closes stdin when the port disconnects: exit then.
process.stdin.on('end', () => process.exit(0));
```

## Step 3: the host manifest (the install step)

The browser finds your program through a JSON file named after the host:

```json file=05-native-echo/host/dev.example.echo.json
{
  "name": "dev.example.echo",
  "description": "Echo host for lesson 9",
  "path": "/ABSOLUTE/PATH/TO/05-native-echo/host/echo-host.mjs",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID/"]
}
```

1. Put the real absolute path in `path` and your ID in `allowed_origins` (keep the trailing `/`).
2. `chmod +x host/echo-host.mjs`: the browser runs `path` directly.
3. Copy the file to the browser's folder:
   - Linux, Chrome: `~/.config/google-chrome/NativeMessagingHosts/` (Chromium: `~/.config/chromium/…`,
     Brave: `~/.config/BraveSoftware/Brave-Browser/…`)
   - macOS, Chrome: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
   - Windows: a registry key `HKCU\Software\Google\Chrome\NativeMessagingHosts\dev.example.echo` whose
     default value is the manifest's path.

Firefox uses the same framing, but the manifest lists `"allowed_extensions": ["your@addon.id"]`.

## Checkpoint

> **Verified** 2026-11-10 in Chromium 156 on Linux, with the host manifest in the test profile's
> `NativeMessagingHosts` folder (as BlockFlow's CLI does). The system folders above, macOS, Windows and Firefox
> were not run for this lesson.

Open the popup, click **Send**: you see `{"echo": "hello", "pid": …}`. Click again: same `pid`, because the
port stayed open. Close the popup and wait: the worker does not sleep while the port is open.

| You see | Why |
| --- | --- |
| `Specified native messaging host not found.` | manifest not in the right folder, or `name` differs from the file name / `connectNative` argument |
| `Access to the specified native messaging host is forbidden.` | the ID in `allowed_origins` is not this extension's (unpacked IDs change with the folder) |
| `Native host has exited.` | the program crashed or is not executable; start it by hand to see the error |
| `Error when communicating with the native messaging host.` | something wrote non-framed bytes to stdout (a stray `console.log`) |
| works in a terminal, fails from the browser | the browser's `PATH` may not include `node`: use an absolute path in a launcher script |

## Exercises

1. Add a `"type": "time"` message the host answers with the current time.
2. Break it on purpose: add `console.log('hi')` in the host. Read the error, then fix it with `console.error`.
3. Make the host refuse messages over 1 MB (Chrome's limit for host → extension) and answer with an error.
4. Harder: let a *second* program talk to the extension through the host. Make the host also listen on a
   Unix socket and forward lines from it to the extension. That is exactly BlockFlow's bridge.

## In BlockFlow

- `packages/bridge/framing.mjs`: the same 4-byte framing, with size limits and a stream parser.
- `packages/bridge/host.mjs`: the host also listens on a per-user socket (with a token) so the MCP server
  (`packages/mcp`) and the CLI (`packages/cli`) can be clients; it rewrites JSON-RPC ids so they never collide.
- `packages/bridge/install.mjs`: writes the manifest for Chrome, Chromium, Brave, Edge and Firefox, and a
  launcher script that uses an absolute `node` path. `chromiumExtensionId()` computes an unpacked
  extension's ID from its folder (SHA-256 of the path, letters a–p).
- `src/browser/bridge.ts`: the extension side. "Allow outside control" (editor **Settings**) asks for
  `nativeMessaging` as an optional permission, keeps the port open, reconnects with a capped backoff.
- The CLI writes the host manifest into its throwaway browser profile (`<profile>/NativeMessagingHosts`),
  which Chromium also reads, so CI needs no system-wide install. Brave does not: it reads only its default
  folder under `$HOME`, so on Linux the CLI also starts the browser with a throwaway `HOME` (`isolatedHostDirs`).
- Protocol: `src/core/bridgeProtocol.ts`; wiki: [Bridge](../wiki/Bridge.md), [MCP Server](../wiki/MCP-Server.md), [CLI](../wiki/CLI.md).

Back to the [index](README.md).
