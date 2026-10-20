import type { AnyBlockDefinition } from './types';

export class BlockRegistry {
  private readonly blocks = new Map<string, AnyBlockDefinition>();

  register(block: AnyBlockDefinition): this {
    if (this.blocks.has(block.type)) {
      throw new Error(`Block type "${block.type}" is already registered`);
    }
    this.blocks.set(block.type, block);
    return this;
  }

  get(type: string): AnyBlockDefinition | undefined {
    return this.blocks.get(type);
  }

  has(type: string): boolean {
    return this.blocks.has(type);
  }

  list(): AnyBlockDefinition[] {
    return [...this.blocks.values()];
  }
}
