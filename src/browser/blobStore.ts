/**
 * Screenshots (and later datasets) live in IndexedDB, not storage.local: they are big, and
 * storage.local is small (about 10 MB) and slow for large values. Extension pages and the
 * background worker share the same IndexedDB (same chrome-extension:// origin).
 */

const DB_NAME = 'blockflow';
const DB_VERSION = 2;
export const SCREENSHOTS = 'screenshots';
export const DATASETS = 'datasets';
const MAX_SCREENSHOTS = 150;

let dbPromise: Promise<IDBDatabase> | null = null;

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

export function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export async function store(name: string, mode: IDBTransactionMode = 'readonly'): Promise<IDBObjectStore> {
  return (await openDb()).transaction(name, mode).objectStore(name);
}

export interface Screenshot {
  id: string;
  runId: string;
  ts: number;
  /** data:image/jpeg;base64,… */
  dataUrl: string;
}

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

export async function loadScreenshot(id: string): Promise<Screenshot | undefined> {
  return (await done((await store(SCREENSHOTS)).get(id))) as Screenshot | undefined;
}

export async function clearScreenshots(): Promise<void> {
  await done((await store(SCREENSHOTS, 'readwrite')).clear());
}
