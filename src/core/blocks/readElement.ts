import { DEFAULT_TAB, requireSessionTab } from '../session';
import { normalizeText } from '../text';
import { normalizeHttpUrl } from '../url';
import { pageWaitMs } from './pageCommon';
import type { BlockDefinition, ReadKind } from '../types';

/** Read Element settings. A non-empty `url` selects background-tab mode; otherwise `tab` is read. */
export interface ReadElementConfig {
  url: string;
  /** Read from this tab of the run (Open Tab) instead of BlockFlow's own background tab for `url`. */
  tab: string;
  locator: string;
  read: ReadKind;
  name: string;
  reload: boolean;
}

/** What Read Element keeps in `ctx.state` (key `last`) to produce `previous` / `changed` next time. */
interface LastRead {
  signature: string;
  value: string;
}

/** Read kinds that need the attribute / class name setting. */
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
  defaultConfig: { url: '', tab: '', locator: '', read: 'text', name: '', reload: true },
  fields: [
    {
      key: 'locator',
      label: 'Element',
      kind: 'locator',
      required: true,
      templated: true,
      pickerUrlKey: 'url',
      pickPrefers: 'stable',
      placeholder: 'CSS, text=…, role=…, label=…, or use "Pick on page"',
    },
    {
      key: 'url',
      label: 'Page URL',
      kind: 'url',
      templated: true,
      placeholder: 'https://example.com',
      help: 'BlockFlow opens it in its own background tab. Leave empty to read the run\'s tab instead (see Tab).',
    },
    {
      key: 'tab',
      label: 'Tab',
      kind: 'text',
      placeholder: DEFAULT_TAB,
      help: 'Used when Page URL is empty: read from this tab of the run (from Open Tab), as it is now, without reloading.',
    },
    {
      key: 'read',
      label: 'Read',
      kind: 'select',
      options: [
        { value: 'text', label: 'its text' },
        { value: 'value', label: 'its value (input fields)' },
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
  summary: (config) => `${config.read}: ${config.locator || 'pick an element'}`,
  validate: (config) =>
    NEEDS_NAME.includes(config.read) && !String(config.name ?? '').trim()
      ? [{ key: 'name', code: 'config.required', message: `Attribute / class name is required to read "${config.read}"` }]
      : [],
  outputs: [
    { key: 'value', description: 'What was read ("true"/"false" for class and exists).' },
    { key: 'previous', description: 'The value from the last run (empty on the first run).' },
    { key: 'changed', description: 'True when value differs from previous (false on the first run).' },
    { key: 'count', description: 'How many elements matched the locator.' },
    { key: 'url', description: 'The page that was read.' },
    { key: 'locator', description: 'The locator that was read (also as `selector`, its name before v0.3).' },
  ],

  async run(ctx, input) {
    const { locator, read, name, reload } = ctx.config;
    if (NEEDS_NAME.includes(read) && !name.trim()) throw new Error('Attribute / class name is required');

    let url: string;
    let result: { found: boolean; text: string; count?: number; error?: string };
    if (ctx.config.url.trim()) {
      const normalized = normalizeHttpUrl(ctx.config.url);
      if (!normalized) throw new Error(`"${ctx.config.url}" is not a valid http(s) URL`);
      url = normalized;
      result = await ctx.host.page.readElement({ url, selector: locator, reload, read: { kind: read, name: name.trim() } });
    } else {
      // The run's own tab, as it is right now (after the Click / Fill blocks before this one).
      const tabId = requireSessionTab(input, ctx.config.tab || DEFAULT_TAB);
      url = (await ctx.host.tabs.info(tabId))?.url ?? '';
      try {
        const reading = await ctx.host.page.act(tabId, { op: 'read', locator, kind: read, name: name.trim() }, Math.min(pageWaitMs(ctx), 5_000));
        result = { found: true, text: String(reading.text ?? ''), count: Number(reading.count ?? 0) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.startsWith('Timed out')) throw error;
        result = { found: false, text: '' };
      }
    }
    if (result.error) throw new Error(result.error);
    if (!result.found) {
      ctx.log('warn', `Element not found on the page: ${locator}`);
      return null;
    }

    const value = read === 'text' ? normalizeText(result.text) : result.text;
    const signature = `${url}|${locator}|${read}|${name}`;
    const last = await ctx.state.get<LastRead>('last');
    await ctx.state.set('last', { signature, value } satisfies LastRead);
    const previous = last && last.signature === signature ? last.value : null;
    const changed = previous !== null && previous !== value;

    ctx.log('info', `Read ${read}: "${value}"${previous === null ? ' (first read)' : changed ? ` (was "${previous}")` : ' (unchanged)'}`);
    return { ...input, value, previous, changed, count: result.count ?? 0, url, locator, selector: locator };
  },
};
