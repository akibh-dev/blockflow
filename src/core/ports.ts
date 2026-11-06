import type { AnyBlockDefinition, EdgeDef, NodeDef, Payload } from './types';

/**
 * Outputs ("ports") of a block. Most blocks have one, "out". If has "true" and "false". Switch's
 * depend on its settings (`BlockDefinition.ports` is then a function of the config).
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

/** True for blocks whose outputs depend on their settings (`ports` is a function), like Switch. */
export function hasDynamicPorts(def: AnyBlockDefinition | undefined): boolean {
  return typeof def?.ports === 'function';
}

/** The block's declared outputs for a config (defaults filled in), before the `error` output is added. */
export function declaredPorts(def: AnyBlockDefinition | undefined, config: Record<string, unknown> = {}): string[] {
  let declared: unknown[] = [];
  if (typeof def?.ports === 'function') {
    try {
      declared = def.ports({ ...(def.defaultConfig as Record<string, unknown>), ...config });
    } catch {
      declared = [];
    }
  } else if (def?.ports) declared = def.ports;
  // Unique, non-empty names; "error" is not the block's to declare (step settings add it).
  const ports: string[] = [];
  for (const port of Array.isArray(declared) ? declared : []) {
    if (typeof port === 'string' && port !== '' && port !== ERROR_PORT && !ports.includes(port)) ports.push(port);
  }
  return ports.length > 0 ? ports : [DEFAULT_PORT];
}

/**
 * The outputs this node shows, in order. Pass the node's `config` for blocks with dynamic ports
 * (Switch: one output per case); without it their default config decides.
 */
export function nodePorts(def: AnyBlockDefinition | undefined, node: Partial<Pick<NodeDef, 'step' | 'config'>>): string[] {
  const ports = declaredPorts(def, node.config ?? {});
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
