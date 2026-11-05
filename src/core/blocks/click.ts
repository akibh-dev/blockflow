import { PAGE_ACCENT, PAGE_TIMEOUT_SECONDS, inPage, locatorField, tabField } from './pageCommon';
import type { BlockDefinition } from '../types';

/** Click settings. `force` skips the agent's actionability checks (visible, enabled, not covered). */
export interface ClickConfig {
  tab: string;
  locator: string;
  action: 'click' | 'double' | 'right' | 'hover';
  force: boolean;
}

/**
 * Click: one `click` agent request in the run's tab, then passes its input on unchanged. When the
 * page navigates away mid-action, pageDriver answers `{navigated: true}` instead of retrying.
 */
export const clickBlock: BlockDefinition<ClickConfig> = {
  type: 'click',
  label: 'Click',
  description: 'Click (or double-click, right-click, hover) an element. Waits until it can be clicked.',
  icon: '👆',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: 'main', locator: '', action: 'click', force: false },
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
      key: 'force',
      label: 'Skip the checks',
      kind: 'boolean',
      help: 'Click even if the element looks hidden, disabled or covered. Only for stubborn pages.',
    },
    tabField,
  ],
  summary: (config) => `${config.action === 'click' ? '' : `${config.action}: `}${config.locator || 'pick an element'}`,
  outputs: [{ key: '(same data)', description: 'The input, passed on.' }],

  async run(ctx, input) {
    const { result } = await inPage(ctx, input, {
      op: 'click',
      locator: ctx.config.locator,
      action: ctx.config.action,
      force: ctx.config.force,
    });
    ctx.log('info', result.navigated ? `Clicked ${ctx.config.locator}; the page navigated` : `Clicked ${String(result.clicked ?? ctx.config.locator)}`);
    return input;
  },
};
