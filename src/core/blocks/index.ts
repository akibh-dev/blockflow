import { BlockRegistry } from '../registry';
import type { AnyBlockDefinition, BlockCategory } from '../types';
import { dataTableBlock } from './dataTable';
import { downloadBlock } from './download';
import { extractListBlock } from './extractList';
import { extractTableBlock } from './extractTable';
import { filterBlock } from './filter';
import { forEachBlock } from './forEach';
import { pageInfoBlock } from './pageInfo';
import { paginateBlock } from './paginate';
import { repeatBlock } from './repeat';
import { saveDatasetBlock } from './saveDataset';
import { scrollBlock } from './scroll';
import { transformBlock } from './transform';
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
  dataTableBlock,
  downloadBlock,
  extractListBlock,
  extractTableBlock,
  filterBlock,
  forEachBlock,
  pageInfoBlock,
  paginateBlock,
  repeatBlock,
  saveDatasetBlock,
  scrollBlock,
  transformBlock,
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

/**
 * The blocks that ship with BlockFlow, by palette group, in palette order. Add new ones here.
 * (Categories live here rather than in each block so the grouping is visible in one place.)
 */
export const BLOCK_GROUPS: { category: BlockCategory; blocks: AnyBlockDefinition[] }[] = [
  { category: 'start', blocks: [timerBlock, watchElementBlock] },
  { category: 'browser', blocks: [openUrlBlock, navigateBlock, closeTabBlock] },
  { category: 'page', blocks: [clickBlock, fillBlock, fillFormBlock, selectOptionBlock, checkBlock, pressKeyBlock, scrollBlock, waitForBlock] },
  { category: 'read', blocks: [readElementBlock, extractListBlock, extractTableBlock, paginateBlock, pageInfoBlock] },
  { category: 'test', blocks: [assertBlock, manualStepBlock, stopBlock] },
  { category: 'logic', blocks: [ifBlock, forEachBlock, repeatBlock, runWorkflowBlock] },
  { category: 'data', blocks: [setVariableBlock, transformBlock, filterBlock, dataTableBlock, saveDatasetBlock, downloadBlock] },
  { category: 'output', blocks: [notifyBlock, httpRequestBlock, logBlock] },
];

export function createDefaultRegistry(): BlockRegistry {
  const registry = new BlockRegistry();
  for (const group of BLOCK_GROUPS) {
    for (const block of group.blocks) registry.register({ ...block, category: group.category });
  }
  return registry;
}
