import { CodedError } from '../errors';
import { AriaTemplateError, matchAriaSnapshot, parseAriaOutline, parseAriaTemplate } from '../ariaSnapshot';
import { OPERATOR_OPTIONS, operatorLabel, testClause } from '../condition';
import { requireSessionTab } from '../session';
import { truncate } from '../text';
import { locatorField, pageWaitMs, tabField } from './pageCommon';
import { SNAPSHOT_MAX_LINES } from '../page';
import type { ReadKind, SnapshotElement } from '../page';
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
  | 'disabled'
  | 'class'
  | 'css'
  | 'focused'
  | 'editable'
  | 'in-viewport'
  | 'accessible-name'
  | 'accessible-description'
  | 'aria-snapshot'
  | 'console-errors';

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
  focused: { kind: 'focused', wanted: 'true' },
  editable: { kind: 'editable', wanted: 'true' },
  'in-viewport': { kind: 'in-viewport', wanted: 'true' },
};

/** Read kind for the comparing subjects (url/title/value are not read through the agent). */
const READS: Partial<Record<AssertSubject, ReadKind>> = {
  text: 'text',
  input: 'value',
  attribute: 'attribute',
  count: 'count',
  class: 'class',
  css: 'css',
  'accessible-name': 'accessible-name',
  'accessible-description': 'accessible-description',
};
/** Subjects that read something named by `name`: the attribute, or the CSS property. */
const NEEDS_NAME: Partial<Record<AssertSubject, string>> = { attribute: 'Attribute name', css: 'CSS property' };
/** Subjects that do not look at an element (everything else needs `locator`). */
const NO_ELEMENT: AssertSubject[] = ['value', 'url', 'title', 'console-errors'];
/** Subjects where the element is optional (empty = the whole page). */
const ELEMENT_OPTIONAL: AssertSubject[] = ['aria-snapshot'];
/** A `{{…}}` token (as template.ts): such templates are only known at run time. */
const HAS_TOKEN = /\{\{\s*[^{}]+?\s*\}\}/;
const RETRY_EVERY_MS = 250;
/** One look at the page; the retries do the waiting. */
const READ_MS = 300;

/** The current value of the subject, or null when its element does not exist (yet). */
async function actual(ctx: BlockContext<AssertConfig>, input: Payload): Promise<string | null> {
  const { subject } = ctx.config;
  if (subject === 'value') return ctx.config.value;
  const tabId = requireSessionTab(input, ctx.config.tab);
  if (subject === 'console-errors') return String((await ctx.host.network.console(tabId)).filter((entry) => entry.level === 'error').length);
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
  // "class contains active" means it has the class (every listed one), not a substring of another (inactive).
  if (config.subject === 'class' && (config.operator === 'contains' || config.operator === 'not-contains')) {
    const classes = value.split(/\s+/);
    const has = config.expected.split(/\s+/).filter(Boolean).every((name) => classes.includes(name));
    return config.operator === 'contains' ? has : !has;
  }
  return testClause({ left: value, operator: config.operator, right: config.expected });
}

/**
 * One look for `aria-snapshot`: the page (or the `locator` part) as an outline, matched against the
 * template (src/core/ariaSnapshot.ts). `pass: null` when the element is not there (yet).
 */
async function ariaLook(ctx: BlockContext<AssertConfig>, input: Payload, template: ReturnType<typeof parseAriaTemplate>): Promise<{ pass: boolean; message: string; actual: string | null }> {
  const tabId = requireSessionTab(input, ctx.config.tab);
  const locator = ctx.config.locator.trim();
  let result: Record<string, unknown>;
  try {
    result = await ctx.host.page.act(tabId, { op: 'snapshot', ...(locator ? { locator } : {}), maxLines: SNAPSHOT_MAX_LINES }, READ_MS);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Timed out')) return { pass: false, message: `no element matches ${locator}`, actual: null };
    throw error;
  }
  const outline = parseAriaOutline(String(result.snapshot ?? ''), (result.elements as SnapshotElement[] | undefined) ?? []);
  const matched = matchAriaSnapshot(outline, template);
  return { pass: matched.pass, message: matched.message, actual: matched.actual };
}

/** The template of an `aria-snapshot` check, or a config error naming the line and column. */
function ariaTemplate(expected: string): ReturnType<typeof parseAriaTemplate> {
  try {
    return parseAriaTemplate(expected);
  } catch (error) {
    if (error instanceof AriaTemplateError) throw new CodedError('config.invalid', `Expected ARIA snapshot, ${error.message}`);
    throw error;
  }
}

/** Human-readable statement of the check, for logs, the summary and the default failure message. */
function describe(config: AssertConfig): string {
  if (config.subject === 'aria-snapshot') return `ARIA snapshot of ${config.locator.trim() || 'the page'} matches`;
  const what = config.subject === 'value' ? 'value' : config.subject === 'console-errors' ? 'console errors' : `${config.subject}${config.locator ? ` of ${config.locator}` : ''}`;
  if (STATES[config.subject]) return `${config.locator} is ${config.subject}`;
  return `${what} ${operatorLabel(config.operator)} "${config.expected}"`;
}

/**
 * Assert — the test step. Checks a value from the data, or something on the page (text, input
 * value, attribute, count, visible, checked, enabled, focused, editable, in viewport, class, CSS,
 * accessible name / description, URL, title). Page checks are retried until the
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
  permissions: (config) => config.subject === 'console-errors' ? ['debugger'] : [],
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
        { value: 'focused', label: 'element has focus' },
        { value: 'editable', label: 'field is editable (enabled, not read-only)' },
        { value: 'in-viewport', label: 'element is in the viewport (scrolled into view)' },
        { value: 'class', label: 'class of an element (contains = has the class)' },
        { value: 'css', label: 'CSS value of an element (computed)' },
        { value: 'accessible-name', label: 'accessible name of an element' },
        { value: 'accessible-description', label: 'accessible description of an element' },
        { value: 'aria-snapshot', label: 'ARIA snapshot matches a template (page or element)' },
        { value: 'url', label: 'page URL' },
        { value: 'title', label: 'page title' },
        { value: 'console-errors', label: 'console errors and uncaught exceptions (Chromium)' },
        { value: 'value', label: 'a value from the data ({{…}})' },
      ],
    },
    { ...locatorField('locator', 'Element', false), help: 'For element checks. For "ARIA snapshot": the part of the page (empty = the whole page).' },
    { key: 'name', label: 'Attribute or CSS property', kind: 'text', placeholder: 'aria-pressed', help: 'The attribute name for "attribute of an element", the CSS property (color, display…) for "CSS value".' },
    { key: 'value', label: 'Value', kind: 'text', templated: true, placeholder: '{{status}}', help: 'Only for "a value from the data".' },
    { key: 'operator', label: 'Must', kind: 'select', options: OPERATOR_OPTIONS, help: 'Not used by the yes/no checks (visible, checked…).' },
    {
      key: 'expected',
      label: 'Expected',
      kind: 'text',
      templated: true,
      multiline: true,
      placeholder: 'Welcome',
      help: 'For "ARIA snapshot": a template, one line per element, nested by indenting: - heading "Welcome" [level=1], - button /Sign (in|up)/, - listitem: Apples.',
    },
    { key: 'message', label: 'Message when it fails', kind: 'text', templated: true, placeholder: 'Login did not show the greeting' },
    { key: 'soft', label: 'Soft: record the failure but keep going', kind: 'boolean' },
    tabField,
  ],
  summary: (config) => truncate(describe(config), 40),
  validate: (config) => [
    ...(!NO_ELEMENT.includes(config.subject) && !ELEMENT_OPTIONAL.includes(config.subject) && !String(config.locator ?? '').trim()
      ? [{ key: 'locator', code: 'config.required', message: `Element is required to check "${config.subject}"` }]
      : []),
    ...(NEEDS_NAME[config.subject] && !String(config.name ?? '').trim()
      ? [{ key: 'name', code: 'config.required', message: `${NEEDS_NAME[config.subject]} is required (in "name") to check "${config.subject}"` }]
      : []),
    ...ariaProblems(config),
  ],
  outputs: [{ key: 'actual', description: 'What was found.' }],

  async run(ctx, input) {
    const { subject, locator } = ctx.config;
    if (subject === 'aria-snapshot') return runAria(ctx, input);
    if (!NO_ELEMENT.includes(subject) && !locator.trim()) {
      throw new Error('Element is required for this check');
    }
    if (NEEDS_NAME[subject] && !ctx.config.name.trim()) throw new Error(`${NEEDS_NAME[subject]} is required`);

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
    const failure = new CodedError('assert.failed', message, locator.trim() && !NO_ELEMENT.includes(subject) ? { locator: locator.trim() } : {});
    if (ctx.config.soft) {
      ctx.softFail(failure);
      return { ...input, actual: found };
    }
    throw failure;
  },
};

/** Import-time check of an `aria-snapshot` template (skipped when it has `{{…}}`, rendered at run time). */
function ariaProblems(config: AssertConfig): { key: string; code: string; message: string }[] {
  if (config.subject !== 'aria-snapshot') return [];
  const expected = String(config.expected ?? '');
  if (!expected.trim()) return [{ key: 'expected', code: 'config.required', message: 'Expected is required for "aria-snapshot": a template like - heading "Welcome" [level=1]' }];
  if (HAS_TOKEN.test(expected)) return [];
  try {
    parseAriaTemplate(expected);
    return [];
  } catch (error) {
    if (error instanceof AriaTemplateError) return [{ key: 'expected', code: 'config.value', message: `Expected ARIA snapshot, ${error.message}` }];
    throw error;
  }
}

/** Assert `aria-snapshot`: retried like the other page checks until the step's time is nearly up. */
async function runAria(ctx: BlockContext<AssertConfig>, input: Payload): Promise<Payload> {
  const template = ariaTemplate(ctx.config.expected);
  const locator = ctx.config.locator.trim();
  let retriesLeft = Math.floor((pageWaitMs(ctx as BlockContext<object>) - 1_000) / (RETRY_EVERY_MS + READ_MS));
  let look = await ariaLook(ctx, input, template);
  while (!look.pass && retriesLeft > 0) {
    retriesLeft -= 1;
    await ctx.host.sleep(RETRY_EVERY_MS);
    look = await ariaLook(ctx, input, template);
  }
  if (look.pass) {
    ctx.log('info', `✓ ${describe(ctx.config)}`);
    return { ...input, actual: look.actual };
  }
  const detail = look.actual === null ? `Expected ${describe(ctx.config)}, but ${look.message}` : look.message;
  const message = ctx.config.message.trim() ? `${ctx.config.message.trim()}\n${detail}` : detail;
  const failure = new CodedError('assert.failed', message, locator ? { locator } : {});
  if (ctx.config.soft) {
    ctx.softFail(failure);
    return { ...input, actual: look.actual };
  }
  throw failure;
}
