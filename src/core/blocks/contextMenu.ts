import { currentTabPayload } from './pageVisited';
import type { BlockContext, BlockDefinition } from '../types';

/** Context Menu settings, read by the background worker when it (re)creates the menu items. */
export interface ContextMenuConfig {
  title: string;
  contexts: 'page' | 'selection' | 'link' | 'image' | 'all';
}

/**
 * Context Menu — adds an item to the right-click menu ("Save this product"); choosing it starts
 * the flow on that page. Needs the workflow to be On.
 */
export const contextMenuBlock: BlockDefinition<ContextMenuConfig> = {
  type: 'context-menu',
  label: 'Context Menu',
  description: 'Add an item to the right-click menu that starts the flow on that page.',
  icon: '🖱',
  accent: '#f59e0b',
  defaultConfig: { title: 'Run my workflow', contexts: 'all' },
  fields: [
    { key: 'title', label: 'Menu item', kind: 'text', required: true },
    {
      key: 'contexts',
      label: 'Show it when right-clicking',
      kind: 'select',
      options: [
        { value: 'all', label: 'anywhere' },
        { value: 'page', label: 'the page' },
        { value: 'selection', label: 'selected text' },
        { value: 'link', label: 'a link' },
        { value: 'image', label: 'an image' },
      ],
    },
  ],
  summary: (config) => `“${config.title}”`,
  outputs: [
    { key: 'url', description: 'The page address.' },
    { key: 'selection', description: 'Selected text, if any.' },
    { key: 'link', description: 'The link right-clicked, if any.' },
    { key: 'src', description: 'The image right-clicked, if any.' },
  ],

  start(ctx) {
    ctx.log('info', `Right-click menu item “${ctx.config.title}” is ready`);
  },
  trigger: (ctx) => currentTabPayload(ctx as BlockContext<object>),
  async run(_ctx, input) {
    return input;
  },
};
