import { describe, expect, it, vi } from 'vitest';
import { acceptBaseline, createVisual } from '../../src/browser/visual';
import type { Baseline, Comparison, VisualDeps } from '../../src/browser/visual';
import type { VisualCompareRequest } from '../../src/core/visual';

vi.mock('wxt/browser', () => ({ browser: {} }));

/** "Pictures" are `img:<width>x<height>:<colour>[:x,y,w,h=colour…]` strings; decode paints them. */
function decode(dataUrl: string) {
  const [, size = '1x1', colour = '255', ...patches] = dataUrl.split(':');
  const [width, height] = size.split('x').map(Number) as [number, number];
  const data = new Uint8ClampedArray(width * height * 4);
  const paint = (x0: number, y0: number, w: number, h: number, value: number) => {
    for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) data.set([value, value, value, 255], (y * width + x) * 4);
  };
  paint(0, 0, width, height, Number(colour));
  for (const patch of patches) {
    const [rect = '', value = '0'] = patch.split('=');
    const [x, y, w, h] = rect.split(',').map(Number) as [number, number, number, number];
    paint(x, y, w, h, Number(value));
  }
  return Promise.resolve({ width, height, data });
}

function setup(page: { scrollX?: number; scrollY?: number; devicePixelRatio?: number; boxes?: Record<string, Record<string, unknown>> } = {}) {
  const images = new Map<string, string>();
  const baselines = new Map<string, Baseline>();
  const comparisons = new Map<string, Comparison>();
  const requests: unknown[] = [];
  let saved = 0;
  const deps: VisualDeps = {
    getBaseline: async (key) => baselines.get(key),
    putBaseline: async (baseline) => void baselines.set(baseline.key, baseline),
    putComparison: async (comparison) => void comparisons.set(comparison.id, comparison),
    loadImage: async (id) => images.get(id),
    saveImage: async (_runId, dataUrl) => {
      saved += 1;
      images.set(`saved-${saved}`, dataUrl);
      return `saved-${saved}`;
    },
    decode,
    encode: async (_data, width, height) => `diff:${width}x${height}`,
    act: async (_tabId, request) => {
      requests.push(request);
      if (request.op === 'measure') return { scrollX: page.scrollX ?? 0, scrollY: page.scrollY ?? 0, devicePixelRatio: page.devicePixelRatio ?? 1 };
      return page.boxes?.[request.locator] ?? { found: false, count: 0 };
    },
    now: () => 1_000,
  };
  const visual = createVisual(deps);
  const compare = (screenshot: string, extra: Partial<VisualCompareRequest> = {}) => {
    const id = `shot-${images.size + 1}`;
    images.set(id, screenshot);
    return visual.compare({ runId: 'run', workflowId: 'wf', nodeId: 'shot', tabId: 7, screenshotId: id, area: 'visible', threshold: 0.2, maxDiffRatio: 0, mask: [], updateBaseline: false, timeoutMs: 5_000, ...extra });
  };
  return { deps, images, baselines, comparisons, requests, compare };
}

describe('Host.visual (src/browser/visual.ts)', () => {
  it('first compare stores the baseline per (workflow, node); the same picture matches', async () => {
    const t = setup();
    const first = await t.compare('img:20x10:255');
    expect(first).toMatchObject({ status: 'baseline-saved', width: 20, height: 10, diffPixels: 0 });
    expect(t.baselines.get('wf/shot')).toMatchObject({ dataUrl: 'img:20x10:255', width: 20, height: 10, runId: 'run' });
    expect(t.comparisons.get(first.comparisonId)).toMatchObject({ status: 'baseline-saved', actualId: 'shot-1', nodeId: 'shot', workflowId: 'wf' });
    const again = await t.compare('img:20x10:255');
    expect(again).toMatchObject({ status: 'match', diffRatio: 0 });
    expect(again.diffId).toBeUndefined();
    // Nothing to mask: the page is not asked anything.
    expect(t.requests).toEqual([]);
  });

  it('a mismatch keeps the baseline as compared and a diff picture', async () => {
    const t = setup();
    await t.compare('img:20x10:255');
    const changed = await t.compare('img:20x10:255:0,0,10,10=0');
    expect(changed).toMatchObject({ status: 'mismatch', diffPixels: 100, diffRatio: 0.5, baselineId: 'saved-1', diffId: 'saved-2' });
    expect(t.images.get('saved-1')).toBe('img:20x10:255');
    expect(t.images.get('saved-2')).toBe('diff:20x10');
    expect(t.comparisons.get(changed.comparisonId)).toMatchObject({ status: 'mismatch', baselineId: 'saved-1', diffId: 'saved-2', actualId: 'shot-2' });
    // Within the allowed share it passes.
    expect(await t.compare('img:20x10:255:0,0,10,10=0', { maxDiffRatio: 0.5 })).toMatchObject({ status: 'match', diffRatio: 0.5 });
    // The baseline was not replaced by the failed runs.
    expect(t.baselines.get('wf/shot')?.dataUrl).toBe('img:20x10:255');
  });

  it('another size is a mismatch without a pixel diff', async () => {
    const t = setup();
    await t.compare('img:20x10:255');
    expect(await t.compare('img:20x12:255')).toMatchObject({ status: 'mismatch', diffRatio: 1, baselineSize: { width: 20, height: 10 }, baselineId: 'saved-1' });
  });

  it('updateBaseline replaces it and passes', async () => {
    const t = setup();
    await t.compare('img:20x10:255');
    expect(await t.compare('img:20x10:0', { updateBaseline: true })).toMatchObject({ status: 'baseline-updated' });
    expect(t.baselines.get('wf/shot')?.dataUrl).toBe('img:20x10:0');
  });

  it('masks: rectangles scale by the pixel ratio; elements are placed on the visible area', async () => {
    const t = setup({ devicePixelRatio: 2, scrollY: 500, boxes: { '#clock': { found: true, x: 5, y: 0, width: 5, height: 5, count: 1, visible: true } } });
    await t.compare('img:40x20:255');
    // Clock at viewport (5,0) 5×5 CSS → image (10,0) 10×10; rectangle (0,5) 2×5 CSS → image (0,10) 4×10.
    const masked = await t.compare('img:40x20:255:10,0,10,10=0:0,10,4,10=0', { mask: [{ locator: '#clock' }, { rect: { x: 0, y: 5, width: 2, height: 5 } }] });
    expect(masked).toMatchObject({ status: 'match', diffPixels: 0 });
    expect(t.requests).toEqual([{ op: 'measure' }, { op: 'box', locator: '#clock' }]);
    // Unmasked, the same change fails.
    expect((await t.compare('img:40x20:255:10,0,10,10=0')).status).toBe('mismatch');
  });

  it('masks: every match of a locator, full page adds the scroll, missing ones are reported', async () => {
    const boxes = {
      '.ad': { found: true, x: 0, y: -100, width: 10, height: 10, count: 2, visible: true },
      '.ad >> nth=1': { found: true, x: 20, y: -100, width: 10, height: 10, count: 2, visible: true },
    };
    const t = setup({ scrollY: 100, boxes });
    await t.compare('img:40x40:255');
    // Viewport y -100 with the page scrolled by 100 is document y 0.
    const result = await t.compare('img:40x40:255:0,0,10,10=0:20,0,10,10=0', { area: 'full', mask: [{ locator: '.ad' }, { locator: '#gone' }] });
    expect(result).toMatchObject({ status: 'match', missingMasks: ['#gone'] });
  });

  it('masks: an element screenshot measures from its own element', async () => {
    const boxes = {
      '#card': { found: true, x: 100, y: 50, width: 20, height: 20, count: 1, visible: true },
      '#badge': { found: true, x: 110, y: 55, width: 5, height: 5, count: 1, visible: true },
    };
    const t = setup({ boxes });
    await t.compare('img:20x20:255', { area: 'element', locator: '#card' });
    expect(await t.compare('img:20x20:255:10,5,5,5=0', { area: 'element', locator: '#card', mask: [{ locator: '#badge' }] })).toMatchObject({ status: 'match' });
  });

  it('Accept new baseline: the comparison\'s picture becomes the baseline', async () => {
    const t = setup();
    await t.compare('img:20x10:255');
    const changed = await t.compare('img:20x10:0');
    const accepted = await acceptBaseline(changed.comparisonId, { ...t.deps, loadComparison: async (id) => t.comparisons.get(id) });
    expect(accepted.acceptedAt).toBe(1_000);
    expect(t.baselines.get('wf/shot')).toMatchObject({ dataUrl: 'img:20x10:0' });
    expect(t.comparisons.get(changed.comparisonId)?.acceptedAt).toBe(1_000);
    expect(await t.compare('img:20x10:0')).toMatchObject({ status: 'match' });
    await expect(acceptBaseline('nope', { ...t.deps, loadComparison: async () => undefined })).rejects.toThrow(/no longer kept/);
  });
});
