import { CodedError } from '../errors';
import { requireSessionTab } from '../session';
import { formatRatio, parseMaskRows } from '../visual';
import { PAGE_ACCENT, PAGE_TIMEOUT_SECONDS, locatorField, pageWaitMs, tabField } from './pageCommon';
import type { BlockContext, BlockDefinition, ConfigProblem, Row } from '../types';

/**
 * Screenshot settings. `locator` matters for `area: element`, `quality` for JPEG. With `compare` (M5.3)
 * the picture is checked against a baseline kept per (workflow, block): `threshold` per pixel,
 * `maxDiffRatio` for the whole picture, `mask` regions ignored, `updateBaseline` replaces the baseline.
 */
export interface ScreenshotConfig {
  tab: string;
  area: 'visible' | 'full' | 'element';
  locator: string;
  format: 'png' | 'jpeg';
  quality: number;
  compare: boolean;
  threshold: number;
  maxDiffRatio: number;
  mask: Row[];
  updateBaseline: boolean;
}

/** Problems with the visual comparison settings (also checked when the step runs). */
function compareProblems(config: ScreenshotConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const masks = parseMaskRows(config.mask);
  const hasMask = masks.masks.length > 0;
  if (!config.compare) {
    if (config.updateBaseline) problems.push({ key: 'updateBaseline', code: 'config.value', message: '"Update the baseline" needs "Compare with the baseline" on' });
    if (hasMask) problems.push({ key: 'mask', code: 'config.value', message: 'Mask regions are used only with "Compare with the baseline" on' });
    return problems;
  }
  if (config.format !== 'png') problems.push({ key: 'format', code: 'config.value', message: 'Comparing needs PNG: JPEG pictures change a little every time' });
  const threshold = Number(config.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) problems.push({ key: 'threshold', code: 'config.value', message: 'Colour threshold must be between 0 and 1 (0.2 is usual)' });
  const ratio = Number(config.maxDiffRatio);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) problems.push({ key: 'maxDiffRatio', code: 'config.value', message: 'Allowed difference must be a share between 0 and 1 (0.01 = 1% of the pixels)' });
  for (const message of masks.problems) problems.push({ key: 'mask', code: 'config.value', message });
  return problems;
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
  defaultConfig: { tab: 'main', area: 'visible', locator: '', format: 'png', quality: 80, compare: false, threshold: 0.2, maxDiffRatio: 0, mask: [], updateBaseline: false },
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
    {
      key: 'compare',
      label: 'Compare with the baseline',
      kind: 'boolean',
      help: 'Visual check: the first run keeps the picture as this block\'s baseline; later runs fail (visual.mismatch) when it looks different. PNG only.',
    },
    { key: 'threshold', label: 'Colour threshold', kind: 'number', min: 0, max: 1, step: 0.05, help: 'How different a pixel\'s colour must be to count, 0 to 1 (0.2 like Playwright; 0 = any change).' },
    { key: 'maxDiffRatio', label: 'Allowed difference', kind: 'number', min: 0, max: 1, step: 0.001, help: 'Share of pixels that may differ, 0 to 1 (0.01 = 1%). 0 = none.' },
    {
      key: 'mask',
      label: 'Ignore regions',
      kind: 'rows',
      help: 'Parts that change on their own (a clock, an ad): an element locator, or "x, y, width, height" in CSS pixels from the picture\'s top-left.',
      columns: [{ key: 'region', label: 'Element or x, y, width, height', placeholder: '#clock  ·  0, 0, 200, 40', locator: true }],
    },
    { key: 'updateBaseline', label: 'Update the baseline', kind: 'boolean', help: 'Save this run\'s picture as the new baseline and pass (like Playwright\'s --update-snapshots). Switch it off again after.' },
    tabField,
  ],
  summary: (config) => {
    const what = config.area === 'element' ? `element ${config.locator || '…'}` : config.area === 'full' ? 'full page' : 'visible area';
    return config.compare ? `${what}, compared${config.updateBaseline ? ' (update baseline)' : ''}` : what;
  },
  validate: (config) => {
    const problems: ConfigProblem[] = [];
    if (config.area === 'element' && !String(config.locator ?? '').trim()) {
      problems.push({ key: 'locator', code: 'config.required', message: 'Element is required for "one element"' });
    }
    problems.push(...compareProblems(config));
    return problems;
  },
  outputs: [
    { key: 'screenshotId', description: 'Id of the stored picture (shown on the step and in the report).' },
    { key: 'screenshot', description: '{id, width, height, area}: the size in pixels.' },
    { key: 'visual', description: 'With compare: {status (baseline-saved, baseline-updated, match), diffRatio, diffPixels, comparisonId}. A mismatch fails the step with visual.mismatch.' },
  ],

  async run(ctx, input) {
    const { area, format, quality } = ctx.config;
    const locator = ctx.config.locator.trim();
    if (area === 'element' && !locator) throw new Error('Element is required for "one element"');
    const problems = compareProblems(ctx.config);
    if (problems.length > 0) throw new CodedError('config.invalid', problems.map((problem) => problem.message).join('; '));
    if (ctx.config.compare && !ctx.host.visual) throw new CodedError('config.invalid', 'Visual comparison is not available here (it needs the extension)');
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
    const output = { ...input, screenshotId: shot.id, screenshot: { ...shot, area } };
    if (!ctx.config.compare || !ctx.host.visual) return output;

    const result = await ctx.host.visual.compare({
      runId: ctx.runId,
      workflowId: ctx.workflowId,
      nodeId: ctx.nodeId,
      tabId,
      screenshotId: shot.id,
      area,
      ...(area === 'element' ? { locator } : {}),
      threshold: Number(ctx.config.threshold),
      maxDiffRatio: Number(ctx.config.maxDiffRatio),
      mask: parseMaskRows(ctx.config.mask).masks,
      updateBaseline: Boolean(ctx.config.updateBaseline),
      timeoutMs: pageWaitMs(ctx as BlockContext<object>),
    });
    if (result.missingMasks?.length) ctx.log('warn', `Mask regions not on the page (ignored): ${result.missingMasks.join(', ')}`);
    if (result.status === 'mismatch') {
      const message = result.baselineSize
        ? `The screenshot is ${result.width}×${result.height}, the baseline ${result.baselineSize.width}×${result.baselineSize.height}`
        : `The screenshot differs from the baseline: ${formatRatio(result.diffRatio)} of the pixels (${result.diffPixels}), more than the ${formatRatio(Number(ctx.config.maxDiffRatio))} allowed`;
      throw new CodedError('visual.mismatch', `${message}. See baseline / actual / diff in Reports; "Accept new baseline" if the new look is right.`);
    }
    const notes = { 'baseline-saved': 'No baseline yet: this screenshot is the baseline now', 'baseline-updated': 'Baseline replaced by this screenshot', match: `Matches the baseline (${formatRatio(result.diffRatio)} of the pixels differ)` };
    ctx.log('info', notes[result.status]);
    return { ...output, visual: { status: result.status, diffRatio: result.diffRatio, diffPixels: result.diffPixels, comparisonId: result.comparisonId } };
  },
};
