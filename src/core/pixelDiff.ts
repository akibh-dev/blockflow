/**
 * Pixel comparison for visual checks (M5.3, Screenshot block `compare`). Pure: two RGBA buffers of the
 * same size in, counts and an optional diff picture out. No DOM, no canvas: the browser decodes the
 * PNGs (src/browser/visual.ts) and hands the bytes here, and tests feed hand-made buffers.
 *
 * How a pixel is judged (the approach pixelmatch and Playwright's `toHaveScreenshot` use):
 * - Colours are compared in YIQ space (brightness counts more than hue), after blending any
 *   transparency onto white. `threshold` 0 means any change counts, 1 means nothing does; 0.2 is
 *   Playwright's default.
 * - A differing pixel that looks like anti-aliasing (an edge pixel between a darker and a brighter
 *   neighbour, in a spot where the other picture has a solid area) is counted separately and does not
 *   make the comparison fail, unless `includeAA` is on. Font smoothing shifts like that are common
 *   between two renders of the same page.
 * - Pixels inside a `mask` rectangle (image pixels) are skipped: dates, ads, a live clock.
 */

/** A rectangle in image pixels. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelDiffOptions {
  /** 0 to 1: how different two colours must be to count. Default 0.2. */
  threshold?: number;
  /** Count anti-aliased pixels as different too. Default false. */
  includeAA?: boolean;
  /** Regions to ignore, in image pixels (clipped to the image). */
  mask?: PixelRect[];
  /** Also draw a diff picture (RGBA, same size). Default true. */
  diffImage?: boolean;
}

export interface PixelDiffResult {
  width: number;
  height: number;
  /** Pixels that differ (anti-aliased ones excluded unless `includeAA`). */
  diffPixels: number;
  /** Differing pixels judged to be anti-aliasing (not in `diffPixels` unless `includeAA`). */
  antialiasedPixels: number;
  /** Pixels skipped because a mask covers them. */
  maskedPixels: number;
  /** `diffPixels` / pixels not masked (0 when everything is masked). */
  diffRatio: number;
  /** Smallest rectangle around the differing pixels. */
  bounds?: PixelRect;
  /**
   * The diff picture: unchanged pixels as a faded grey copy of `expected`, differences red, anti-aliasing
   * yellow, masked regions tinted blue.
   */
  diff?: Uint8ClampedArray;
}

type Pixels = Uint8Array | Uint8ClampedArray;

/** Largest possible YIQ delta (black against white). */
const MAX_DELTA = 35215;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Pixel i's colour blended onto white, as YIQ parts. */
function rgbOnWhite(img: Pixels, i: number): [number, number, number] {
  const a = img[i + 3]! / 255;
  return [255 + (img[i]! - 255) * a, 255 + (img[i + 1]! - 255) * a, 255 + (img[i + 2]! - 255) * a];
}

const yOf = (r: number, g: number, b: number) => r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
const iOf = (r: number, g: number, b: number) => r * 0.59597799 - g * 0.2741761 - b * 0.32180189;
const qOf = (r: number, g: number, b: number) => r * 0.21147017 - g * 0.52261711 + b * 0.31114694;

/**
 * Squared YIQ distance between pixel i of `a` and pixel j of `b`. With `brightnessOnly` the signed
 * brightness difference (a darker than b is positive).
 */
function colorDelta(a: Pixels, b: Pixels, i: number, j: number, brightnessOnly = false): number {
  const [r1, g1, b1] = rgbOnWhite(a, i);
  const [r2, g2, b2] = rgbOnWhite(b, j);
  const dy = yOf(r1, g1, b1) - yOf(r2, g2, b2);
  if (brightnessOnly) return dy;
  const di = iOf(r1, g1, b1) - iOf(r2, g2, b2);
  const dq = qOf(r1, g1, b1) - qOf(r2, g2, b2);
  const delta = 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq;
  return dy > 0 ? -delta : delta;
}

function samePixel(img: Pixels, i: number, j: number): boolean {
  return img[i] === img[j] && img[i + 1] === img[j + 1] && img[i + 2] === img[j + 2] && img[i + 3] === img[j + 3];
}

/** Whether the pixel at (x, y) has at least 3 identical neighbours (a solid area, not an edge). */
function hasManySiblings(img: Pixels, x: number, y: number, width: number, height: number): boolean {
  const i = (y * width + x) * 4;
  let same = x === 0 || x === width - 1 || y === 0 || y === height - 1 ? 1 : 0;
  for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny += 1) {
    for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx += 1) {
      if (nx === x && ny === y) continue;
      if (samePixel(img, i, (ny * width + nx) * 4)) same += 1;
      if (same > 2) return true;
    }
  }
  return false;
}

/**
 * Whether pixel (x, y) of `img` looks anti-aliased: it sits between a darker and a brighter neighbour,
 * has at most two identical neighbours, and that darkest or brightest neighbour is a solid area in both
 * pictures.
 */
function antialiased(img: Pixels, x: number, y: number, width: number, height: number, other: Pixels): boolean {
  const i = (y * width + x) * 4;
  let zeroes = x === 0 || x === width - 1 || y === 0 || y === height - 1 ? 1 : 0;
  let min = 0;
  let max = 0;
  let minX = -1;
  let minY = -1;
  let maxX = -1;
  let maxY = -1;
  for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny += 1) {
    for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx += 1) {
      if (nx === x && ny === y) continue;
      const delta = colorDelta(img, img, i, (ny * width + nx) * 4, true);
      if (delta === 0) {
        zeroes += 1;
        if (zeroes > 2) return false;
      } else if (delta < min) {
        min = delta;
        minX = nx;
        minY = ny;
      } else if (delta > max) {
        max = delta;
        maxX = nx;
        maxY = ny;
      }
    }
  }
  // Needs both a darker and a brighter neighbour.
  if (min === 0 || max === 0) return false;
  return (
    (hasManySiblings(img, minX, minY, width, height) && hasManySiblings(other, minX, minY, width, height)) ||
    (hasManySiblings(img, maxX, maxY, width, height) && hasManySiblings(other, maxX, maxY, width, height))
  );
}

/** 1 for every masked pixel, or undefined when nothing is masked. Returns the count too. */
function maskBits(mask: PixelRect[] | undefined, width: number, height: number): { bits?: Uint8Array; count: number } {
  if (!mask || mask.length === 0) return { count: 0 };
  const bits = new Uint8Array(width * height);
  let count = 0;
  for (const rect of mask) {
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) continue;
    const x0 = clampNumber(Math.floor(rect.x), 0, width);
    const y0 = clampNumber(Math.floor(rect.y), 0, height);
    const x1 = clampNumber(Math.ceil(rect.x + rect.width), 0, width);
    const y1 = clampNumber(Math.ceil(rect.y + rect.height), 0, height);
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const k = y * width + x;
        if (bits[k] === 0) {
          bits[k] = 1;
          count += 1;
        }
      }
    }
  }
  return count > 0 ? { bits, count } : { count: 0 };
}

/**
 * Compares two RGBA pictures of `width` × `height` pixels. Throws when a buffer does not have
 * `width * height * 4` bytes (compare sizes before calling: a size change is a difference of its own).
 */
export function pixelDiff(expected: Pixels, actual: Pixels, width: number, height: number, options: PixelDiffOptions = {}): PixelDiffResult {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) throw new Error(`Bad image size ${width}×${height}`);
  const size = width * height * 4;
  if (expected.length !== size || actual.length !== size) throw new Error(`Image data does not match ${width}×${height} (${expected.length} and ${actual.length} bytes)`);
  const threshold = clampNumber(Number.isFinite(options.threshold) ? Number(options.threshold) : 0.2, 0, 1);
  const maxDelta = MAX_DELTA * threshold * threshold;
  const includeAA = options.includeAA === true;
  const { bits, count: maskedPixels } = maskBits(options.mask, width, height);
  const diff = options.diffImage === false ? undefined : new Uint8ClampedArray(size);

  let diffPixels = 0;
  let antialiasedPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  // Whole pixels at once: most pixels of two screenshots are byte-identical.
  const aligned = expected.byteOffset % 4 === 0 && actual.byteOffset % 4 === 0;
  const a32 = aligned ? new Uint32Array(expected.buffer, expected.byteOffset, width * height) : undefined;
  const b32 = aligned ? new Uint32Array(actual.buffer, actual.byteOffset, width * height) : undefined;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const k = y * width + x;
      const i = k * 4;
      if (bits && bits[k] === 1) {
        if (diff) {
          const grey = 255 + (yOf(...rgbOnWhite(expected, i)) - 255) * 0.1;
          diff[i] = grey * 0.5;
          diff[i + 1] = grey * 0.5 + 60;
          diff[i + 2] = grey * 0.5 + 127;
          diff[i + 3] = 255;
        }
        continue;
      }
      const same = a32 && b32 ? a32[k] === b32[k] : expected[i] === actual[i] && expected[i + 1] === actual[i + 1] && expected[i + 2] === actual[i + 2] && expected[i + 3] === actual[i + 3];
      const delta = same ? 0 : colorDelta(expected, actual, i, i);
      if (Math.abs(delta) > maxDelta) {
        const aa = !includeAA && (antialiased(expected, x, y, width, height, actual) || antialiased(actual, x, y, width, height, expected));
        if (aa) {
          antialiasedPixels += 1;
          if (diff) {
            diff[i] = 255;
            diff[i + 1] = 255;
            diff[i + 2] = 0;
            diff[i + 3] = 255;
          }
        } else {
          diffPixels += 1;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (diff) {
            diff[i] = 255;
            diff[i + 1] = 0;
            diff[i + 2] = 0;
            diff[i + 3] = 255;
          }
        }
      } else if (diff) {
        const grey = 255 + (yOf(...rgbOnWhite(expected, i)) - 255) * 0.1;
        diff[i] = grey;
        diff[i + 1] = grey;
        diff[i + 2] = grey;
        diff[i + 3] = 255;
      }
    }
  }
  const compared = width * height - maskedPixels;
  return {
    width,
    height,
    diffPixels,
    antialiasedPixels,
    maskedPixels,
    diffRatio: compared > 0 ? diffPixels / compared : 0,
    ...(maxX >= 0 ? { bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } } : {}),
    ...(diff ? { diff } : {}),
  };
}
