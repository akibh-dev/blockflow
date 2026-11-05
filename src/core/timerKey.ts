/**
 * Timers are identified by a string key so they can survive the background worker being
 * restarted: the browser alarm carries the key, and the key says which workflow, block and
 * timer name to wake up.
 */

const SEP = '::';
const PREFIX = 'bf';

/** `bf::<workflowId>::<nodeId>::<name>`, the key a block timer is stored and alarmed under. */
export function makeTimerKey(workflowId: string, nodeId: string, name: string): string {
  return [PREFIX, workflowId, nodeId, name].join(SEP);
}

/** Prefix of every timer key of one workflow (for `Scheduler.clearPrefix`). */
export function workflowTimerPrefix(workflowId: string): string {
  return `${PREFIX}${SEP}${workflowId}${SEP}`;
}

/** The parts of a timer key. */
export interface ParsedTimerKey {
  workflowId: string;
  nodeId: string;
  name: string;
}

/** Splits a timer key; null when it is not a BlockFlow key. The name may itself contain `::`. */
export function parseTimerKey(key: string): ParsedTimerKey | null {
  const [prefix, workflowId, nodeId, ...rest] = key.split(SEP);
  if (prefix !== PREFIX || !workflowId || !nodeId || rest.length === 0) return null;
  return { workflowId, nodeId, name: rest.join(SEP) };
}

/** Key under which `ctx.state` stores a block value: `<workflowId>::<nodeId>::<key>`. */
export function stateKey(workflowId: string, nodeId: string, key: string): string {
  return [workflowId, nodeId, key].join(SEP);
}
