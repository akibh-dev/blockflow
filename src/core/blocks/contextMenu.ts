import { currentTabPayload } from './pageVisited';
import { withSessionTab } from '../session';
import type { BlockContext, BlockDefinition, Payload } from '../types';

/** Context Menu settings, read by the background worker when it (re)creates the menu items. */
export interface ContextMenuConfig {
  title: string;
  contexts: 'page' | 'selection' | 'link' | 'image' | 'all';
}

/** Prefix of the menu item ids BlockFlow creates: `bf-menu::<workflowId>::<nodeId>`. */
export const MENU_PREFIX = 'bf-menu::';

/** What the background worker passes to `contextMenus.create` for one Context Menu block. */
export interface MenuItem {
  id: string;
  title: string;
  contexts: ['all' | 'page' | 'selection' | 'link' | 'image'];
}

/** The right-click menu item for a Context Menu start block (untitled items use the workflow's name). */
export function menuItemFor(workflow: { id: string; name: string }, nodeId: string, config: Record<string, unknown>): MenuItem {
  const where = String(config.contexts ?? 'all');
  const contexts = (['page', 'selection', 'link', 'image'] as const).find((context) => context === where) ?? 'all';
  return { id: `${MENU_PREFIX}${workflow.id}::${nodeId}`, title: String(config.title || workflow.name), contexts: [contexts] };
}

/** The workflow and node behind a menu item id, or null for items that are not ours. */
export function parseMenuItemId(menuItemId: string): { workflowId: string; nodeId: string } | null {
  if (!menuItemId.startsWith(MENU_PREFIX)) return null;
  const [workflowId, nodeId] = menuItemId.slice(MENU_PREFIX.length).split('::');
  return workflowId && nodeId ? { workflowId, nodeId } : null;
}

/** The run's starting data when the item is chosen; the right-clicked tab becomes "main". */
export function menuClickPayload(info: { pageUrl?: string; selectionText?: string; linkUrl?: string; srcUrl?: string }, tabId: number | undefined): Payload {
  const payload = { url: info.pageUrl ?? '', selection: info.selectionText ?? '', link: info.linkUrl ?? '', src: info.srcUrl ?? '', tabId: tabId ?? null };
  return tabId === undefined ? payload : withSessionTab(payload, 'main', tabId);
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
