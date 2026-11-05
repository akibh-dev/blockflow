import { PAGE_ACCENT, PAGE_TIMEOUT_SECONDS, inPage, locatorField, tabField } from './pageCommon';
import type { BlockDefinition, Row } from '../types';

/** Fill Form settings: `fields` rows are `{locator, value}` (plus an editor-only `hint` from Detect fields). */
export interface FillFormConfig {
  tab: string;
  fields: Row[];
  submit: string;
}

/**
 * Fill Form — many fields in one block. Each row is "field → value"; the value is typed into text
 * fields, picks an option in a select (by value or label), and ticks a checkbox for true/false.
 * Rows with an empty value are skipped, so "Detect fields" can list every field of a form.
 */
export const fillFormBlock: BlockDefinition<FillFormConfig> = {
  type: 'fill-form',
  label: 'Fill Form',
  description: 'Fill several fields at once: text, selects, checkboxes. Optionally click submit.',
  icon: '📋',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: 'main', fields: [], submit: '' },
  realInput: true,
  timeoutSeconds: PAGE_TIMEOUT_SECONDS,
  fields: [
    {
      key: 'fields',
      label: 'Fields',
      kind: 'rows',
      required: true,
      detectForm: true,
      columns: [
        { key: 'locator', label: 'Field', placeholder: 'label=Email', locator: true, templated: true },
        { key: 'value', label: 'Value', placeholder: 'text · option · true/false', templated: true },
      ],
      help: 'Empty values are skipped. Selects take the option text or value; checkboxes take true or false.',
    },
    { ...locatorField('submit', 'Then click (optional)', false), placeholder: 'role=button[name="Submit"]' },
    tabField,
  ],
  summary: (config) => {
    const count = (config.fields ?? []).filter((row) => (row.value ?? '') !== '').length;
    return `${count} field${count === 1 ? '' : 's'}${config.submit ? ', then submit' : ''}`;
  },
  outputs: [{ key: '(same data)', description: 'The input, passed on.' }],

  async run(ctx, input) {
    const rows = (ctx.config.fields ?? []).filter((row) => (row.locator ?? '').trim() !== '' && (row.value ?? '') !== '');
    for (const row of rows) {
      try {
        await inPage(ctx, input, { op: 'set-field', locator: row.locator ?? '', value: row.value ?? '' });
      } catch (error) {
        throw new Error(`${row.locator}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (ctx.config.submit.trim()) {
      await inPage(ctx, input, { op: 'click', locator: ctx.config.submit, action: 'click' });
    }
    ctx.log('info', `Filled ${rows.length} field${rows.length === 1 ? '' : 's'}${ctx.config.submit.trim() ? ' and clicked submit' : ''}`);
    return input;
  },
};
