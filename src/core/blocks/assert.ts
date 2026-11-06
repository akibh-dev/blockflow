import { CodedError } from '../errors';
import { OPERATOR_OPTIONS, operatorLabel, testClause } from '../condition';
import { requireSessionTab } from '../session';
import { truncate } from '../text';
import { locatorField, pageWaitMs, tabField } from './pageCommon';
import type { ReadKind } from '../page';
import type { BlockContext, BlockDefinition, Payload } from '../types';

/** What Assert checks: a data value, a page property, or an element state (the yes/no subjects in STATES). */
export type AssertSubject =
  | 'value'
  | 'text'
  | 'input'
  | 'attribute'
  | 'count'
  | 'url'
  | 'title'
  | 'visible'
  | 'hidden'
  | 'checked'
  | 'unchecked'
  | 'enabled'
  | 'disabled';

/** Assert settings. `operator` / `expected` are ignored by the yes/no subjects. */
export interface AssertConfig {
  subject: AssertSubject;
  value: string;
  locator: string;
  name: string;
  operator: string;
  expected: string;
  message: string;
  soft: boolean;
  tab: string;
}

/** Yes/no subjects: what to read, and the answer that passes. */
const STATES: Partial<Record<AssertSubject, { kind: ReadKind; wanted: string }>> = {
  visible: { kind: 'visible', wanted: 'true' },
  hidden: { kind: 'visible', wanted: 'false' },
  checked: { kind: 'checked', wanted: 'true' },
  unchecked: { kind: 'checked', wanted: 'false' },
  enabled: { kind: 'enabled', wanted: 'true' },
  disabled: { kind: 'enabled', wanted: 'false' },
};

/** Read kind for the comparing subjects (url/title/value are not read through the agent). */
const READS: Partial<Record<AssertSubject, ReadKind>> = { text: 'text', input: 'value', attribute: 'attribute', count: 'count' };
/** Subjects that do not look at an element (everything else needs `locator`). */
const NO_ELEMENT: AssertSubject[] = ['value', 'url', 'title'];
const RETRY_EVERY_MS = 250;
/** One look at the page; the retries do the waiting. */
const READ_MS = 300;

/** The current value of the subject, or null when its element does not exist (yet). */
async function actual(ctx: BlockContext<AssertConfig>, input: Payload): Promise<string | null> {
  const { subject } = ctx.config;
  if (subject === 'value') return ctx.config.value;
  const tabId = requireSessionTab(input, ctx.config.tab);
  if (subject === 'url' || subject === 'title') {
    const info = await ctx.host.tabs.info(tabId);
    if (!info) throw new Error('The tab was closed');
    return subject === 'url' ? info.url : info.title;
  }
  const kind = STATES[subject]?.kind ?? READS[subject] ?? 'text';
  try {
    const result = await ctx.host.page.act(tabId, { op: 'read', locator: ctx.config.locator, kind, name: ctx.config.name }, READ_MS);
    const text = String(result.text ?? '');
    return kind === 'text' ? text.replace(/\s+/g, ' ').trim() : text;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Timed out')) return null;
    throw error;
  }
}

/** Whether the value passes: yes/no subjects compare with STATES; the rest use condition.ts's testClause. */
function passes(config: AssertConfig, value: string | null): boolean {
  const state = STATES[config.subject];
  if (state) return value === state.wanted;
  if (value === null) return false;
  return testClause({ left: value, operator: config.operator, right: config.expected });
}

/** Human-readable statement of the check, for logs, the summary and the default failure message. */
function describe(config: AssertConfig): string {
  const what = config.subject === 'value' ? 'value' : `${config.subject}${config.locator ? ` of ${config.locator}` : ''}`;
  if (STATES[config.subject]) return `${config.locator} is ${config.subject}`;
  return `${what} ${operatorLabel(config.operator)} "${config.expected}"`;
}

/**
 * Assert — the test step. Checks a value from the data, or something on the page (text, input
 * value, attribute, count, visible, checked, enabled, URL, title). Page checks are retried until the
 * step's timeout, like Playwright's expect(), because pages change after clicks.
 * Failing fails the run (and takes a screenshot); "soft" records the failure and keeps going.
 */
export const assertBlock: BlockDefinition<AssertConfig> = {
  type: 'assert',
  label: 'Assert',
  description: 'Check that something is true. Fails the run (or just records it, if soft) when it is not.',
  icon: '✅',
  accent: '#16a34a',
  defaultConfig: { subject: 'text', value: '', locator: '', name: '', operator: 'contains', expected: '', message: '', soft: false, tab: 'main' },
  timeoutSeconds: 10,
  fields: [
    {
      key: 'subject',
      label: 'Check',
      kind: 'select',
      options: [
        { value: 'text', label: 'text of an element' },
        { value: 'input', label: 'value of an input field' },
        { value: 'attribute', label: 'attribute of an element' },
        { value: 'count', label: 'how many elements match' },
        { value: 'visible', label: 'element is visible' },
        { value: 'hidden', label: 'element is hidden or absent' },
        { value: 'checked', label: 'checkbox is checked' },
        { value: 'unchecked', label: 'checkbox is not checked' },
        { value: 'enabled', label: 'element is enabled' },
        { value: 'disabled', label: 'element is disabled' },
        { value: 'url', label: 'page URL' },
        { value: 'title', label: 'page title' },
        { value: 'value', label: 'a value from the data ({{…}})' },
      ],
    },
    { ...locatorField('locator', 'Element', false), help: 'For element checks.' },
    { key: 'name', label: 'Attribute name', kind: 'text', placeholder: 'aria-pressed', help: 'Only for "attribute of an element".' },
    { key: 'value', label: 'Value', kind: 'text', templated: true, placeholder: '{{status}}', help: 'Only for "a value from the data".' },
    { key: 'operator', label: 'Must', kind: 'select', options: OPERATOR_OPTIONS, help: 'Not used by the yes/no checks (visible, checked…).' },
    { key: 'expected', label: 'Expected', kind: 'text', templated: true, placeholder: 'Welcome' },
    { key: 'message', label: 'Message when it fails', kind: 'text', templated: true, placeholder: 'Login did not show the greeting' },
    { key: 'soft', label: 'Soft: record the failure but keep going', kind: 'boolean' },
    tabField,
  ],
  summary: (config) => truncate(describe(config), 40),
  validate: (config) => [
    ...(!NO_ELEMENT.includes(config.subject) && !String(config.locator ?? '').trim()
      ? [{ key: 'locator', code: 'config.required', message: `Element is required to check "${config.subject}"` }]
      : []),
    ...(config.subject === 'attribute' && !String(config.name ?? '').trim()
      ? [{ key: 'name', code: 'config.required', message: 'Attribute name is required for "attribute of an element"' }]
      : []),
  ],
  outputs: [{ key: 'actual', description: 'What was found.' }],

  async run(ctx, input) {
    const { subject, locator } = ctx.config;
    if (!NO_ELEMENT.includes(subject) && !locator.trim()) {
      throw new Error('Element is required for this check');
    }
    if (subject === 'attribute' && !ctx.config.name.trim()) throw new Error('Attribute name is required');

    // Page checks retry until the step's time is nearly up; data checks are answered at once.
    // (Counted in attempts, not wall-clock time, so the engine's own clock stays the only clock.)
    let retriesLeft = subject === 'value' ? 0 : Math.floor((pageWaitMs(ctx as BlockContext<object>) - 1_000) / (RETRY_EVERY_MS + READ_MS));
    let found = await actual(ctx, input);
    while (!passes(ctx.config, found) && retriesLeft > 0) {
      retriesLeft -= 1;
      await ctx.host.sleep(RETRY_EVERY_MS);
      found = await actual(ctx, input);
    }

    if (passes(ctx.config, found)) {
      ctx.log('info', `✓ ${describe(ctx.config)}`);
      return { ...input, actual: found };
    }
    const got = found === null ? 'no matching element' : `"${truncate(found, 120)}"`;
    const message = ctx.config.message.trim() || `Expected ${describe(ctx.config)}, got ${got}`;
    const failure = new CodedError('assert.failed', message, locator.trim() && subject !== 'value' && subject !== 'url' && subject !== 'title' ? { locator: locator.trim() } : {});
    if (ctx.config.soft) {
      ctx.softFail(failure);
      return { ...input, actual: found };
    }
    throw failure;
  },
};
