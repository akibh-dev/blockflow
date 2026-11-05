import type { AnyBlockDefinition } from './types';

/** Block types by `type`. Filled once by `createRegistry()` in `blocks/index.ts`. */
export class BlockRegistry {
  private readonly blocks = new Map<string, AnyBlockDefinition>();

  /** Adds a block type; throws if the type is already registered. Chainable. */
  register(block: AnyBlockDefinition): this {
    if (this.blocks.has(block.type)) {
      throw new Error(`Block type "${block.type}" is already registered`);
    }
    this.blocks.set(block.type, block);
    return this;
  }

  /** The definition for `type`, or undefined for unknown types. */
  get(type: string): AnyBlockDefinition | undefined {
    return this.blocks.get(type);
  }

  has(type: string): boolean {
    return this.blocks.has(type);
  }

  /** All definitions, in registration order. */
  list(): AnyBlockDefinition[] {
    return [...this.blocks.values()];
  }
}
