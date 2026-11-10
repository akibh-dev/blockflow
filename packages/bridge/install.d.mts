export type Browser = 'chrome' | 'chromium' | 'brave' | 'brave-origin' | 'edge' | 'firefox';
export type DirTarget = string | { dir: string; kind?: 'chromium' | 'firefox' };
export type Where = { platform?: NodeJS.Platform; home?: string; localAppData?: string };
export type InstallOptions = Where & {
  extensionIds?: string[];
  firefox?: boolean;
  browsers?: Browser[];
  dirs?: DirTarget[];
  hostScript?: string;
  launcherDir?: string;
  nodePath?: string;
  exec?: (file: string, args: string[]) => void;
};
export declare const FIREFOX_EXTENSION_ID: 'blockflow@akibh-dev';
export declare const MANIFEST_FILE: string;
export declare const CHROMIUM_BROWSERS: readonly Browser[];
export declare const BROWSERS: readonly Browser[];
export declare function chromiumExtensionId(absPath: string, options?: { platform?: NodeJS.Platform }): string;
export declare function browserTarget(browser: Browser, where?: Where): { dir?: string; registryKey?: string };
export declare function defaultLauncherDir(where?: Where): string;
export declare function launcherPath(platform: NodeJS.Platform, dir: string): string;
export declare function launcherScript(options?: { platform?: NodeJS.Platform; nodePath?: string; hostScript?: string }): string;
export declare function hostManifest(kind: 'chromium' | 'firefox', launcher: string, extensionIds?: string[]): Record<string, unknown> & { allowed_origins?: string[]; allowed_extensions?: string[] };
export declare function registryAddArgs(registryKey: string, manifestPath: string): string[];
export declare function registryDeleteArgs(registryKey: string): string[];
export declare function installHost(options: InstallOptions): { launcher: string; manifests: string[]; registry: { key: string; manifest: string }[] };
export declare function uninstallHost(options?: Omit<InstallOptions, 'extensionIds' | 'firefox' | 'hostScript' | 'nodePath'>): { removed: string[]; registry: string[] };
export declare function findManifests(where?: Where): { browser: Browser; file: string }[];

/** `<profile>/NativeMessagingHosts` plus each Chromium-family default folder under `home` (run the browser with HOME=home). */
export declare function isolatedHostDirs(profile: string, home: string, where?: Where): string[];
