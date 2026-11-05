import { PAGE_ACCENT, PAGE_TIMEOUT_SECONDS, inPage, locatorField, tabField } from './pageCommon';
import type { BlockDefinition } from '../types';

/** Check settings: the checkbox/radio/switch and the state it should end in. */
export interface CheckConfig {
  tab: string;
  locator: string;
  state: 'check' | 'uncheck';
}

/** Check: one `check` agent request; the agent only clicks when the state differs (`result.changed`). */
export const checkBlock: BlockDefinition<CheckConfig> = {
  type: 'check',
  label: 'Check',
  description: 'Tick or untick a checkbox, radio button or switch. Does nothing if it already is.',
  icon: '☑️',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: 'main', locator: '', state: 'check' },
  realInput: true,
  timeoutSeconds: PAGE_TIMEOUT_SECONDS,
  fields: [
    locatorField('locator', 'Checkbox'),
    {
      key: 'state',
      label: 'Make it',
      kind: 'select',
      options: [
        { value: 'check', label: 'checked' },
        { value: 'uncheck', label: 'unchecked' },
      ],
    },
    tabField,
  ],
  summary: (config) => `${config.state}: ${config.locator || 'pick a checkbox'}`,
  outputs: [{ key: '(same data)', description: 'The input, passed on.' }],

  async run(ctx, input) {
    const { result } = await inPage(ctx, input, { op: 'check', locator: ctx.config.locator, checked: ctx.config.state === 'check' });
    ctx.log('info', result.changed ? `${ctx.config.state === 'check' ? 'Checked' : 'Unchecked'} ${ctx.config.locator}` : `${ctx.config.locator} already ${ctx.config.state}ed`);
    return input;
  },
};
