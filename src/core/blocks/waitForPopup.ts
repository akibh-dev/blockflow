import { requireSessionTab, withSessionTab } from '../session';
import { WAIT_UNTIL_OPTIONS } from './openUrl';
import { PAGE_ACCENT, pageWaitMs, tabField } from './pageCommon';
import type { WaitUntil } from '../page';
import type { BlockContext, BlockDefinition } from '../types';

/** Wait for Popup settings: the opener tab (`tab`), and the session name to give the new tab. */
export interface WaitForPopupConfig {
  tab: string;
  name: string;
  waitUntil: WaitUntil;
}

/** How far back a popup still counts (it often opens during the Click just before this block). */
const LOOK_BACK_MS = 15_000;

/**
 * Wait for Popup — catches a tab the page opened (a "Sign in with…" window, a target=_blank link)
 * and gives it a name, so the next blocks can work in it.
 */
export const waitForPopupBlock: BlockDefinition<WaitForPopupConfig> = {
  type: 'wait-for-popup',
  label: 'Wait for Popup',
  description: 'Catch a new tab or window the page opened, and name it for the next blocks.',
  icon: '🪟',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: 'main', name: 'popup', waitUntil: 'load' },
  timeoutSeconds: 30,
  fields: [
    { ...tabField, label: 'Opened by tab' },
    { key: 'name', label: 'Call the new tab', kind: 'text', required: true, placeholder: 'popup' },
    { key: 'waitUntil', label: 'Continue when', kind: 'select', options: WAIT_UNTIL_OPTIONS },
  ],
  summary: (config) => `→ tab "${config.name}"`,
  outputs: [
    { key: 'popupUrl', description: 'The address of the new tab.' },
    { key: 'popupTabId', description: 'Its tab id.' },
  ],

  async run(ctx, input) {
    const opener = requireSessionTab(input, ctx.config.tab);
    const waitMs = pageWaitMs(ctx as BlockContext<object>);
    const tabId = await ctx.host.tabs.waitForPopup(opener, LOOK_BACK_MS, waitMs);
    await ctx.host.tabs.waitForLoad(tabId, ctx.config.waitUntil, waitMs);
    const url = (await ctx.host.tabs.info(tabId))?.url ?? '';
    ctx.log('info', `New tab "${ctx.config.name}": ${url}`);
    return withSessionTab({ ...input, popupUrl: url, popupTabId: tabId }, ctx.config.name, tabId);
  },
};
