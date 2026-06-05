import type { CaptureBundle } from '@shared/types';

// IndexedDB is the durable source of truth for filed-ready bundles. Local-first
// per PRD §9 — nothing leaves the browser until the user explicitly files.
const DB_NAME = 'gotcha';
const STORE = 'bundles';
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const store = db.transaction(STORE, mode).objectStore(STORE);
        const req = fn(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
      }),
  );
}

export const bundleDb = {
  put: (bundle: CaptureBundle): Promise<IDBValidKey> =>
    tx('readwrite', (s) => s.put(bundle)),

  get: (id: string): Promise<CaptureBundle | undefined> =>
    tx<CaptureBundle | undefined>('readonly', (s) => s.get(id) as IDBRequest<CaptureBundle | undefined>),

  all: (): Promise<CaptureBundle[]> =>
    tx<CaptureBundle[]>('readonly', (s) => s.getAll() as IDBRequest<CaptureBundle[]>),

  delete: (id: string): Promise<undefined> =>
    tx<undefined>('readwrite', (s) => s.delete(id) as IDBRequest<undefined>),
};
