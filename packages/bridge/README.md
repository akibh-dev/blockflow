# blockflow-bridge

Native messaging host for the [BlockFlow](../../README.md) browser extension. It lets local programs (the
`blockflow-mcp` MCP server, the `blockflow` CLI, your own scripts) validate, import and run workflows in
your browser.

```text
your program ──local socket (NDJSON, token)──▶ blockflow-bridge ──native messaging──▶ BlockFlow extension
```

## Install

1. In BlockFlow, open **Settings** and copy the extension id.
2. Install the host for your browsers:

   ```bash
   npx blockflow-bridge install --extension-id <id>              # Chrome, Chromium, Brave, Edge
   npx blockflow-bridge install --browser firefox                # Firefox (fixed id, no --extension-id)
   npx blockflow-bridge install --extension-id <id> --browser brave --browser firefox
   ```

   This writes a small launcher (it runs this package's `host.mjs` with the current Node) and a
   `dev.akibh.blockflow.json` manifest where each browser looks for it (registry keys on Windows).
3. Switch on **Allow outside control** in BlockFlow Settings. The browser starts the host; it listens on
   `$XDG_RUNTIME_DIR/blockflow.sock` (or `~/.config/blockflow/blockflow.sock`; `\\.\pipe\blockflow-<user>` on
   Windows) and the token is in `~/.config/blockflow/token`.

`npx blockflow-bridge status` shows the manifests found and whether the bridge answers.
`npx blockflow-bridge uninstall` removes everything again. `--dir <folder>` installs into one folder instead
(for example `<chromium profile>/NativeMessagingHosts`).

## Use it from Node

```js
import { connectBridge } from 'blockflow-bridge/client';

const bridge = await connectBridge({ client: 'my-script' });
const { ok, issues } = await bridge.call('validate', { source: scriptText });
const result = await bridge.call('run', { source: scriptText }, { timeoutMs: 0, onNotification: (n) => console.log(n.method) });
bridge.close();
```

Errors are `BridgeError` with `.code` (JSON-RPC code, see `blockflow-bridge/protocol`) and `.data`.
The methods and their parameters are in the extension's
[`src/core/bridgeProtocol.ts`](../../src/core/bridgeProtocol.ts).

Environment: `BLOCKFLOW_SOCKET` and `BLOCKFLOW_TOKEN_FILE` override the paths (set them on the browser and on
the client alike).

Internals: [docs/wiki/Bridge.md](../../docs/wiki/Bridge.md).
