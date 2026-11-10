export type Env = Record<string, string | undefined>;
export type PathOptions = { platform?: NodeJS.Platform; home?: string; username?: string };
export declare function configDir(env?: Env, options?: PathOptions): string;
export declare function socketPath(env?: Env, options?: PathOptions): string;
export declare function tokenFile(env?: Env, options?: PathOptions): string;
export declare function readOrCreateToken(file: string): string;
export declare function readToken(file: string): string;
