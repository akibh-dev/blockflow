import { requireSessionTab } from '../session';
import { PAGE_ACCENT, tabField } from './pageCommon';
import type { BlockDefinition } from '../types';

/** Dialogs settings: how to answer from now on (accept/dismiss), or only `read` what was shown. */
export interface DialogsConfig {
  tab: string;
  action: 'accept' | 'dismiss' | 'read';
  text: string;
}

/**
 * Dialogs — decides how the page's alert / confirm / prompt boxes are answered (they would
 * otherwise block it), or reads the ones shown so far. Put it before the click that opens one;
 * it lasts until the page reloads or navigates.
 */
export const dialogsBlock: BlockDefinition<DialogsConfig> = {
  type: 'dialogs',
  label: 'Dialogs',
  description: 'Answer alert / confirm / prompt boxes automatically, or read what they said.',
  icon: '💬',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: 'main', action: 'accept', text: '' },
  timeoutSeconds: 15,
  fields: [
    {
      key: 'action',
      label: 'From now on',
      kind: 'select',
      options: [
        { value: 'accept', label: 'press OK (and type the text below into prompts)' },
        { value: 'dismiss', label: 'press Cancel' },
        { value: 'read', label: 'just read the dialogs shown so far' },
      ],
    },
    { key: 'text', label: 'Text for prompts', kind: 'text', templated: true },
    tabField,
  ],
  summary: (config) => (config.action === 'read' ? 'read dialogs' : `${config.action === 'accept' ? 'OK' : 'Cancel'} to dialogs`),
  outputs: [
    { key: 'dialogs', description: 'Dialogs shown in this page so far: {type, message}.' },
    { key: 'lastDialog', description: 'The message of the latest one.' },
  ],

  async run(ctx, input) {
    const tabId = requireSessionTab(input, ctx.config.tab);
    const shown =
      ctx.config.action === 'read' ? await ctx.host.page.dialogs(tabId, { read: true }) : await ctx.host.page.dialogs(tabId, { mode: ctx.config.action, text: ctx.config.text });
    return { ...input, dialogs: shown, lastDialog: shown.at(-1)?.message ?? '' };
  },
};
