import { BlockRegistry } from '../registry';
import { httpRequestBlock } from './httpRequest';
import { ifBlock } from './ifBlock';
import { notifyBlock } from './notify';
import { openUrlBlock } from './openUrl';
import { readElementBlock } from './readElement';
import { setVariableBlock } from './setVariable';
import { timerBlock } from './timer';
import { watchElementBlock } from './watchElement';

export {
  httpRequestBlock,
  ifBlock,
  notifyBlock,
  openUrlBlock,
  readElementBlock,
  setVariableBlock,
  timerBlock,
  watchElementBlock,
};

/** The blocks that ship with BlockFlow. Add new ones here. */
export function createDefaultRegistry(): BlockRegistry {
  return new BlockRegistry()
    .register(timerBlock)
    .register(openUrlBlock)
    .register(watchElementBlock)
    .register(readElementBlock)
    .register(ifBlock)
    .register(setVariableBlock)
    .register(httpRequestBlock)
    .register(notifyBlock);
}
