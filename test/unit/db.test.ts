import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { bundleDb, buildSummary } from '../../src/content/db';
import { makeBundle } from '../setup/factory';
import { MAX_REPORTS } from '../../src/shared/capture-config';

// Fresh IndexedDB per test (fake-indexeddb).
beforeEach(() => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

describe('content/db — buildSummary', () => {
  it('derives counts and flags', () => {
    const s = buildSummary(
      makeBundle({
        console: [
          { id: 'c1', level: 'error', message: 'e', ts: 1 },
          { id: 'c2', level: 'log', message: 'l', ts: 2 },
        ],
        network: [{ id: 'n1', url: 'x', method: 'GET', status: 500, durationMs: 1, failed: true, ts: 1 }],
        generatedTest: { filename: 'g', source: 's' },
      }),
    );
    expect(s.counts).toMatchObject({ console: 2, errors: 1, network: 1, failed: 1, steps: 0 });
    expect(s.hasTest).toBe(true);
  });
});

describe('content/db — persistence', () => {
  it('puts then gets a full bundle', async () => {
    await bundleDb.put(makeBundle({ id: 'a', title: 'A' }));
    const got = await bundleDb.get('a');
    expect(got?.title).toBe('A');
  });

  it('lists summaries (lightweight) and full bundles', async () => {
    await bundleDb.put(makeBundle({ id: 'a' }));
    await bundleDb.put(makeBundle({ id: 'b' }));
    expect((await bundleDb.summaries()).map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect((await bundleDb.allBundles())).toHaveLength(2);
  });

  it('deletes from both stores', async () => {
    await bundleDb.put(makeBundle({ id: 'a' }));
    await bundleDb.delete('a');
    expect(await bundleDb.get('a')).toBeUndefined();
    expect(await bundleDb.summaries()).toHaveLength(0);
  });

  it('returns undefined for a missing id', async () => {
    expect(await bundleDb.get('ghost')).toBeUndefined();
  });

  it('enforces the most-recent-N cap, evicting the oldest', async () => {
    for (let i = 0; i < MAX_REPORTS + 5; i++) {
      await bundleDb.put(makeBundle({ id: `r${i}`, createdAt: i }));
    }
    const sums = await bundleDb.summaries();
    expect(sums.length).toBe(MAX_REPORTS);
    // oldest (r0..r4) evicted
    expect(await bundleDb.get('r0')).toBeUndefined();
    expect(await bundleDb.get(`r${MAX_REPORTS + 4}`)).toBeDefined();
  });
});
