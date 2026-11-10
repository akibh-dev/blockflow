import { describe, expect, it } from 'vitest';
import { pixelDiff } from '../../src/core/pixelDiff';
import { formatRatio, parseMaskRows, parseRect, scaleRect, toImageRect } from '../../src/core/visual';

/** A width × height picture filled with one colour. */
function image(width: number, height: number, rgba: [number, number, number, number] = [255, 255, 255, 255]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return data;
}

/** Paints a rectangle. */
function fill(data: Uint8ClampedArray, width: number, rect: { x: number; y: number; w: number; h: number }, rgba: [number, number, number, number]) {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) for (let x = rect.x; x < rect.x + rect.w; x += 1) data.set(rgba, (y * width + x) * 4);
}

const pixel = (data: Uint8ClampedArray | undefined, width: number, x: number, y: number) => Array.from(data?.subarray((y * width + x) * 4, (y * width + x) * 4 + 4) ?? []);

describe('pixelDiff', () => {
  it('identical pictures: no difference, a faded grey diff', () => {
    const a = image(20, 10, [0, 0, 0, 255]);
    const result = pixelDiff(a, image(20, 10, [0, 0, 0, 255]), 20, 10);
    expect(result).toMatchObject({ diffPixels: 0, antialiasedPixels: 0, maskedPixels: 0, diffRatio: 0 });
    expect(result.bounds).toBeUndefined();
    // Black, faded towards white.
    expect(pixel(result.diff, 20, 3, 3)).toEqual([230, 230, 230, 255]);
  });

  it('counts a changed block, its bounds and ratio, and paints it red', () => {
    const a = image(100, 50);
    const b = image(100, 50);
    fill(b, 100, { x: 10, y: 5, w: 20, h: 10 }, [0, 0, 255, 255]);
    const result = pixelDiff(a, b, 100, 50);
    expect(result.diffPixels).toBe(200);
    expect(result.diffRatio).toBeCloseTo(200 / 5000);
    expect(result.bounds).toEqual({ x: 10, y: 5, width: 20, height: 10 });
    expect(pixel(result.diff, 100, 15, 8)).toEqual([255, 0, 0, 255]);
    expect(pixel(result.diff, 100, 50, 30)).toEqual([255, 255, 255, 255]);
  });

  it('threshold: a slight shade passes at 0.2, fails at 0', () => {
    const a = image(10, 10, [200, 200, 200, 255]);
    const b = image(10, 10, [205, 205, 205, 255]);
    expect(pixelDiff(a, b, 10, 10).diffPixels).toBe(0);
    expect(pixelDiff(a, b, 10, 10, { threshold: 0 }).diffPixels).toBe(100);
    // Black against white fails even at the highest useful threshold.
    expect(pixelDiff(image(4, 4, [0, 0, 0, 255]), image(4, 4), 4, 4, { threshold: 0.9 }).diffPixels).toBe(16);
  });

  it('transparent pixels are compared as if on white', () => {
    expect(pixelDiff(image(4, 4, [0, 0, 0, 0]), image(4, 4, [255, 255, 255, 255]), 4, 4, { threshold: 0 }).diffPixels).toBe(0);
  });

  it('mask rectangles are skipped (clipped to the picture) and tinted blue', () => {
    const a = image(100, 50);
    const b = image(100, 50);
    fill(b, 100, { x: 10, y: 5, w: 20, h: 10 }, [0, 0, 0, 255]);
    fill(b, 100, { x: 90, y: 40, w: 10, h: 10 }, [0, 0, 0, 255]);
    const result = pixelDiff(a, b, 100, 50, { mask: [{ x: 8, y: 4, width: 30, height: 12 }, { x: 85, y: 35, width: 50, height: 50 }] });
    expect(result.diffPixels).toBe(0);
    expect(result.maskedPixels).toBe(30 * 12 + 15 * 15);
    const tinted = pixel(result.diff, 100, 12, 6);
    expect(tinted[2]).toBeGreaterThan(tinted[0]!);
    // Half masked: only the rest counts.
    const half = pixelDiff(a, b, 100, 50, { mask: [{ x: 10, y: 5, width: 10, height: 10 }] });
    expect(half.diffPixels).toBe(100 + 100);
    expect(half.diffRatio).toBeCloseTo(200 / (5000 - 100));
    // Fractional rectangles cover every pixel they touch; nonsense ones are ignored.
    expect(pixelDiff(a, b, 100, 50, { mask: [{ x: 9.5, y: 4.5, width: 21, height: 11 }, { x: Number.NaN, y: 0, width: 5, height: 5 }] }).maskedPixels).toBe(22 * 12);
  });

  it('anti-aliased edge pixels are not counted unless includeAA', () => {
    // A black square on white; the other picture has a grey edge pixel on its border (font smoothing).
    const a = image(20, 20);
    fill(a, 20, { x: 5, y: 5, w: 10, h: 10 }, [0, 0, 0, 255]);
    const b = new Uint8ClampedArray(a);
    fill(b, 20, { x: 4, y: 8, w: 1, h: 1 }, [128, 128, 128, 255]);
    const result = pixelDiff(a, b, 20, 20);
    expect(result).toMatchObject({ diffPixels: 0, antialiasedPixels: 1 });
    expect(pixel(result.diff, 20, 4, 8)).toEqual([255, 255, 0, 255]);
    expect(pixelDiff(a, b, 20, 20, { includeAA: true }).diffPixels).toBe(1);
  });

  it('a lone changed pixel in a flat area is a real difference', () => {
    const a = image(10, 10);
    const b = image(10, 10);
    fill(b, 10, { x: 5, y: 5, w: 1, h: 1 }, [0, 0, 0, 255]);
    expect(pixelDiff(a, b, 10, 10).diffPixels).toBe(1);
  });

  it('no diff picture when not asked; bad sizes throw; works on unaligned views', () => {
    expect(pixelDiff(image(2, 2), image(2, 2), 2, 2, { diffImage: false }).diff).toBeUndefined();
    expect(() => pixelDiff(image(2, 2), image(3, 2), 2, 2)).toThrow(/does not match/);
    const buffer = new Uint8Array(1 + 16);
    const view = buffer.subarray(1);
    view.fill(255);
    expect(pixelDiff(view, image(2, 2), 2, 2).diffPixels).toBe(0);
  });

  it('is fast enough for a 1300×850 screenshot (bound: 1.5 s, typically ~30 ms)', () => {
    const width = 1300;
    const height = 850;
    const a = image(width, height);
    // Text-like noise: stripes and blocks, so the colour and anti-aliasing paths run.
    for (let y = 0; y < height; y += 7) fill(a, width, { x: 0, y, w: width, h: 2 }, [30, 30, 30, 255]);
    const b = new Uint8ClampedArray(a);
    fill(b, width, { x: 100, y: 100, w: 600, h: 400 }, [200, 40, 40, 255]);
    const started = performance.now();
    const result = pixelDiff(a, b, width, height);
    const elapsed = performance.now() - started;
    expect(result.diffPixels).toBeGreaterThan(100_000);
    expect(elapsed).toBeLessThan(1_500);
  });
});

describe('visual helpers', () => {
  it('parseRect: four numbers with commas or spaces', () => {
    expect(parseRect('10, 20, 30, 40')).toEqual({ x: 10, y: 20, width: 30, height: 40 });
    expect(parseRect('1.5 2 3 4')).toEqual({ x: 1.5, y: 2, width: 3, height: 4 });
    expect(parseRect('1,2,3')).toBeNull();
    expect(parseRect('#clock')).toBeNull();
  });

  it('parseMaskRows: rectangles, locators and strict problems', () => {
    expect(parseMaskRows([{ region: '#clock' }, { region: '0, 0, 100, 40' }, { region: ' ' }])).toEqual({ masks: [{ locator: '#clock' }, { rect: { x: 0, y: 0, width: 100, height: 40 } }], problems: [] });
    expect(parseMaskRows(undefined)).toEqual({ masks: [], problems: [] });
    expect(parseMaskRows('x').problems).toEqual([expect.stringMatching(/list of rows/)]);
    const bad = parseMaskRows([{ region: '1, 2, 3' }, { region: '0, 0, 0, 10' }, { region: '-1, 0, 5, 5' }, { region: 'role=button[name="x"' }]);
    expect(bad.masks).toEqual([]);
    expect(bad.problems).toEqual([
      expect.stringMatching(/row 1 .*x, y, width, height/),
      expect.stringMatching(/row 2: width and height/),
      expect.stringMatching(/row 3: x and y/),
      expect.stringMatching(/row 4: .*unclosed/),
    ]);
  });

  it('places boxes on a picture and formats ratios', () => {
    expect(toImageRect({ x: 110, y: 220, width: 50, height: 10 }, { x: 100, y: 200 }, 2)).toEqual({ x: 20, y: 40, width: 100, height: 20 });
    expect(scaleRect({ x: 1, y: 2, width: 3, height: 4 }, 1.5)).toEqual({ x: 1.5, y: 3, width: 4.5, height: 6 });
    expect(formatRatio(0)).toBe('0%');
    expect(formatRatio(0.0425)).toBe('4.25%');
    expect(formatRatio(0.00001)).toBe('0.0010%');
    expect(formatRatio(0.5)).toBe('50.0%');
  });
});
