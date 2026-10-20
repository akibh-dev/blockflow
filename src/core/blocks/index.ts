import { BlockRegistry } from '../registry';
import { openUrlBlock } from './openUrl';
import { timerBlock } from './timer';
import { watchElementBlock } from './watchElement';

export { openUrlBlock, timerBlock, watchElementBlock };

/** The blocks that ship with BlockFlow. Add new ones here. */
export function createDefaultRegistry(): BlockRegistry {
  return new BlockRegistry()
    .register(timerBlock)
    .register(openUrlBlock)
    .register(watchElementBlock);
}
