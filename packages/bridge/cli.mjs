#!/usr/bin/env node
// blockflow-bridge install | uninstall | status | host
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BridgeError, connectBridge } from './client.mjs';
import { runHost } from './host.mjs';
import { BROWSERS, findManifests, installHost, uninstallHost } from './install.mjs';
import { socketPath, tokenFile } from './paths.mjs';

const USAGE = `Usage:
  blockflow-bridge install --extension-id <id> [--extension-id <id>...] [--browser chrome|chromium|brave|brave-origin|edge|firefox|all]... [--dir <folder>]...
  blockflow-bridge uninstall [--browser <name>]... [--dir <folder>]...
  blockflow-bridge status
  blockflow-bridge host        (what the browser runs; speaks native messaging on stdin/stdout)

The extension id is shown in BlockFlow > Settings. --dir writes the manifest (and the launcher) into the given
folder instead of the browsers' own folders, e.g. <profile>/NativeMessagingHosts for one Chromium profile.`;

/**
 * Runs one command. Returns the exit code (0 ok, 1 failure, 2 usage).
 * @param {string[]} argv arguments after the program name
 * @param {{ out?: (text: string) => void, err?: (text: string) => void, env?: Record<string, string | undefined> }} [io]
 */
export async function main(argv, io = {}) {
  const out = io.out ?? ((text) => process.stdout.write(`${text}\n`));
  const err = io.err ?? ((text) => process.stderr.write(`${text}\n`));
  const env = io.env ?? process.env;
  const [command, ...rest] = argv;
  // Chromium starts the launcher with the caller's origin as the first argument; the launcher runs host.mjs,
  // but a hand-written launcher may call `cli.mjs host` too.
  if (command === 'host' || command?.startsWith('chrome-extension://')) {
    return runHost({ stdin: process.stdin, stdout: process.stdout, env });
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        'extension-id': { type: 'string', multiple: true },
        browser: { type: 'string', multiple: true },
        dir: { type: 'string', multiple: true },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    err(`${/** @type {Error} */ (error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help || !command || command === 'help' || command === '--help' || command === '-h') {
    out(USAGE);
    return command ? 0 : 2;
  }
  /** @type {any[] | undefined} */
  let browsers;
  try {
    browsers = parseBrowsers(values.browser);
  } catch (error) {
    err(/** @type {Error} */ (error).message);
    return 2;
  }
  const extensionIds = (values['extension-id'] ?? []).flatMap((value) => value.split(',')).map((id) => id.trim()).filter(Boolean);
  const dirs = values.dir;

  if (command === 'install') {
    try {
      const firefox = browsers ? browsers.includes('firefox') : false;
      const chosen = browsers ?? (extensionIds.length ? undefined : []);
      const result = installHost({ extensionIds, firefox, browsers: chosen, dirs });
      out(`Launcher: ${result.launcher}`);
      for (const file of result.manifests) out(`Manifest: ${file}`);
      for (const entry of result.registry) out(`Registry: ${entry.key} -> ${entry.manifest}`);
      out('Done. Switch on "Allow outside control" in BlockFlow > Settings (or switch it off and on again).');
      return 0;
    } catch (error) {
      err(`Install failed: ${/** @type {Error} */ (error).message}`);
      return /could not|need|Nothing to install|not a Chromium/.test(String(error)) ? 2 : 1;
    }
  }
  if (command === 'uninstall') {
    const result = uninstallHost({ browsers, dirs });
    if (!result.removed.length && !result.registry.length) out('Nothing to remove.');
    for (const file of result.removed) out(`Removed: ${file}`);
    for (const key of result.registry) out(`Removed registry key: ${key}`);
    return 0;
  }
  if (command === 'status') {
    const manifests = findManifests();
    if (!manifests.length) out('Manifests: none found (run blockflow-bridge install --extension-id <id>)');
    for (const { browser, file } of manifests) out(`Manifest (${browser}): ${file}`);
    out(`Socket: ${socketPath(env)}`);
    out(`Token file: ${tokenFile(env)}`);
    try {
      const bridge = await connectBridge({ env, client: 'blockflow-bridge status', timeoutMs: 5000 });
      out(`Bridge: reachable, extension ${bridge.extensionConnected ? 'connected' : 'not connected'}`);
      bridge.close();
      return 0;
    } catch (error) {
      out(`Bridge: ${error instanceof BridgeError ? error.message : String(error)}`);
      return 1;
    }
  }
  err(`Unknown command "${command}".\n\n${USAGE}`);
  return 2;
}

/** @param {string[] | undefined} values */
function parseBrowsers(values) {
  if (!values?.length) return undefined;
  const names = values.flatMap((value) => value.split(',')).map((name) => name.trim().toLowerCase()).filter(Boolean);
  if (names.includes('all')) return [...BROWSERS];
  for (const name of names) if (!BROWSERS.includes(name)) throw new Error(`Unknown browser "${name}" (use ${BROWSERS.join(', ')} or all)`);
  return names;
}

const invokedAs = (() => {
  try {
    return realpathSync(process.argv[1] ?? '');
  } catch {
    return process.argv[1];
  }
})();
if (invokedAs === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.stdout.write('', () => process.exit(code));
  });
}
