import { normalizeText } from '../text';
import { normalizeHttpUrl } from '../url';
import type { BlockDefinition, ReadKind } from '../types';

export interface ReadElementConfig {
  url: string;
  selector: string;
  read: ReadKind;
  name: string;
  reload: boolean;
}

interface LastRead {
  signature: string;
  value: string;
}

const NEEDS_NAME: ReadKind[] = ['attribute', 'has-class'];

/**
 * Read Element — reads ONE value from a page every time the flow reaches it, and passes it on.
 * Unlike Watch Element it never decides anything itself: pair it with If (compare the value) and
 * Notify (act). It also hands over the value from its previous run, so If can ask "did it go up?".
 */
export const readElementBlock: BlockDefinition<ReadElementConfig> = {
  type: 'read-element',
  label: 'Read Element',
  description: 'Read a value from a page: text, attribute, class, whether it exists, or how many.',
  icon: '🔎',
  accent: '#0ea5e9',
  defaultConfig: { url: '', selector: '', read: 'text', name: '', reload: true },
  fields: [
    {
      key: 'selector',
      label: 'Element',
      kind: 'selector',
      required: true,
      pickerUrlKey: 'url',
      placeholder: 'CSS selector, or use "Pick on page"',
    },
    { key: 'url', label: 'Page URL', kind: 'url', required: true, templated: true, placeholder: 'https://example.com' },
    {
      key: 'read',
      label: 'Read',
      kind: 'select',
      options: [
        { value: 'text', label: 'its text' },
        { value: 'attribute', label: 'an attribute (e.g. aria-pressed)' },
        { value: 'has-class', label: 'whether it has a class (e.g. dark)' },
        { value: 'exists', label: 'whether it exists' },
        { value: 'count', label: 'how many match' },
      ],
    },
    {
      key: 'name',
      label: 'Attribute / class name',
      kind: 'text',
      help: 'Only for "an attribute" and "has a class".',
    },
    { key: 'reload', label: 'Reload page before reading', kind: 'boolean' },
  ],
  summary: (config) => `${config.read}: ${config.selector || 'pick an element'}`,
  outputs: [
    { key: 'value', description: 'What was read ("true"/"false" for class and exists).' },
    { key: 'previous', description: 'The value from the last run (empty on the first run).' },
    { key: 'changed', description: 'True when value differs from previous (false on the first run).' },
    { key: 'count', description: 'How many elements matched the selector.' },
    { key: 'url', description: 'The page that was read.' },
  ],

  async run(ctx, input) {
    const url = normalizeHttpUrl(ctx.config.url);
    if (!url) throw new Error(`"${ctx.config.url}" is not a valid http(s) URL`);
    const { selector, read, name, reload } = ctx.config;
    if (NEEDS_NAME.includes(read) && !name.trim()) throw new Error('Attribute / class name is required');

    const result = await ctx.host.page.readElement({ url, selector, reload, read: { kind: read, name: name.trim() } });
    if (result.error) throw new Error(result.error);
    if (!result.found) {
      ctx.log('warn', `Element not found on the page: ${selector}`);
      return null;
    }

    const value = read === 'text' ? normalizeText(result.text) : result.text;
    const signature = `${url}|${selector}|${read}|${name}`;
    const last = await ctx.state.get<LastRead>('last');
    await ctx.state.set('last', { signature, value } satisfies LastRead);
    const previous = last && last.signature === signature ? last.value : null;
    const changed = previous !== null && previous !== value;

    ctx.log('info', `Read ${read}: "${value}"${previous === null ? ' (first read)' : changed ? ` (was "${previous}")` : ' (unchanged)'}`);
    return { ...input, value, previous, changed, count: result.count ?? 0, url, selector };
  },
};
