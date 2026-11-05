import { truncate } from '../text';
import { PAGE_ACCENT, PAGE_TIMEOUT_SECONDS, inPage, locatorField, tabField } from './pageCommon';
import type { BlockDefinition } from '../types';

/** Fill settings. `mode: 'type'` sends key events one character at a time (autocomplete boxes). */
export interface FillConfig {
  tab: string;
  locator: string;
  value: string;
  mode: 'fill' | 'type';
}

/** Fill: one `fill` agent request (native value setter + input/change events), then passes its input on. */
export const fillBlock: BlockDefinition<FillConfig> = {
  type: 'fill',
  label: 'Fill',
  description: 'Type a value into a text field. Works with React, Vue and Angular forms.',
  icon: '⌨️',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: 'main', locator: '', value: '', mode: 'fill' },
  realInput: true,
  timeoutSeconds: PAGE_TIMEOUT_SECONDS,
  fields: [
    locatorField('locator', 'Field'),
    { key: 'value', label: 'Value', kind: 'text', templated: true, placeholder: 'text, or {{name}}' },
    {
      key: 'mode',
      label: 'How',
      kind: 'select',
      options: [
        { value: 'fill', label: 'set the whole value at once (fast)' },
        { value: 'type', label: 'type it key by key (for autocomplete boxes)' },
      ],
    },
    tabField,
  ],
  summary: (config) => `${config.locator || 'pick a field'} = ${truncate(config.value, 24)}`,
  outputs: [{ key: '(same data)', description: 'The input, passed on.' }],

  async run(ctx, input) {
    await inPage(ctx, input, { op: 'fill', locator: ctx.config.locator, value: ctx.config.value, mode: ctx.config.mode });
    ctx.log('info', `Filled ${ctx.config.locator}`);
    return input;
  },
};
