import { uid } from '../core/id';
import { CodedError } from '../core/errors';
import { pixelDiff } from '../core/pixelDiff';
import { scaleRect, toImageRect } from '../core/visual';
import { done, loadScreenshot, saveScreenshot } from './blobStore';
import { act } from './pageDriver';
import type { PixelRect } from '../core/pixelDiff';
import type { VisualCompareRequest, VisualCompareResult, VisualHost } from '../core/visual';

/**
 * `Host.visual` (M5.3): baselines for Screenshot blocks with `compare`, and the comparisons made.
 *
 * Storage: its own IndexedDB database `blockflow-visual` (so it never races the `blockflow` database's
 * version upgrades), shared by the background and the editor (same extension origin):
 * - `baselines`, keyPath `key` = "<workflowId>/<nodeId>": the baseline PNG as a data: URL. Not pruned;
 *   replaced by `updateBaseline` or "Accept new baseline".
 * - `comparisons`, keyPath `id`, index `nodeId`: one record per compare (status, ratio, screenshot ids
 *   of actual / baseline-as-compared / diff). The newest MAX_COMPARISONS are kept.
 * The actual screenshot, the baseline copy and the diff picture are ordinary screenshots (blobStore), so
 * they are pruned with the others.
 *
 * Decoding works where the background runs: Chrome's service worker and Firefox's background page both
 * have `createImageBitmap` and `OffscreenCanvas`. The pixel diff itself is src/core/pixelDiff.ts.
 */

export const VISUAL_DB = 'blockflow-visual';
const VISUAL_DB_VERSION = 1;
export const BASELINES = 'baselines';
export const COMPARISONS = 'comparisons';
const MAX_COMPARISONS = 300;
/** Elements a mask locator may cover (`>> nth=i`). */
const MAX_MASK_MATCHES = 20;

/** A stored baseline. */
export interface Baseline {
  key: string;
  workflowId: string;
  nodeId: string;
  /** data:image/png;base64,… */
  dataUrl: string;
  width: number;
  height: number;
  updatedAt: number;
  /** The run whose screenshot became the baseline. */
  runId: string;
}

/** One comparison, for the editor's Visual compare panel. */
export interface Comparison {
  id: string;
  runId: string;
  workflowId: string;
  nodeId: string;
  ts: number;
  status: VisualCompareResult['status'];
  width: number;
  height: number;
  diffPixels: number;
  diffRatio: number;
  threshold: number;
  maxDiffRatio: number;
  /** Screenshot ids: this run's picture, the baseline as compared (mismatch), the diff picture (mismatch). */
  actualId: string;
  baselineId?: string;
  diffId?: string;
  baselineSize?: { width: number; height: number };
  /** Set when this comparison's picture was accepted as the new baseline. */
  acceptedAt?: number;
}

export const baselineKey = (workflowId: string, nodeId: string) => `${workflowId}/${nodeId}`;

let dbPromise: Promise<IDBDatabase> | null = null;

function openVisualDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(VISUAL_DB, VISUAL_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BASELINES)) db.createObjectStore(BASELINES, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(COMPARISONS)) db.createObjectStore(COMPARISONS, { keyPath: 'id' }).createIndex('nodeId', 'nodeId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('Could not open IndexedDB'));
    };
  });
  return dbPromise;
}

async function visualStore(name: string, mode: IDBTransactionMode = 'readonly'): Promise<IDBObjectStore> {
  return (await openVisualDb()).transaction(name, mode).objectStore(name);
}

/** The pieces `createVisual` uses; tests replace them (no IndexedDB or canvas in Node). */
export interface VisualDeps {
  getBaseline(key: string): Promise<Baseline | undefined>;
  putBaseline(baseline: Baseline): Promise<void>;
  putComparison(comparison: Comparison): Promise<void>;
  loadImage(id: string): Promise<string | undefined>;
  /** Stores a picture like a screenshot; returns its id. */
  saveImage(runId: string, dataUrl: string): Promise<string>;
  decode(dataUrl: string): Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
  encode(data: Uint8ClampedArray, width: number, height: number): Promise<string>;
  /** A page agent request in the tab (`measure` without a locator, `box`). */
  act(tabId: number, request: { op: 'measure' } | { op: 'box'; locator: string }, timeoutMs: number, runId: string): Promise<Record<string, unknown>>;
  now(): number;
}

/** Decodes a PNG data: URL to RGBA, without colour management (exact pixels). */
export async function decodeImage(dataUrl: string): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('No 2D canvas to read the screenshot');
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: image.width, height: image.height, data: image.data };
  } finally {
    bitmap.close();
  }
}

/** RGBA → PNG data: URL. */
export async function encodeImage(data: Uint8ClampedArray, width: number, height: number): Promise<string> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2D canvas to draw the diff');
  context.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(binary)}`;
}

export async function getBaseline(key: string): Promise<Baseline | undefined> {
  return (await done((await visualStore(BASELINES)).get(key))) as Baseline | undefined;
}

export async function putBaseline(baseline: Baseline): Promise<void> {
  await done((await visualStore(BASELINES, 'readwrite')).put(baseline));
}

/** Deletes the baselines of a workflow (all its nodes). */
export async function deleteBaselines(workflowId: string): Promise<void> {
  const writable = await visualStore(BASELINES, 'readwrite');
  await done(writable.delete(IDBKeyRange.bound(`${workflowId}/`, `${workflowId}/￿`)));
}

export async function putComparison(comparison: Comparison): Promise<void> {
  await done((await visualStore(COMPARISONS, 'readwrite')).put(comparison));
  const all = (await done((await visualStore(COMPARISONS)).getAll())) as Comparison[];
  if (all.length > MAX_COMPARISONS) {
    const writable = await visualStore(COMPARISONS, 'readwrite');
    for (const old of all.sort((a, b) => a.ts - b.ts).slice(0, all.length - MAX_COMPARISONS)) writable.delete(old.id);
  }
}

export async function loadComparison(id: string): Promise<Comparison | undefined> {
  return (await done((await visualStore(COMPARISONS)).get(id))) as Comparison | undefined;
}

/** Comparisons of one node, newest first. */
export async function comparisonsOf(nodeId: string): Promise<Comparison[]> {
  const index = (await visualStore(COMPARISONS)).index('nodeId');
  return ((await done(index.getAll(nodeId))) as Comparison[]).sort((a, b) => b.ts - a.ts);
}

/**
 * The comparison a step record made: by id from its output when it passed, otherwise the one of its node
 * made while the step ran (a failed step has no output). Editor only.
 */
export async function findComparison(step: { nodeId: string; startedAt: string; durationMs?: number; output?: Record<string, unknown> }): Promise<Comparison | undefined> {
  const id = (step.output?.visual as { comparisonId?: unknown } | undefined)?.comparisonId;
  if (typeof id === 'string') return loadComparison(id);
  const start = Date.parse(step.startedAt);
  if (!Number.isFinite(start)) return undefined;
  const end = start + (step.durationMs ?? 120_000) + 1_000;
  return (await comparisonsOf(step.nodeId)).find((comparison) => comparison.ts >= start - 1_000 && comparison.ts <= end);
}

const defaultDeps: VisualDeps = {
  getBaseline,
  putBaseline,
  putComparison,
  loadImage: async (id) => (await loadScreenshot(id))?.dataUrl,
  saveImage: async (runId, dataUrl) => {
    const id = uid();
    await saveScreenshot({ id, runId, ts: Date.now(), dataUrl });
    return id;
  },
  decode: decodeImage,
  encode: encodeImage,
  act: (tabId, request, timeoutMs, runId) => act(tabId, request, timeoutMs, { runId }),
  now: () => Date.now(),
};

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * The masks in image pixels. Rectangles are CSS pixels from the picture's top-left; elements are found
 * with the `box` op (no waiting, no scrolling) and placed on the picture: the viewport for `visible`,
 * the document for `full`, the screenshot's element for `element`. Every element a locator matches is
 * masked (up to MAX_MASK_MATCHES).
 */
async function maskRects(request: VisualCompareRequest, deps: VisualDeps): Promise<{ rects: PixelRect[]; missing: string[] }> {
  if (request.mask.length === 0) return { rects: [], missing: [] };
  const timeoutMs = Math.min(request.timeoutMs, 5_000);
  const page = await deps.act(request.tabId, { op: 'measure' }, timeoutMs, request.runId);
  const scale = num(page.devicePixelRatio) || 1;
  const scroll = { x: num(page.scrollX), y: num(page.scrollY) };
  const box = async (locator: string) => deps.act(request.tabId, { op: 'box', locator }, timeoutMs, request.runId);
  // Where the picture's top-left is, in CSS pixels of the viewport.
  let origin = { x: 0, y: 0 };
  if (request.area === 'full') origin = { x: -scroll.x, y: -scroll.y };
  else if (request.area === 'element' && request.locator) {
    const own = await box(request.locator);
    if (own.found !== true) throw new CodedError('locator.not-found', `${request.locator} is gone: cannot place the mask regions`, { locator: request.locator });
    origin = { x: num(own.x), y: num(own.y) };
  }
  const rects: PixelRect[] = [];
  const missing: string[] = [];
  for (const mask of request.mask) {
    if ('rect' in mask) {
      rects.push(scaleRect(mask.rect, scale));
      continue;
    }
    const first = await box(mask.locator);
    if (first.found !== true) {
      missing.push(mask.locator);
      continue;
    }
    const count = Math.min(MAX_MASK_MATCHES, Math.max(1, num(first.count)));
    for (let i = 0; i < count; i += 1) {
      const found = i === 0 ? first : await box(`${mask.locator} >> nth=${i}`);
      if (found.found !== true || found.visible === false) continue;
      rects.push(toImageRect({ x: num(found.x), y: num(found.y), width: num(found.width), height: num(found.height) }, origin, scale));
    }
  }
  return { rects, missing };
}

/** `Host.visual` with the real storage, canvas and page agent (or `deps` in tests). */
export function createVisual(overrides: Partial<VisualDeps> = {}): VisualHost {
  const deps: VisualDeps = { ...defaultDeps, ...overrides };
  return {
    async compare(request) {
      const actualUrl = await deps.loadImage(request.screenshotId);
      if (!actualUrl) throw new CodedError('step.failed', 'The screenshot to compare is not stored');
      const actual = await deps.decode(actualUrl);
      const key = baselineKey(request.workflowId, request.nodeId);
      const baseline = await deps.getBaseline(key);
      const comparisonId = uid();
      const ts = deps.now();
      const record = (result: Omit<VisualCompareResult, 'comparisonId'>, extra: Partial<Comparison> = {}): Comparison => ({
        id: comparisonId,
        runId: request.runId,
        workflowId: request.workflowId,
        nodeId: request.nodeId,
        ts,
        status: result.status,
        width: result.width,
        height: result.height,
        diffPixels: result.diffPixels,
        diffRatio: result.diffRatio,
        threshold: request.threshold,
        maxDiffRatio: request.maxDiffRatio,
        actualId: request.screenshotId,
        ...(result.baselineId ? { baselineId: result.baselineId } : {}),
        ...(result.diffId ? { diffId: result.diffId } : {}),
        ...(result.baselineSize ? { baselineSize: result.baselineSize } : {}),
        ...extra,
      });

      if (!baseline || request.updateBaseline) {
        await deps.putBaseline({ key, workflowId: request.workflowId, nodeId: request.nodeId, dataUrl: actualUrl, width: actual.width, height: actual.height, updatedAt: ts, runId: request.runId });
        const result = { status: baseline ? ('baseline-updated' as const) : ('baseline-saved' as const), width: actual.width, height: actual.height, diffPixels: 0, diffRatio: 0 };
        await deps.putComparison(record(result));
        return { ...result, comparisonId };
      }

      const { rects, missing } = await maskRects(request, deps);
      const extra = missing.length > 0 ? { missingMasks: missing } : {};
      const expected = await deps.decode(baseline.dataUrl);
      if (expected.width !== actual.width || expected.height !== actual.height) {
        const baselineId = await deps.saveImage(request.runId, baseline.dataUrl);
        const result = { status: 'mismatch' as const, width: actual.width, height: actual.height, diffPixels: actual.width * actual.height, diffRatio: 1, baselineId, baselineSize: { width: expected.width, height: expected.height } };
        await deps.putComparison(record(result));
        return { ...result, comparisonId, ...extra };
      }
      const diff = pixelDiff(expected.data, actual.data, actual.width, actual.height, { threshold: request.threshold, mask: rects });
      const base = { width: actual.width, height: actual.height, diffPixels: diff.diffPixels, diffRatio: diff.diffRatio };
      if (diff.diffRatio <= request.maxDiffRatio) {
        const result = { status: 'match' as const, ...base };
        await deps.putComparison(record(result));
        return { ...result, comparisonId, ...extra };
      }
      const baselineId = await deps.saveImage(request.runId, baseline.dataUrl);
      const diffId = diff.diff ? await deps.saveImage(request.runId, await deps.encode(diff.diff, diff.width, diff.height)) : undefined;
      const result = { status: 'mismatch' as const, ...base, baselineId, ...(diffId ? { diffId } : {}) };
      await deps.putComparison(record(result));
      return { ...result, comparisonId, ...extra };
    },
  };
}

/**
 * "Accept new baseline" (`bf:accept-baseline`): the comparison's actual screenshot becomes the baseline of
 * its (workflow, node). Throws when the comparison or its picture is no longer kept.
 */
export async function acceptBaseline(comparisonId: string, deps: Partial<VisualDeps> & { loadComparison?: (id: string) => Promise<Comparison | undefined> } = {}): Promise<Comparison> {
  const all = { ...defaultDeps, ...deps };
  const comparison = await (deps.loadComparison ?? loadComparison)(comparisonId);
  if (!comparison) throw new Error('That comparison is no longer kept');
  const dataUrl = await all.loadImage(comparison.actualId);
  if (!dataUrl) throw new Error('The screenshot of that run is no longer kept: run the workflow again');
  const image = await all.decode(dataUrl);
  const now = all.now();
  await all.putBaseline({
    key: baselineKey(comparison.workflowId, comparison.nodeId),
    workflowId: comparison.workflowId,
    nodeId: comparison.nodeId,
    dataUrl,
    width: image.width,
    height: image.height,
    updatedAt: now,
    runId: comparison.runId,
  });
  const accepted = { ...comparison, acceptedAt: now };
  await all.putComparison(accepted);
  return accepted;
}
