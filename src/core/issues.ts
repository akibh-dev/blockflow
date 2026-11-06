/**
 * Problems found in a workflow or script file, in one shape for every checker: strict validation
 * (check.ts), the script compiler (script.ts) and migrations (migrate.ts). An LLM (or a person) reads
 * `code` and `path` to repair the file; the codes are stable and listed in the guide's "Repair" table.
 */

export type IssueLevel = 'error' | 'warning' | 'info';

export interface Issue {
  /** Errors block an import; warnings import with a banner; info is a note (e.g. a key was renamed). */
  level: IssueLevel;
  /** Stable code, e.g. `config.key.unknown`. */
  code: string;
  /** JSON Pointer into the file as the author wrote it, e.g. `/workflows/0/nodes/3/config/locater`. */
  path: string;
  /** One sentence for a person. */
  message: string;
  /** How to fix it, e.g. `Did you mean "locator"?`. */
  hint?: string;
}

/** A JSON Pointer (RFC 6901) from path segments: `pointer('workflows', 0, 'nodes')` → `/workflows/0/nodes`. */
export function pointer(...parts: (string | number)[]): string {
  return parts.map((part) => `/${String(part).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

/** True when any issue is an error. */
export function hasErrors(issues: readonly Issue[]): boolean {
  return issues.some((issue) => issue.level === 'error');
}
