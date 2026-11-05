import { PAGE_ACCENT, PAGE_TIMEOUT_SECONDS, inPage, locatorField, tabField } from './pageCommon';
import type { BlockDefinition } from '../types';

/** Select Option settings. `value` may hold several options separated by `|` (multi-selects). */
export interface SelectOptionConfig {
  tab: string;
  locator: string;
  value: string;
}

/** Select Option: one `select` agent request (matches option text or value); adds `selected`. */
export const selectOptionBlock: BlockDefinition<SelectOptionConfig> = {
  type: 'select-option',
  label: 'Select Option',
  description: 'Choose an option in a dropdown (<select>), by its text or value.',
  icon: '🔽',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: 'main', locator: '', value: '' },
  realInput: true,
  timeoutSeconds: PAGE_TIMEOUT_SECONDS,
  fields: [
    locatorField('locator', 'Dropdown'),
    {
      key: 'value',
      label: 'Option',
      kind: 'text',
      required: true,
      templated: true,
      placeholder: 'Bangladesh  or  bd',
      help: 'Several for a multi-select: separate with |',
    },
    tabField,
  ],
  summary: (config) => `${config.locator || 'pick a dropdown'} → ${config.value || '…'}`,
  outputs: [{ key: 'selected', description: 'Values of the selected options.' }],

  async run(ctx, input) {
    const values = ctx.config.value.split('|').map((part) => part.trim()).filter(Boolean);
    const { result } = await inPage(ctx, input, { op: 'select', locator: ctx.config.locator, values });
    ctx.log('info', `Selected ${values.join(', ')}`);
    return { ...input, selected: result.selected };
  },
};
