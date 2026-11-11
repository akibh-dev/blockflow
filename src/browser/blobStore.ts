/**
 * Screenshots (and later datasets) live in IndexedDB, not storage.local: they are big, and
 * storage.local is small (about 10 MB) and slow for large values. Extension pages and the
 * background worker share the same IndexedDB (same chrome-extension:// origin).
 */

import { getLimits } from './limits';

const DB_NAME = 'blockflow';
const DB_VERSION = 2;
/** Object store of `Screenshot`, keyPath `id`. Pruned to the newest `screenshots` of Settings → Limits (default 150). */
export const SCREENSHOTS = 'screenshots';
/** Object store of `Dataset`, keyPath `name` (added in DB version 2). */
export const DATASETS = 'datasets';

let dbPromise: Promise<IDBDatabase> | null = null;

/** Opens (and on first use creates/upgrades) the `blockflow` database. Cached; a failed open is retried next call. */
export function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SCREENSHOTS)) db.createObjectStore(SCREENSHOTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(DATASETS)) db.createObjectStore(DATASETS, { keyPath: 'name' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('Could not open IndexedDB'));
    };
  });
  return dbPromise;
}

/** Promise for one IndexedDB request. */
export function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** An object store in a fresh single-store transaction. */
export async function store(name: string, mode: IDBTransactionMode = 'readonly'): Promise<IDBObjectStore> {
  return (await openDb()).transaction(name, mode).objectStore(name);
}

/** A screenshot taken after a step (per its screenshot setting; by default when it went wrong). Runs refer to it by `id`. */
export interface Screenshot {
  id: string;
  runId: string;
  ts: number;
  /** data:image/jpeg;base64,… */
  dataUrl: string;
}

/** Stores a screenshot and deletes the oldest beyond the screenshot limit of Settings → Limits (trace images have their own limits). */
export async function saveScreenshot(shot: Screenshot): Promise<void> {
  await done((await store(SCREENSHOTS, 'readwrite')).put(shot));
  // Keep the newest `screenshots`. Trace image keys start with "~", after every UUID: not loaded here.
  const { screenshots: keep } = await getLimits();
  const all = (await done((await store(SCREENSHOTS)).getAll(IDBKeyRange.upperBound(TRACE_PREFIX, true)))) as Screenshot[];
  if (all.length > keep) {
    const old = all.sort((a, b) => a.ts - b.ts).slice(0, all.length - keep);
    const writable = await store(SCREENSHOTS, 'readwrite');
    for (const item of old) writable.delete(item.id);
  }
}

// ---------- M5.1 trace images ----------

/**
 * Trace screenshots (before/after each traced step) share the `screenshots` store but not its limit, so a
 * traced run cannot push out the failure screenshots of other runs. Their key carries what pruning needs
 * (`~t|<time>|<runId>|<bytes>|<random>`), so it reads keys only, never the images.
 *
 * Limits: at most MAX_TRACE_IMAGES_PER_RUN images per run (later steps of a longer run get no images), and
 * at most MAX_TRACE_IMAGES / MAX_TRACE_BYTES over all runs: the oldest runs' trace images go first, whole
 * runs at a time, never the run being saved.
 */
export const TRACE_PREFIX = '~t|';
/** Before + after for 100 steps. */
export const MAX_TRACE_IMAGES_PER_RUN = 200;
export const MAX_TRACE_IMAGES = 1_000;
/** Sum of the data: URL lengths (about the stored size). */
export const MAX_TRACE_BYTES = 120 * 1024 * 1024;

/** What a trace image key says about the image. */
export interface TraceKey {
  id: string;
  ts: number;
  runId: string;
  bytes: number;
}

/** The key of a new trace image. */
export function traceKey(runId: string, ts: number, bytes: number, random: string): string {
  return `${TRACE_PREFIX}${ts.toString(36).padStart(9, '0')}|${runId.replace(/\|/g, '_')}|${bytes}|${random}`;
}

/** Reads a trace image key; undefined for other screenshot ids. */
export function parseTraceKey(id: string): TraceKey | undefined {
  if (!id.startsWith(TRACE_PREFIX)) return undefined;
  const [ts, runId, bytes] = id.slice(TRACE_PREFIX.length).split('|');
  if (!ts || !runId || bytes === undefined) return undefined;
  return { id, ts: parseInt(ts, 36), runId, bytes: Number(bytes) || 0 };
}

/**
 * Which trace images to delete so that the stored ones fit the totals: whole runs, oldest first (by their
 * first image), never `keepRunId`. Pure, for tests.
 */
export function traceEvictions(keys: TraceKey[], keepRunId: string, limits = { images: MAX_TRACE_IMAGES, bytes: MAX_TRACE_BYTES }): string[] {
  let images = keys.length;
  let bytes = keys.reduce((sum, key) => sum + key.bytes, 0);
  if (images <= limits.images && bytes <= limits.bytes) return [];
  const runs = new Map<string, TraceKey[]>();
  for (const key of keys) runs.set(key.runId, [...(runs.get(key.runId) ?? []), key]);
  const oldestFirst = [...runs.entries()]
    .filter(([runId]) => runId !== keepRunId)
    .sort(([, a], [, b]) => Math.min(...a.map((key) => key.ts)) - Math.min(...b.map((key) => key.ts)));
  const evicted: string[] = [];
  for (const [, list] of oldestFirst) {
    if (images <= limits.images && bytes <= limits.bytes) break;
    for (const key of list) {
      evicted.push(key.id);
      images -= 1;
      bytes -= key.bytes;
    }
  }
  return evicted;
}

/** The ids of every stored trace image (keys only). */
async function traceKeys(): Promise<TraceKey[]> {
  const keys = (await done((await store(SCREENSHOTS)).getAllKeys(IDBKeyRange.bound(TRACE_PREFIX, `${TRACE_PREFIX}\uffff`)))) as string[];
  return keys.map(parseTraceKey).filter((key): key is TraceKey => key !== undefined);
}

/**
 * Stores one trace image of `runId` and evicts the oldest runs' trace images beyond the totals. Returns its
 * id, or null when the run already has MAX_TRACE_IMAGES_PER_RUN images (nothing is stored).
 */
export async function saveTraceImage(runId: string, dataUrl: string, random: string, now = Date.now()): Promise<string | null> {
  const existing = await traceKeys();
  const safeRun = runId.replace(/\|/g, '_');
  if (existing.filter((key) => key.runId === safeRun).length >= MAX_TRACE_IMAGES_PER_RUN) return null;
  const id = traceKey(runId, now, dataUrl.length, random);
  await done((await store(SCREENSHOTS, 'readwrite')).put({ id, runId, ts: now, dataUrl } satisfies Screenshot));
  const evict = traceEvictions([...existing, { id, ts: now, runId: safeRun, bytes: dataUrl.length }], safeRun);
  if (evict.length > 0) {
    const writable = await store(SCREENSHOTS, 'readwrite');
    for (const old of evict) writable.delete(old);
  }
  return id;
}

/** One screenshot by id (editor: run inspector, Reports page). */
export async function loadScreenshot(id: string): Promise<Screenshot | undefined> {
  return (await done((await store(SCREENSHOTS)).get(id))) as Screenshot | undefined;
}

/** A named table saved by Save to Dataset; rows are whatever the block wrote. */
export interface Dataset {
  name: string;
  rows: unknown[];
  updatedAt: number;
}

/** One dataset by name (`Host.datasets.read` returns its rows, or []). */
export async function readDataset(name: string): Promise<Dataset | undefined> {
  return (await done((await store(DATASETS)).get(name))) as Dataset | undefined;
}

/** `Host.datasets.write`: appends to or replaces a dataset; returns its new row count. */
export async function writeDataset(name: string, rows: unknown[], mode: 'append' | 'replace'): Promise<number> {
  const existing = mode === 'append' ? ((await readDataset(name))?.rows ?? []) : [];
  const next = [...existing, ...rows];
  await done((await store(DATASETS, 'readwrite')).put({ name, rows: next, updatedAt: Date.now() } satisfies Dataset));
  return next.length;
}

/** Every dataset (editor's Data page). */
export async function listDatasets(): Promise<Dataset[]> {
  return (await done((await store(DATASETS)).getAll())) as Dataset[];
}

/** Deletes one dataset (editor's Data page). */
export async function deleteDataset(name: string): Promise<void> {
  await done((await store(DATASETS, 'readwrite')).delete(name));
}
