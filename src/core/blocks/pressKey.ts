import { PAGE_ACCENT, PAGE_TIMEOUT_SECONDS, inPage, locatorField, tabField } from './pageCommon';
import { truncate } from '../text';
import type { BlockDefinition } from '../types';

/**
 * Press Key settings. `key` uses KeyboardEvent.key names joined with `+` for modifiers
 * (`Control+Shift+K`, `ControlOrMeta+A`). `mode: "text"` types `text` at the caret instead, as one
 * input with no key events (Playwright's `keyboard.insertText`). Configs without `mode` press `key`.
 */
export interface PressKeyConfig {
  tab: string;
  mode: 'key' | 'text';
  key: string;
  text: string;
  locator: string;
}

/** Press Key: one `press` (or `insert-text`) agent request, on `locator` (focused first) or on whatever has focus. */
export const pressKeyBlock: BlockDefinition<PressKeyConfig> = {
  type: 'press-key',
  label: 'Press Key',
  description: 'Press a key or shortcut (Enter, Tab, Escape, Control+A…), or insert text at the caret.',
  icon: '⏎',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: 'main', mode: 'key', key: 'Enter', text: '', locator: '' },
  realInput: true,
  timeoutSeconds: PAGE_TIMEOUT_SECONDS,
  fields: [
    {
      key: 'mode',
      label: 'Do',
      kind: 'select',
      options: [
        { value: 'key', label: 'press a key or shortcut' },
        { value: 'text', label: 'insert text at the caret (no key events)' },
      ],
    },
    {
      key: 'key',
      label: 'Key',
      kind: 'text',
      placeholder: 'Enter',
      help: 'Key names as on the keyboard: Enter, Tab, Escape, Backspace, ArrowDown, a, Control+A, Shift+Tab, Control+Shift+K. ControlOrMeta+A is ⌘A on a Mac, Ctrl+A elsewhere.',
    },
    { key: 'text', label: 'Text', kind: 'text', templated: true, placeholder: 'Hello 👋', help: 'For "insert text": typed at the caret in one go, like pasting.' },
    { ...locatorField('locator', 'On element (optional)', false), help: 'Focus this element first. Empty = whatever has focus.' },
    tabField,
  ],
  summary: (config) =>
    `${config.mode === 'text' ? `insert "${truncate(config.text, 20)}"` : config.key}${config.locator ? ` on ${config.locator}` : ''}`,
  validate: (config) =>
    config.mode === 'text'
      ? String(config.text ?? '') === ''
        ? [{ key: 'text', code: 'config.required', message: 'Text is required to insert text' }]
        : []
      : !String(config.key ?? '').trim()
        ? [{ key: 'key', code: 'config.required', message: 'Key is required' }]
        : [],
  outputs: [{ key: '(same data)', description: 'The input, passed on.' }],

  async run(ctx, input) {
    const locator = ctx.config.locator.trim();
    const target = locator ? { locator } : {};
    if (ctx.config.mode === 'text') {
      await inPage(ctx, input, { op: 'insert-text', text: ctx.config.text, ...target });
      ctx.log('info', `Inserted ${ctx.config.text.length} characters`);
      return input;
    }
    if (!ctx.config.key.trim()) throw new Error('Key is required');
    await inPage(ctx, input, { op: 'press', key: ctx.config.key.trim(), ...target });
    ctx.log('info', `Pressed ${ctx.config.key}`);
    return input;
  },
};
