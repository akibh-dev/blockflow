// Types for index.mjs (the .mjs modules carry JSDoc; this file lets TypeScript callers and tests/cli typecheck).

export type ReportFormat = 'junit' | 'json' | 'html';

export interface CliOptions {
  command: 'run' | 'validate' | 'help' | 'version';
  inputs: string[];
  suite?: string;
  reports: ReportFormat[];
  out: string;
  headed: boolean;
  browser?: string;
  extension?: string;
  timeoutSeconds: number;
  secrets: Record<string, string>;
}

export const REPORT_FILES: Readonly<Record<ReportFormat, string>>;
export const DEFAULT_OUT_DIR: string;
export const DEFAULT_TIMEOUT_SECONDS: number;
export const HELP: string;
export class UsageError extends Error {}
export function parseCliArgs(argv: string[]): CliOptions;

export interface BridgeNotification {
  method: string;
  params: any;
}
export interface BridgeClient {
  call(method: string, params: unknown, options?: { onNotification?: (n: BridgeNotification) => void; timeoutMs?: number }): Promise<any>;
  close(): void | Promise<void>;
}
export interface BridgeSession {
  client: BridgeClient;
  info: { browser: string; extension: string; extensionId: string };
  close(): Promise<void>;
}
export interface StartOptions {
  headed: boolean;
  browser?: string;
  extension?: string;
  env: Record<string, string | undefined>;
  cwd: string;
  log?: (line: string) => void;
  startTimeoutMs?: number;
}
export const BUILD_COMMAND: string;
export const START_TIMEOUT_MS: number;
export class InfraError extends Error {}
export function browserCandidates(flag: string | undefined, env: Record<string, string | undefined>): string[];
export function findBrowser(flag: string | undefined, env: Record<string, string | undefined>, exists?: (file: string) => boolean): string;
export function resolveExtension(flag: string | undefined, env: Record<string, string | undefined>, cwd: string, exists?: (file: string) => boolean): string;
export function bridgePaths(profile: string): { socket: string; tokenFile: string; hostsDir: string };
export function startBridge(options: StartOptions): Promise<BridgeSession>;

export interface InputFile {
  path: string;
  display: string;
  source?: unknown;
  parseError?: string;
}
export interface CollectedSuite {
  name: string;
  stopOnFailure?: boolean;
  files: InputFile[];
}
export interface SuiteEntry {
  name: string;
  workflows: string[];
  stopOnFailure?: boolean;
}
export const SUITE_FORMAT: string;
export const DEFAULT_SUITES_FILE: string;
export const DEFAULT_SUITE_NAME: string;
export function isWorkflowSource(value: unknown): boolean;
export function isSuiteFile(value: unknown): boolean;
export function findWorkflowFiles(dir: string): string[];
export function suitesIn(value: unknown, file: string): SuiteEntry[];
export function collectInputs(options: { inputs: string[]; suite?: string; cwd: string }): CollectedSuite;

export interface Deps {
  env?: Record<string, string | undefined>;
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  startBridge?: (options: StartOptions) => Promise<BridgeSession>;
  onInterrupt?: (handler: (signal: string) => void) => () => void;
}
export const EXIT: Readonly<{ passed: 0; failed: 1; error: 2 }>;
export const VERSION: string;
export function main(argv: string[], deps?: Deps): Promise<number>;

export function resolveBlob(client: Pick<BridgeClient, 'call'>, result: any): Promise<any>;
export function writeReports(outDir: string, reports: Partial<Record<ReportFormat, string>> | undefined, formats: ReportFormat[]): { written: string[]; missing: string[] };
export function formatDuration(ms: number): string;
export function durationOf(record: { startedAt?: string; endedAt?: string; finishedAt?: string }): number;
export function failingStep(run: { steps?: any[] }): any;
export function summaryLines(result: { name: string; status: string; runs: any[]; skipped?: string[]; startedAt?: string; finishedAt?: string }): string[];
export function issueLines(file: string, issues: { level: string; code: string; path?: string; message: string; hint?: string }[]): string[];

export const SECRET_ENV_PREFIX: string;
export function lowerCamel(name: string): string;
export function collectSecrets(env: Record<string, string | undefined>, flags?: Record<string, string>): Record<string, string>;
