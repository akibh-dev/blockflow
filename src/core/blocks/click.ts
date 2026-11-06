import { PAGE_ACCENT, PAGE_TIMEOUT_SECONDS, inPage, locatorField, modifierProblems, modifiersOf, positionOf, positionProblems, tabField } from './pageCommon';
import type { AgentRequest } from '../page';
import type { BlockDefinition, ConfigProblem } from '../types';

/**
 * Click settings. `force` skips the agent's actionability checks (visible, enabled, not covered).
 *
 * `action` is the quick choice and the mouse options refine it, as in Playwright:
 * - `click`: `button` (left/middle/right) pressed `clickCount` times.
 * - `double`: a double click (`clickCount` 2; a higher `clickCount` still wins), left button.
 * - `right`: the right button (same as `click` with `button: right`); `button` must stay left or right.
 * - `hover`: only moves the mouse there; `button` and `clickCount` do not apply.
 * `modifiers` ("Shift", "Control+Shift") are held and `position` ("x,y" from the element's top-left
 * corner; empty = its center) is where the mouse goes, for every action.
 */
export interface ClickConfig {
  tab: string;
  locator: string;
  action: 'click' | 'double' | 'right' | 'hover';
  force: boolean;
  button: 'left' | 'middle' | 'right';
  modifiers: string;
  position: string;
  clickCount: number;
}

/** The mouse options of a Click config, as the extra fields of a `click` request (only those that differ from the defaults). */
export function clickOptions(config: Partial<ClickConfig>): Partial<Extract<AgentRequest, { op: 'click' }>> {
  const options: Partial<Extract<AgentRequest, { op: 'click' }>> = {};
  if (config.action !== 'hover') {
    if (config.action !== 'right' && config.button && config.button !== 'left') options.button = config.button;
    const count = Math.floor(Number(config.clickCount) || 1);
    if (count > 1) options.clickCount = count;
  }
  const modifiers = modifiersOf(config.modifiers);
  if (modifiers) options.modifiers = modifiers;
  const position = positionOf(config.position, 'Position');
  if (position) options.position = position;
  return options;
}

/**
 * Click: one `click` agent request in the run's tab, then passes its input on unchanged. When the
 * page navigates away mid-action, pageDriver answers `{navigated: true}` instead of retrying.
 */
export const clickBlock: BlockDefinition<ClickConfig> = {
  type: 'click',
  label: 'Click',
  description: 'Click (or double-click, right-click, hover) an element, with any button, modifier keys and position. Waits until it can be clicked.',
  icon: '👆',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: 'main', locator: '', action: 'click', force: false, button: 'left', modifiers: '', position: '', clickCount: 1 },
  realInput: true,
  timeoutSeconds: PAGE_TIMEOUT_SECONDS,
  fields: [
    locatorField(),
    {
      key: 'action',
      label: 'Action',
      kind: 'select',
      options: [
        { value: 'click', label: 'click' },
        { value: 'double', label: 'double-click' },
        { value: 'right', label: 'right-click' },
        { value: 'hover', label: 'hover (move the mouse over it)' },
      ],
    },
    {
      key: 'button',
      label: 'Mouse button',
      kind: 'select',
      options: [
        { value: 'left', label: 'left' },
        { value: 'middle', label: 'middle (auxclick)' },
        { value: 'right', label: 'right (contextmenu)' },
      ],
      help: 'For "click". Right-click always uses the right button.',
    },
    {
      key: 'modifiers',
      label: 'Keys held',
      kind: 'text',
      placeholder: 'Shift  ·  Control+Shift  ·  Meta',
      help: 'Modifier keys held during the click: Alt, Control, Meta, Shift (joined with + or commas). Empty = none.',
    },
    {
      key: 'position',
      label: 'Position',
      kind: 'text',
      placeholder: '10,5',
      help: 'Where to click: x,y in pixels from the element’s top-left corner. Empty = its center.',
    },
    { key: 'clickCount', label: 'Click count', kind: 'number', min: 1, max: 10, help: 'Presses in a row (3 = triple click, selects a paragraph). Double-click means at least 2.' },
    {
      key: 'force',
      label: 'Skip the checks',
      kind: 'boolean',
      help: 'Click even if the element looks hidden, disabled or covered. Only for stubborn pages.',
    },
    tabField,
  ],
  summary: (config) => {
    const keys = modifiersOf(config.modifiers)?.join('+');
    const what = config.action === 'click' ? (config.button && config.button !== 'left' ? `${config.button}-click` : '') : config.action;
    const prefix = [keys, what].filter(Boolean).join(' ');
    return `${prefix ? `${prefix}: ` : ''}${config.locator || 'pick an element'}`;
  },
  validate: (config) => {
    const problems: ConfigProblem[] = [...modifierProblems('modifiers', config.modifiers), ...positionProblems('position', config.position)];
    if (config.action === 'right' && config.button === 'middle') {
      problems.push({ key: 'button', code: 'config.value', message: 'Right-click uses the right button; set action to "click" for the middle button' });
    }
    return problems;
  },
  outputs: [{ key: '(same data)', description: 'The input, passed on.' }],

  async run(ctx, input) {
    const { result } = await inPage(ctx, input, {
      op: 'click',
      locator: ctx.config.locator,
      action: ctx.config.action,
      force: ctx.config.force,
      ...clickOptions(ctx.config),
    });
    ctx.log('info', result.navigated ? `Clicked ${ctx.config.locator}; the page navigated` : `Clicked ${String(result.clicked ?? ctx.config.locator)}`);
    return input;
  },
};
