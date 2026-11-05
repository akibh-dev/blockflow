import { PAGE_ACCENT, PAGE_TIMEOUT_SECONDS, inPage, locatorField, tabField } from './pageCommon';
import type { BlockDefinition } from '../types';

/** Press Key settings. `key` uses KeyboardEvent.key names joined with `+` for modifiers. */
export interface PressKeyConfig {
  tab: string;
  key: string;
  locator: string;
}

/** Press Key: one `press` agent request, on `locator` (focused first) or on whatever has focus. */
export const pressKeyBlock: BlockDefinition<PressKeyConfig> = {
  type: 'press-key',
  label: 'Press Key',
  description: 'Press a key or shortcut: Enter, Tab, Escape, Control+A…',
  icon: '⏎',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: 'main', key: 'Enter', locator: '' },
  realInput: true,
  timeoutSeconds: PAGE_TIMEOUT_SECONDS,
  fields: [
    {
      key: 'key',
      label: 'Key',
      kind: 'text',
      required: true,
      placeholder: 'Enter',
      help: 'Key names as on the keyboard: Enter, Tab, Escape, Backspace, ArrowDown, a, Control+A, Shift+Tab.',
    },
    { ...locatorField('locator', 'On element (optional)', false), help: 'Focus this element first. Empty = whatever has focus.' },
    tabField,
  ],
  summary: (config) => `${config.key}${config.locator ? ` on ${config.locator}` : ''}`,
  outputs: [{ key: '(same data)', description: 'The input, passed on.' }],

  async run(ctx, input) {
    const locator = ctx.config.locator.trim();
    await inPage(ctx, input, { op: 'press', key: ctx.config.key.trim(), ...(locator ? { locator } : {}) });
    ctx.log('info', `Pressed ${ctx.config.key}`);
    return input;
  },
};
