export declare const EXIT: Readonly<{ ok: 0; error: 1; socketInUse: 3 }>;
export type HostOptions = {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr?: { write(chunk: string | Uint8Array): boolean };
  env?: Record<string, string | undefined>;
  /** Close socket clients that have not sent `auth` within this time (default 10 s). */
  authTimeoutMs?: number;
  onReady?: (info: { socketPath: string; tokenFile: string }) => void;
};
/** Resolves with the exit code: 0 normal end, 1 could not listen, 3 socket served by another live host. */
export declare function runHost(options: HostOptions): Promise<number>;
export declare function isLive(socketPath: string): Promise<boolean>;
