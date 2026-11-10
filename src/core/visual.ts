import { locatorProblem } from './check';
import type { PixelRect } from './pixelDiff';

/**
 * Visual comparison (M5.3): what the Screenshot block asks `Host.visual.compare` for, what it answers,
 * and the pure helpers both sides share (mask rows, mask coordinates). Pure: no browser APIs.
 *
 * Baselines are kept per (workflow id, node id) by the host (src/browser/visual.ts). The first compare
 * saves the screenshot as the baseline and passes; later ones diff against it (src/core/pixelDiff.ts).
 */

/** One region to ignore: a rectangle in CSS pixels of the screenshot (from its top-left), or an element. */
export type VisualMask = { rect: PixelRect } | { locator: string };

export interface VisualCompareRequest {
  runId: string;
  workflowId: string;
  nodeId: string;
  /** The tab the screenshot was taken of (mask elements are measured there). */
  tabId: number;
  /** The screenshot just taken and stored (`Host.screenshots.take`). */
  screenshotId: string;
  /** What the screenshot shows, to place mask elements on it. */
  area: 'visible' | 'full' | 'element';
  /** For `area: element`: the screenshot's element. */
  locator?: string;
  /** Per-pixel colour threshold, 0 to 1. */
  threshold: number;
  /** Largest share of (unmasked) pixels that may differ, 0 to 1. */
  maxDiffRatio: number;
  mask: VisualMask[];
  /** Replace the baseline with this screenshot and pass. */
  updateBaseline: boolean;
  timeoutMs: number;
}

export interface VisualCompareResult {
  /**
   * `baseline-saved`: there was none, this screenshot is it now. `baseline-updated`: replaced on purpose.
   * `match`: within `maxDiffRatio`. `mismatch`: too many pixels differ, or the size changed.
   */
  status: 'baseline-saved' | 'baseline-updated' | 'match' | 'mismatch';
  /** Id of the stored comparison (the editor's Visual compare panel and Accept use it). */
  comparisonId: string;
  width: number;
  height: number;
  diffPixels: number;
  diffRatio: number;
  /** Screenshot ids (blobStore) of the baseline as compared and of the diff picture, on a mismatch. */
  baselineId?: string;
  diffId?: string;
  /** Set when the baseline has another size: no pixel diff was made. */
  baselineSize?: { width: number; height: number };
  /** Mask elements that were not on the page (ignored). */
  missingMasks?: string[];
}

/** `Host.visual`: the browser side of visual comparison. */
export interface VisualHost {
  compare(request: VisualCompareRequest): Promise<VisualCompareResult>;
}

const NUMBER = String.raw`-?\d+(?:\.\d+)?`;
const RECT = new RegExp(`^\\s*(${NUMBER})\\s*[, ]\\s*(${NUMBER})\\s*[, ]\\s*(${NUMBER})\\s*[, ]\\s*(${NUMBER})\\s*$`);

/** "x, y, width, height" (commas or spaces) → a rectangle, or null when the text is not four numbers. */
export function parseRect(text: string): PixelRect | null {
  const match = RECT.exec(text);
  if (!match) return null;
  const [x, y, width, height] = match.slice(1, 5).map(Number) as [number, number, number, number];
  return { x, y, width, height };
}

/**
 * The Screenshot block's `mask` rows (`{ region }`) as masks, with a message per bad row. A region is
 * four numbers (a rectangle in CSS pixels of the screenshot) or else a locator.
 */
export function parseMaskRows(rows: unknown): { masks: VisualMask[]; problems: string[] } {
  const masks: VisualMask[] = [];
  const problems: string[] = [];
  if (rows === undefined || rows === null || rows === '') return { masks, problems };
  if (!Array.isArray(rows)) return { masks, problems: ['Mask must be a list of rows like {"region": "#clock"}'] };
  rows.forEach((row, index) => {
    const region = typeof row === 'object' && row !== null ? (row as Record<string, unknown>).region : row;
    const text = typeof region === 'string' || typeof region === 'number' ? String(region).trim() : '';
    if (!text) {
      if (region !== undefined && region !== '' && typeof region !== 'string') problems.push(`Mask row ${index + 1} must be text`);
      return;
    }
    if (/^[\d\s.,-]+$/.test(text)) {
      const rect = parseRect(text);
      if (!rect) problems.push(`Mask row ${index + 1} "${text}" is not "x, y, width, height"`);
      else if (rect.x < 0 || rect.y < 0) problems.push(`Mask row ${index + 1}: x and y must not be negative`);
      else if (!(rect.width > 0 && rect.height > 0)) problems.push(`Mask row ${index + 1}: width and height must be more than 0`);
      else masks.push({ rect });
      return;
    }
    const problem = locatorProblem(text);
    if (problem) problems.push(`Mask row ${index + 1}: ${problem.message}`);
    else masks.push({ locator: text });
  });
  return { masks, problems };
}

/**
 * A box in CSS pixels of the page (document coordinates) as image pixels of a screenshot whose top-left
 * is `origin` (document CSS pixels) at `scale` image pixels per CSS pixel.
 */
export function toImageRect(pageBox: PixelRect, origin: { x: number; y: number }, scale: number): PixelRect {
  return { x: (pageBox.x - origin.x) * scale, y: (pageBox.y - origin.y) * scale, width: pageBox.width * scale, height: pageBox.height * scale };
}

/** A mask rectangle given in CSS pixels of the screenshot, as image pixels. */
export function scaleRect(rect: PixelRect, scale: number): PixelRect {
  return { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale };
}

/** "0.42%" for a ratio, with enough digits to show small differences. */
export function formatRatio(ratio: number): string {
  const percent = ratio * 100;
  return `${percent === 0 ? '0' : percent < 0.01 ? percent.toPrecision(2) : percent < 10 ? percent.toFixed(2) : percent.toFixed(1)}%`;
}
