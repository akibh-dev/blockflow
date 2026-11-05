import { createDefaultRegistry } from '../../core/blocks';

/**
 * One shared registry for the whole editor page: the palette, block nodes, config panel,
 * validation and Playwright export all read block definitions from here. It is the same
 * `createDefaultRegistry()` the background worker builds, so editor and engine agree on blocks.
 */
export const registry = createDefaultRegistry();
