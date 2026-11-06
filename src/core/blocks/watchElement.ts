import { normalizeText, truncate } from '../text';
import { normalizeHttpUrl } from '../url';
import type { BlockContext, BlockDefinition, Payload } from '../types';

/** Watch Element settings. `intervalSeconds` is only used when the block is a root. */
export interface WatchElementConfig {
  locator: string;
  url: string;
  intervalSeconds: number;
  reload: boolean;
  emitOnFirstRead: boolean;
}

interface LastRead {
  /** url + locator the value was read with; a different signature means "start over". */
  signature: string;
  value: string;
}

/** Checks that are currently running, so a slow page never gets two overlapping checks. */
const inFlight = new Set<string>();

/**
 * One read of the element, compared with the last value in `ctx.state` (key `last`). Returns the
 * payload to send, or null for "nothing to report" (no change, baseline read, element missing,
 * or a check for this node is already in flight). `always` (Run button) reports the current value
 * even when unchanged. Stores the new value before deciding, so a failing downstream run never
 * makes the same change fire twice.
 */
async function check(ctx: BlockContext<WatchElementConfig>, always = false): Promise<Payload | null> {
  const flightKey = `${ctx.workflowId}/${ctx.nodeId}`;
  if (inFlight.has(flightKey)) {
    ctx.log('warn', 'Skipped: the previous check is still running');
    return null;
  }
  inFlight.add(flightKey);
  try {
    const url = normalizeHttpUrl(ctx.config.url);
    if (!url) throw new Error(`"${ctx.config.url}" is not a valid http(s) URL`);
    const { locator, reload } = ctx.config;

    const result = await ctx.host.page.readElement({ url, selector: locator, reload });
    if (result.error) throw new Error(result.error);
    if (!result.found) {
      ctx.log('warn', `Element not found on the page: ${locator}`);
      return null;
    }

    const value = normalizeText(result.text);
    const signature = `${url}|${locator}`;
    const previous = await ctx.state.get<LastRead>('last');
    await ctx.state.set('last', { signature, value } satisfies LastRead);

    const payload = (previousValue: string | null): Payload => ({
      value,
      previous: previousValue,
      url,
      locator,
      selector: locator,
      changedAt: ctx.host.now().toISOString(),
    });

    if (always) {
      const known = previous && previous.signature === signature ? previous.value : null;
      ctx.log('info', `Current value: "${truncate(value)}"`);
      return payload(known);
    }
    if (!previous || previous.signature !== signature) {
      ctx.log('info', `Watching. Current value: "${truncate(value)}"`);
      return ctx.config.emitOnFirstRead ? payload(null) : null;
    }
    if (previous.value === value) {
      ctx.log('debug', 'No change');
      return null;
    }
    ctx.log('info', `Changed: "${truncate(previous.value)}" → "${truncate(value)}"`);
    return payload(previous.value);
  } finally {
    inFlight.delete(flightKey);
  }
}

/**
 * Watch Element — checks one element of a page and fires when its text changes.
 *
 * - Nothing connected to its input: it STARTS the flow and checks on its own schedule.
 * - Something connected to its input (e.g. a Timer): each incoming payload triggers one check,
 *   so the upstream block decides how often.
 *
 * The first successful read only records a baseline, unless "emit on first read" is on.
 */
export const watchElementBlock: BlockDefinition<WatchElementConfig> = {
  type: 'watch-element',
  label: 'Watch Element',
  description: 'Fire when the text of a part of a web page changes.',
  icon: '👁',
  accent: '#10b981',
  defaultConfig: {
    locator: '',
    url: '',
    intervalSeconds: 60,
    reload: true,
    emitOnFirstRead: false,
  },
  fields: [
    {
      key: 'locator',
      label: 'Element',
      kind: 'locator',
      required: true,
      pickerUrlKey: 'url',
      pickPrefers: 'stable',
      placeholder: 'CSS, text=…, role=…, or use "Pick on page"',
    },
    {
      key: 'url',
      label: 'Page URL',
      kind: 'url',
      required: true,
      templated: true,
      placeholder: 'https://example.com/product',
    },
    {
      key: 'intervalSeconds',
      label: 'Check every (seconds)',
      kind: 'number',
      min: 1,
      step: 1,
      help: 'Only used when this block starts the flow. After a Timer, the Timer decides. Under 30 seconds keeps the background worker awake.',
    },
    {
      key: 'reload',
      label: 'Reload page before checking',
      kind: 'boolean',
      help: 'Needed to see server-side changes. Turn off for pages that update themselves.',
    },
    {
      key: 'emitOnFirstRead',
      label: 'Fire on the first read too',
      kind: 'boolean',
      help: 'Off = the first read just records the starting value.',
    },
  ],
  summary: (config) => config.locator || 'Pick an element',
  outputs: [
    { key: 'value', description: 'The new text of the element.' },
    { key: 'previous', description: 'The text before the change (null on the first read).' },
    { key: 'url', description: 'The page that was watched.' },
    { key: 'locator', description: 'The element locator (also as `selector`, its name before v0.3).' },
    { key: 'changedAt', description: 'ISO time the change was noticed.' },
  ],

  async start(ctx) {
    const ms = ctx.config.intervalSeconds * 1000;
    // Schedule first so a failed first check does not stop the watcher.
    await ctx.timers.set('poll', { delayMs: ms, periodMs: ms });
    ctx.log('info', `Watching "${ctx.config.locator}" every ${ctx.config.intervalSeconds}s`);
    const result = await check(ctx);
    if (result) await ctx.emit(result);
  },

  // Run button: read once and pass the current value on, changed or not.
  async trigger(ctx) {
    return check(ctx, true);
  },

  async run(ctx, input) {
    const result = await check(ctx);
    return result ? { ...input, ...result } : null;
  },

  async onTimer(ctx, name) {
    if (name !== 'poll') return;
    const result = await check(ctx);
    if (result) await ctx.emit(result);
  },
};
