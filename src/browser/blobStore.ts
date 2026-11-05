/**
 * Screenshots (and later datasets) live in IndexedDB, not storage.local: they are big, and
 * storage.local is small (about 10 MB) and slow for large values. Extension pages and the
 * background worker share the same IndexedDB (same chrome-extension:// origin).
 */

const DB_NAME = 'blockflow';
const DB_VERSION = 2;
/** Object store of `Screenshot`, keyPath `id`. Pruned to the newest MAX_SCREENSHOTS. */
export const SCREENSHOTS = 'screenshots';
/** Object store of `Dataset`, keyPath `name` (added in DB version 2). */
export const DATASETS = 'datasets';
const MAX_SCREENSHOTS = 150;

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

/** Stores a screenshot and deletes the oldest beyond MAX_SCREENSHOTS. */
export async function saveScreenshot(shot: Screenshot): Promise<void> {
  await done((await store(SCREENSHOTS, 'readwrite')).put(shot));
  // Keep the newest MAX_SCREENSHOTS.
  const all = (await done((await store(SCREENSHOTS)).getAll())) as Screenshot[];
  if (all.length > MAX_SCREENSHOTS) {
    const old = all.sort((a, b) => a.ts - b.ts).slice(0, all.length - MAX_SCREENSHOTS);
    const writable = await store(SCREENSHOTS, 'readwrite');
    for (const item of old) writable.delete(item.id);
  }
}

/** One screenshot by id (editor: run inspector, Reports page). */
export async function loadScreenshot(id: string): Promise<Screenshot | undefined> {
  return (await done((await store(SCREENSHOTS)).get(id))) as Screenshot | undefined;
}

/** Deletes every screenshot. Not called anywhere yet. */
export async function clearScreenshots(): Promise<void> {
  await done((await store(SCREENSHOTS, 'readwrite')).clear());
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
