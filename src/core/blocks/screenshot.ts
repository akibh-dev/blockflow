import { requireSessionTab } from '../session';
import { PAGE_ACCENT, PAGE_TIMEOUT_SECONDS, locatorField, pageWaitMs, tabField } from './pageCommon';
import type { BlockContext, BlockDefinition, ConfigProblem } from '../types';

/** Screenshot settings. `locator` matters for `area: element`, `quality` for JPEG. */
export interface ScreenshotConfig {
  tab: string;
  area: 'visible' | 'full' | 'element';
  locator: string;
  format: 'png' | 'jpeg';
  quality: number;
}

/**
 * Screenshot — a picture of the tab on purpose (step screenshots are taken by the step setting). Kept
 * with the run like step screenshots and shown on the step and in the report.
 */
export const screenshotBlock: BlockDefinition<ScreenshotConfig> = {
  type: 'screenshot',
  label: 'Screenshot',
  description: 'Take a picture of what the tab shows, the whole page, or one element. Shown on the step and in the report.',
  icon: '📷',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: 'main', area: 'visible', locator: '', format: 'png', quality: 80 },
  timeoutSeconds: PAGE_TIMEOUT_SECONDS,
  // Chromium needs the debugger for the full page, for elements of a tab that is not showing, and for
  // any tab that is not showing. Firefox does all of it with tabs.captureTab.
  permissions: (config) => (config.area === 'visible' ? [] : ['debugger']),
  fields: [
    {
      key: 'area',
      label: 'Take',
      kind: 'select',
      options: [
        { value: 'visible', label: 'what the tab shows (visible area)' },
        { value: 'full', label: 'the full page (Chromium: debugger)' },
        { value: 'element', label: 'one element' },
      ],
    },
    { ...locatorField('locator', 'Element', false), help: 'For "one element". It is scrolled into view first.' },
    {
      key: 'format',
      label: 'Format',
      kind: 'select',
      options: [
        { value: 'png', label: 'PNG (sharp)' },
        { value: 'jpeg', label: 'JPEG (smaller)' },
      ],
    },
    { key: 'quality', label: 'JPEG quality', kind: 'number', min: 1, max: 100 },
    tabField,
  ],
  summary: (config) => (config.area === 'element' ? `element ${config.locator || '…'}` : config.area === 'full' ? 'full page' : 'visible area'),
  validate: (config) => {
    const problems: ConfigProblem[] = [];
    if (config.area === 'element' && !String(config.locator ?? '').trim()) {
      problems.push({ key: 'locator', code: 'config.required', message: 'Element is required for "one element"' });
    }
    return problems;
  },
  outputs: [
    { key: 'screenshotId', description: 'Id of the stored picture (shown on the step and in the report).' },
    { key: 'screenshot', description: '{id, width, height, area}: the size in pixels.' },
  ],

  async run(ctx, input) {
    const { area, format, quality } = ctx.config;
    const locator = ctx.config.locator.trim();
    if (area === 'element' && !locator) throw new Error('Element is required for "one element"');
    const tabId = requireSessionTab(input, ctx.config.tab);
    const shot = await ctx.host.screenshots.take(tabId, {
      runId: ctx.runId,
      area,
      ...(area === 'element' ? { locator } : {}),
      format,
      quality,
      timeoutMs: pageWaitMs(ctx as BlockContext<object>),
    });
    ctx.log('info', `Screenshot of the ${area === 'element' ? locator : area === 'full' ? 'full page' : 'visible area'}: ${shot.width}×${shot.height}`);
    return { ...input, screenshotId: shot.id, screenshot: { ...shot, area } };
  },
};
