import type { AnyBlockDefinition, EdgeDef, NodeDef, Payload } from './types';

/**
 * Outputs ("ports") of a block. Most blocks have one, "out". If has "true" and "false".
 * Any block gets an extra "error" output when its step settings say "On error → error output".
 */

/** The output every block has unless it declares `ports`. */
export const DEFAULT_PORT = 'out';
/** Extra output added when a node's step settings say `onError: 'port'`. */
export const ERROR_PORT = 'error';

/** A payload sent out of a specific output. Blocks create it with `routeTo()`. */
export class Routed {
  constructor(
    readonly port: string,
    readonly payload: Payload,
  ) {}
}

/** Return this from `run` to send `payload` out of `port` instead of the first output. */
export function routeTo(port: string, payload: Payload): Routed {
  return new Routed(port, payload);
}

/** The outputs this node shows, in order. */
export function nodePorts(def: AnyBlockDefinition | undefined, node: Pick<NodeDef, 'step'>): string[] {
  const ports = def?.ports && def.ports.length > 0 ? [...def.ports] : [DEFAULT_PORT];
  if (node.step?.onError === 'port' && !ports.includes(ERROR_PORT)) ports.push(ERROR_PORT);
  return ports;
}

/**
 * Which output an edge leaves from. Edges saved before ports existed have no `sourcePort`;
 * they belong to the block's first output, so old workflows keep working.
 */
export function edgePort(edge: Pick<EdgeDef, 'sourcePort'>, ports: string[]): string {
  const port = edge.sourcePort ?? DEFAULT_PORT;
  if (port === DEFAULT_PORT && !ports.includes(DEFAULT_PORT)) return ports[0] ?? DEFAULT_PORT;
  return port;
}
