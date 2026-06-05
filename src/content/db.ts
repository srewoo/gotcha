import type { CaptureBundle } from '@shared/types';
import type { BundleSummary, IntegrationId } from '@shared/messaging';
import { MAX_REPORTS } from '@shared/capture-config';

// IndexedDB is the durable source of truth for filed-ready bundles. Local-first
// per PRD §9 — nothing leaves the browser until the user explicitly files.
//
// Two object stores:
//   • `bundles`   — the full, heavy payload (screenshot, DOM, replay). Read only
//                   when a single report is opened.
//   • `summaries` — a lightweight index row per report (id/title/counts/dates).
//                   The dashboard/popup list reads ONLY this, so listing never
//                   loads MB-sized blobs and stays fast as report count grows.
//
// Writes are capped to the most-recent MAX_REPORTS (oldest evicted) and are
// quota-aware: a QuotaExceededError triggers eviction of the oldest report and
// a retry, so a full disk degrades gracefully instead of failing the save.
const DB_NAME = 'gotcha';
const STORE = 'bundles';
const SUMMARY_STORE = 'summaries';
const VERSION = 2;

// MAX_REPORTS (hard cap, oldest auto-evicted) lives in capture-config so the UI
// can share it. Canonical summary derivation — used on write and during the v1→v2 backfill.
export function buildSummary(b: CaptureBundle): BundleSummary {
  return {
    id: b.id,
    title: b.title,
    createdAt: b.createdAt,
    counts: {
      console: b.console.length,
      errors: b.console.filter((c) => c.level === 'error').length,
      network: b.network.length,
      failed: b.network.filter((n) => n.failed).length,
      steps: b.steps.length,
    },
    hasTest: Boolean(b.generatedTest),
    filed: b.filed
      ? {
          integration: b.filed.integration as IntegrationId,
          identifier: b.filed.identifier,
          url: b.filed.url,
        }
      : null,
  };
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SUMMARY_STORE)) {
        db.createObjectStore(SUMMARY_STORE, { keyPath: 'id' });
        // v1 → v2 backfill: derive a summary row for every pre-existing bundle
        // inside the same version-change transaction.
        const txn = req.transaction;
        if (txn) {
          const dst = txn.objectStore(SUMMARY_STORE);
          txn.objectStore(STORE).openCursor().onsuccess = (e) => {
            const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
            if (!cursor) return;
            dst.put(buildSummary(cursor.value as CaptureBundle));
            cursor.continue();
          };
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

// Read a whole store via getAll.
function getAll<T>(store: string): Promise<T[]> {
  return open().then(
    (db) =>
      new Promise<T[]>((resolve, reject) => {
        const req = db.transaction(store, 'readonly').objectStore(store).getAll() as IDBRequest<T[]>;
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('getAll failed'));
      }),
  );
}

// Write the full bundle + its summary row in one atomic transaction.
function writeBoth(bundle: CaptureBundle): Promise<void> {
  return open().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const txn = db.transaction([STORE, SUMMARY_STORE], 'readwrite');
        txn.oncomplete = () => resolve();
        txn.onerror = () => reject(txn.error ?? new Error('write failed'));
        txn.onabort = () => reject(txn.error ?? new Error('write aborted'));
        txn.objectStore(STORE).put(bundle);
        txn.objectStore(SUMMARY_STORE).put(buildSummary(bundle));
      }),
  );
}

// Delete a report from both stores atomically.
function deleteBoth(id: string): Promise<void> {
  return open().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const txn = db.transaction([STORE, SUMMARY_STORE], 'readwrite');
        txn.oncomplete = () => resolve();
        txn.onerror = () => reject(txn.error ?? new Error('delete failed'));
        txn.objectStore(STORE).delete(id);
        txn.objectStore(SUMMARY_STORE).delete(id);
      }),
  );
}

async function summariesAsc(): Promise<BundleSummary[]> {
  const sums = await getAll<BundleSummary>(SUMMARY_STORE);
  return sums.sort((a, b) => a.createdAt - b.createdAt);
}

// Trim to the most-recent MAX_REPORTS by deleting the oldest.
async function enforceCap(): Promise<void> {
  const sums = await summariesAsc();
  if (sums.length <= MAX_REPORTS) return;
  for (const s of sums.slice(0, sums.length - MAX_REPORTS)) await deleteBoth(s.id);
}

// Delete the single oldest report; returns false when the store is empty.
async function evictOldest(): Promise<boolean> {
  const sums = await summariesAsc();
  const oldest = sums[0];
  if (!oldest) return false;
  await deleteBoth(oldest.id);
  return true;
}

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'QuotaExceededError';
}

export const bundleDb = {
  // Persist a bundle (full + summary), enforce the most-recent-N cap, and retry
  // on quota pressure by evicting the oldest report.
  async put(bundle: CaptureBundle): Promise<void> {
    for (let attempt = 0; attempt < MAX_REPORTS; attempt++) {
      try {
        await writeBoth(bundle);
        await enforceCap();
        return;
      } catch (err) {
        if (isQuotaError(err) && (await evictOldest())) continue; // freed space → retry
        throw err;
      }
    }
    throw new Error('Storage full — could not save the report after evicting older ones.');
  },

  get: (id: string): Promise<CaptureBundle | undefined> =>
    open().then(
      (db) =>
        new Promise<CaptureBundle | undefined>((resolve, reject) => {
          const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id) as IDBRequest<
            CaptureBundle | undefined
          >;
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error ?? new Error('get failed'));
        }),
    ),

  // Lightweight list for the dashboard/popup — never loads heavy payloads.
  summaries: (): Promise<BundleSummary[]> => getAll<BundleSummary>(SUMMARY_STORE),

  // Full bundles — only for operations that genuinely need payload content
  // (e.g. duplicate detection). Capped by MAX_REPORTS, but still heavy; avoid
  // on hot paths.
  allBundles: (): Promise<CaptureBundle[]> => getAll<CaptureBundle>(STORE),

  delete: (id: string): Promise<void> => deleteBoth(id),
};
