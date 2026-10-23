import { BlockRegistry } from '../registry';
import { assertBlock } from './assert';
import { checkBlock } from './check';
import { clickBlock } from './click';
import { closeTabBlock } from './closeTab';
import { fillBlock } from './fill';
import { fillFormBlock } from './fillForm';
import { httpRequestBlock } from './httpRequest';
import { ifBlock } from './ifBlock';
import { logBlock } from './log';
import { manualStepBlock } from './manualStep';
import { navigateBlock } from './navigate';
import { notifyBlock } from './notify';
import { openUrlBlock } from './openUrl';
import { pressKeyBlock } from './pressKey';
import { readElementBlock } from './readElement';
import { runWorkflowBlock } from './runWorkflow';
import { selectOptionBlock } from './selectOption';
import { setVariableBlock } from './setVariable';
import { stopBlock } from './stopRun';
import { timerBlock } from './timer';
import { waitForBlock } from './waitFor';
import { watchElementBlock } from './watchElement';

export {
  assertBlock,
  checkBlock,
  clickBlock,
  closeTabBlock,
  fillBlock,
  fillFormBlock,
  httpRequestBlock,
  navigateBlock,
  pressKeyBlock,
  selectOptionBlock,
  waitForBlock,
  ifBlock,
  logBlock,
  manualStepBlock,
  notifyBlock,
  openUrlBlock,
  readElementBlock,
  runWorkflowBlock,
  setVariableBlock,
  stopBlock,
  timerBlock,
  watchElementBlock,
};

/** The blocks that ship with BlockFlow. Add new ones here. */
export function createDefaultRegistry(): BlockRegistry {
  return new BlockRegistry()
    // Palette order: start, page, logic, data, output.
    .register(timerBlock)
    .register(watchElementBlock)
    .register(openUrlBlock)
    .register(clickBlock)
    .register(fillBlock)
    .register(fillFormBlock)
    .register(selectOptionBlock)
    .register(checkBlock)
    .register(pressKeyBlock)
    .register(waitForBlock)
    .register(readElementBlock)
    .register(assertBlock)
    .register(navigateBlock)
    .register(closeTabBlock)
    .register(ifBlock)
    .register(setVariableBlock)
    .register(runWorkflowBlock)
    .register(manualStepBlock)
    .register(stopBlock)
    .register(logBlock)
    .register(httpRequestBlock)
    .register(notifyBlock);
}
