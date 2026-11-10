# Bridge

The native messaging host (`packages/bridge`, published as `blockflow-bridge`) that lets local programs, the
MCP server and the `blockflow` CLI, drive the extension. Read this page when you change the relay, the
socket or token paths, the installer, or when "BlockFlow is not reachable" shows up.

**Source:** [host.mjs](../../packages/bridge/host.mjs), [framing.mjs](../../packages/bridge/framing.mjs),
[paths.mjs](../../packages/bridge/paths.mjs), [client.mjs](../../packages/bridge/client.mjs),
[install.mjs](../../packages/bridge/install.mjs), [cli.mjs](../../packages/bridge/cli.mjs),
[protocol.mjs](../../packages/bridge/protocol.mjs) (mirror of
[bridgeProtocol.ts](../../src/core/bridgeProtocol.ts)), tests in [tests/bridge](../../tests/bridge)

Plain ESM `.mjs` with JSDoc, Node ≥ 20, Node built-ins only. The `.d.mts` files next to each module give
TypeScript callers (tests, other packages) their types.

## Design in one paragraph

The browser starts the host when the extension calls `runtime.connectNative('dev.akibh.blockflow')` and
keeps it alive exactly as long as that port is open. The host listens on a per-user local socket protected
by a token file, and relays JSON-RPC 2.0 between any number of socket clients and the single extension
port. It does not interpret workflows: apart from `auth` it only checks the envelope, rewrites ids and
routes answers. When the port closes (stdin ends) it tells waiting clients, removes the socket and exits.

## The two hops

```text
client (MCP, CLI) ──NDJSON, auth first──▶ host ──native frames, ids rewritten──▶ extension (worker)
client ◀──response / run.* with original ids── host ◀──response / notifications── extension
```

| Hop | Transport | Framing | Limit |
| --- | --- | --- | --- |
| client ⇄ host | unix socket / Windows named pipe | one JSON message per line (`\n`, `\r\n` accepted) | `MAX_MESSAGE_BYTES` (1 MB) per line; over it → `tooLarge` and close |
| host ⇄ extension | the host's stdin / stdout | 4-byte little-endian length + UTF-8 JSON | 1 MB both ways (Chrome's host → extension limit); an oversize incoming frame is skipped and logged |

`framing.mjs` has both: `encodeNative` / `createNativeDecoder` (stream parser: partial frames and several
frames per chunk, oversize frames consumed and reported so the stream stays in step) and `encodeLine` /
`createLineSplitter` (UTF-8 safe across chunks).

**stdout is the native channel.** The host logs only to stderr (`[blockflow-bridge] …`); Chromium passes a
host's stderr to its own stderr.

## Relay rules

| From a client | Host does |
| --- | --- |
| first message is not `auth`, wrong token, not JSON | `unauthorized` (or `parse`) error, then closes |
| `auth` with another `protocol` | `version` error (`data.protocol` = what the host speaks), closes |
| no `auth` within 10 s | closes |
| `auth` ok | `{ok: true, extensionConnected}` |
| a method not in `BRIDGE_METHODS` | `methodNotFound` (not forwarded) |
| not JSON-RPC 2.0 / not JSON (after auth) | `invalidRequest` / `parse`, connection stays open |
| a notification (no id) | ignored |
| a request while the extension switched off | `disabled` |
| a request while no extension is behind the host (started by hand in a terminal) | `notConnected` |
| any other request | forwarded with a fresh host id (`params` default `{}`) |

| From the extension | Host does |
| --- | --- |
| a response (`id` + `result`/`error`) | sends it to the client that asked, with the client's own id; unknown ids dropped |
| `run.started` / `run.step` / `suite.progress` | routed by `params.requestId` (a host id) to that client, `requestId` rewritten to the client's id |
| `bridge.disabled` | fails pending requests with `disabled`, closes every client; later requests get `disabled` |
| stdin ends | pending requests fail with `notConnected`, clients closed, socket removed, exit 0 |

Host ids are one counter for all clients, so two clients that both send `id: 1` never collide. Answers for a
client that disconnected are dropped.

## Paths and the token

| What | Default | Override |
| --- | --- | --- |
| Socket | `$XDG_RUNTIME_DIR/blockflow.sock`, else `~/.config/blockflow/blockflow.sock`; Windows `\\.\pipe\blockflow-<username>` | `BLOCKFLOW_SOCKET` |
| Token | `~/.config/blockflow/token` (32 random bytes as hex, mode 0600, folder 0700) | `BLOCKFLOW_TOKEN_FILE` |

The host creates the token if it is missing (`readOrCreateToken`); clients only read it (`readToken`). The
socket is chmod 0600 after listening. The browser starts the host with the browser's own environment, so
the CLI and the e2e harness set `BLOCKFLOW_SOCKET` / `BLOCKFLOW_TOKEN_FILE` on the browser process to get a
private socket for a throwaway profile.

Starting up, the host listens; if the path is taken it probes it. Nobody answering (a leftover from a
crashed host, or a plain file) → removed and replaced. A live host answering → stderr "another BlockFlow
bridge is already serving …" and exit code **3**, without writing anything to the extension. The host only
removes the socket file it listened on itself.

## Client

```js
import { connectBridge } from 'blockflow-bridge/client';
const bridge = await connectBridge({ client: 'blockflow-mcp' }); // socketPath, tokenFile, timeoutMs optional
const result = await bridge.call('run', { source }, { onNotification: (n) => console.error(n.method), timeoutMs: 0 });
bridge.close();
```

- Every failure is a `BridgeError` with `.code` (`RPC_ERRORS`) and `.data`.
- No socket (ENOENT), nobody listening (ECONNREFUSED) or no token file → `notConnected` with the message
  "BlockFlow is not reachable: is the browser open with Allow outside control on, and the bridge installed?".
- `timeoutMs` (default 120 s) covers connecting and is the default per call; `timeoutMs: 0` on a call waits
  as long as it takes. A timeout is `internal` with `data.code: 'TIMEOUT'`; a late answer is ignored.
- The host going away mid-call → `notConnected`; `bridge.closed` resolves; later calls fail at once.
- `bridge.extensionConnected` is what `auth` returned.

## Install

`blockflow-bridge install --extension-id <id>` (`installHost`) writes:

1. A **launcher**: `#!/bin/sh` + `exec '<process.execPath>' '<…/host.mjs>' "$@"` (the browser starts hosts
   with a minimal `PATH`, so the absolute Node path is written in); Windows `blockflow-bridge-host.cmd`.
   Default folder: `~/.config/blockflow/bridge` (Linux), `~/Library/Application Support/BlockFlow`
   (macOS), `%LOCALAPPDATA%\BlockFlow` (Windows).
2. A **manifest** `dev.akibh.blockflow.json` per browser: `{name, description, path: <launcher>, type: "stdio"}`
   plus `allowed_origins: ["chrome-extension://<id>/"]` (Chrome, Chromium, Brave, Edge) or
   `allowed_extensions: ["blockflow@akibh-dev"]` (Firefox).

| Browser | Linux | macOS (`~/Library/Application Support/…`) | Windows (HKCU, default value = manifest path) |
| --- | --- | --- | --- |
| Chrome | `~/.config/google-chrome/NativeMessagingHosts` | `Google/Chrome/NativeMessagingHosts` | `Software\Google\Chrome\NativeMessagingHosts\dev.akibh.blockflow` |
| Chromium | `~/.config/chromium/NativeMessagingHosts` | `Chromium/NativeMessagingHosts` | `Software\Chromium\NativeMessagingHosts\…` |
| Brave | `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts` | `BraveSoftware/Brave-Browser/NativeMessagingHosts` | `Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\…` |
| Brave Origin (`brave-origin`) | `~/.config/BraveSoftware/Brave-Origin/NativeMessagingHosts` | `BraveSoftware/Brave-Origin/NativeMessagingHosts` | `Software\BraveSoftware\Brave-Origin\NativeMessagingHosts\…` (not verified) |
| Edge | `~/.config/microsoft-edge/NativeMessagingHosts` | `Microsoft Edge/NativeMessagingHosts` | `Software\Microsoft\Edge\NativeMessagingHosts\…` |
| Firefox | `~/.mozilla/native-messaging-hosts` | `Mozilla/NativeMessagingHosts` | `Software\Mozilla\NativeMessagingHosts\…` |

On Windows the manifests sit next to the launcher (`dev.akibh.blockflow.json`, `dev.akibh.blockflow.firefox.json`)
and `reg add <key> /ve /t REG_SZ /d <manifest> /f` registers them.

**Throwaway profiles** (CLI, e2e). Chromium reads `<user-data-dir>/NativeMessagingHosts`, but Brave
(verified with Brave Origin 2026-11-10 on Linux) ignores `--user-data-dir` there and reads only its default folder
under `$HOME`. So on Linux the CLI and the harness start the browser with a throwaway `HOME` inside the profile
and install into every folder from `isolatedHostDirs(profile, home)`: the profile folder plus each
Chromium-family default under that home. The real home folder is never written.

`--dir <folder>` (`installHost({dirs})`) writes the Chromium manifest and the launcher into that folder
instead; a `{dir, kind: 'firefox'}` entry writes a Firefox one. The CLI runner and the e2e harness use
`<profile>/NativeMessagingHosts`: **Chromium reads host manifests from `<user-data-dir>/NativeMessagingHosts`**
as well as the system folders (verified with Chromium 156 on Linux, see below).

`chromiumExtensionId(absPath)` computes an unpacked extension's id the way Chromium does: SHA-256 of the
absolute, symlink-resolved path (UTF-8 bytes; UTF-16LE with an upper-case drive letter on Windows), first
32 hex digits mapped `0-f` → `a-p`.

Other commands: `uninstall [--browser …] [--dir …]` removes manifests, launcher and registry keys;
`status` lists manifests found and tries the socket; `host` runs the host on stdio.

## Verified

- Unit tests (`tests/bridge`, Node): framing, paths and token mode, auth, id rewriting with two clients,
  routing of responses and notifications, `bridge.disabled`, stdin end, stale and live sockets, client
  errors and timeouts, installer output, CLI; `host.mjs` is also driven as a real child process.
- Real Chromium 156 (Linux, headless, `.output-bridge` e2e build): `chromiumExtensionId` equals the id the
  browser gave; a manifest only in `<profile>/NativeMessagingHosts` was found; `connectNative` started the
  launcher with `BLOCKFLOW_SOCKET`/`BLOCKFLOW_TOKEN_FILE` from the browser's environment; a client authed, a
  forwarded request and a `run.step` notification made the round trip; `port.disconnect()` made the host
  exit and remove its socket; the token file was 0600.
- Not run: Firefox, macOS, Windows (named pipe and registry are checked by path and argument construction
  only).

## Troubleshooting

| Symptom | Cause, fix |
| --- | --- |
| "BlockFlow is not reachable…" | No host running: the browser is closed, "Allow outside control" is off, the manifest is missing or names another extension id (`blockflow-bridge status`; reinstall with the id from Settings), or the client looks at another socket (`BLOCKFLOW_SOCKET` differs between the browser and the client). |
| Extension port disconnects at once, "Specified native messaging host not found" | Manifest not in the browser's folder, wrong `name`, or `path` not absolute/executable. |
| "Access to the specified native messaging host is forbidden" | The extension id is not in `allowed_origins` (unpacked builds get a path-based id: rerun install with the id shown in Settings). |
| Host exits with code 3, stderr "another BlockFlow bridge is already serving" | Outside control is on in another browser or profile on the same socket. Switch it off there, or start this browser with its own `BLOCKFLOW_SOCKET`. |
| `unauthorized` | The client read another token file than the host (`BLOCKFLOW_TOKEN_FILE`). |
| Host does not start after moving Node | The launcher holds the absolute Node path: run `install` again. |
| `listen` fails with a long socket path | Unix socket paths are limited to about 104–108 bytes: use a shorter `BLOCKFLOW_SOCKET`. |
| Host stderr | Chromium: start the browser from a terminal (`--enable-logging=stderr`); Firefox: the browser console. |

## See also

- [Message Protocol](Message-Protocol.md), [Storage Keys](Storage-Keys.md)
- [Background Worker](Background-Worker.md) for the extension side of the port
