// blockflow-bridge: the native messaging host and its helpers. `blockflow-bridge/client` is the socket
// client, `blockflow-bridge/protocol` the shared constants.
export { EXIT, isLive, runHost } from './host.mjs';
export { configDir, readOrCreateToken, readToken, socketPath, tokenFile } from './paths.mjs';
export { FrameTooLargeError, createLineSplitter, createNativeDecoder, encodeLine, encodeNative } from './framing.mjs';
export { BridgeError, NOT_REACHABLE, connectBridge } from './client.mjs';
export {
  BROWSERS,
  CHROMIUM_BROWSERS,
  FIREFOX_EXTENSION_ID,
  MANIFEST_FILE,
  browserTarget,
  chromiumExtensionId,
  defaultLauncherDir,
  findManifests,
  hostManifest,
  installHost,
  isolatedHostDirs,
  launcherPath,
  launcherScript,
  registryAddArgs,
  registryDeleteArgs,
  uninstallHost,
} from './install.mjs';
export * from './protocol.mjs';
