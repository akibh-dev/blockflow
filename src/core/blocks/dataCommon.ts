import { evaluate } from '../expression';
import type { EvalEnv } from '../expression';
import type { BlockContext, Payload, TextField } from '../types';

/** Pieces shared by the data blocks. */

export const DATA_ACCENT = '#0d9488';

/** A field holding an expression that points at a list in the data: `items`, `data.results`. */
export function listField(key = 'list', label = 'List', placeholder = 'items'): TextField {
  return {
    key,
    label,
    kind: 'text',
    required: true,
    placeholder,
    help: 'Where the list is in the data, e.g. items or data.results (an expression, no {{ }}).',
  };
}

/** What expressions in a block take from the host: its clock, for now() and today(). */
export function evalEnv(ctx: Pick<BlockContext, 'host'>): EvalEnv {
  return { now: () => ctx.host.now() };
}

/** The value an expression points at; the error names the field. */
export function valueAt(expression: string, input: Payload, label = 'List', env: EvalEnv = {}): unknown {
  try {
    return evaluate(expression, input, env);
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Like `valueAt`, but the value must be an array; the error says whether it is missing or the wrong type. */
export function listAt(expression: string, input: Payload, label = 'List', env: EvalEnv = {}): unknown[] {
  const value = valueAt(expression, input, label, env);
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) throw new Error(`${label}: "${expression}" is not in the data`);
  throw new Error(`${label}: "${expression}" is not a list (it is ${typeof value})`);
}
