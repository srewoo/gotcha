import { describe, it, expect, beforeEach } from 'vitest';
import { BufferStore } from '../../src/content/buffer-store';
import type { ConsoleEntry, NetworkEntry, ReproStep, ReplayEvent } from '../../src/shared/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConsoleEntry(id: string, level: ConsoleEntry['level'] = 'log'): ConsoleEntry {
  return { id, level, message: `Message ${id}`, ts: Date.now() };
}

function makeNetworkEntry(id: string, failed = false): NetworkEntry {
  return {
    id,
    url: `https://example.com/${id}`,
    method: 'GET',
    status: failed ? 500 : 200,
    durationMs: 100,
    failed,
    ts: Date.now(),
  };
}

function makeStep(id: string): ReproStep {
  return { id, kind: 'click', label: `Step ${id}`, ts: Date.now() };
}

function makeReplayEvent(t: number): ReplayEvent {
  return { t, kind: 'scroll', x: 0, y: t };
}

function makeSnapshot(t: number, html = `<html data-t="${t}"></html>`): ReplayEvent {
  return { t, kind: 'snapshot', html };
}

function consoleAt(id: string, ts: number): ConsoleEntry {
  return { id, level: 'log', message: `Message ${id}`, ts };
}

// ─── Ring eviction ───────────────────────────────────────────────────────────

describe('BufferStore — Ring eviction', () => {
  let store: BufferStore;

  beforeEach(() => {
    store = new BufferStore();
  });

  it('should evict the oldest console entry when buffer exceeds max (2000)', () => {
    // Fill console ring to capacity
    for (let i = 0; i < 2000; i++) {
      store.console.push(makeConsoleEntry(`c${i}`));
    }
    expect(store.console.all().length).toBe(2000);
    expect(store.console.all()[0]!.id).toBe('c0');

    // Push one more — c0 should be evicted
    store.console.push(makeConsoleEntry('c2000'));
    expect(store.console.all().length).toBe(2000);
    expect(store.console.all()[0]!.id).toBe('c1');
    expect(store.console.all()[1999]!.id).toBe('c2000');
  });

  it('should evict the oldest network entry when buffer exceeds max (1000)', () => {
    for (let i = 0; i < 1000; i++) {
      store.network.push(makeNetworkEntry(`n${i}`));
    }
    expect(store.network.all().length).toBe(1000);

    store.network.push(makeNetworkEntry('n1000'));
    expect(store.network.all().length).toBe(1000);
    expect(store.network.all()[0]!.id).toBe('n1');
    expect(store.network.all()[999]!.id).toBe('n1000');
  });

  it('should evict the oldest step when buffer exceeds max (400)', () => {
    for (let i = 0; i < 400; i++) {
      store.steps.push(makeStep(`s${i}`));
    }
    store.steps.push(makeStep('s400'));
    expect(store.steps.all().length).toBe(400);
    expect(store.steps.all()[0]!.id).toBe('s1');
  });

  it('should evict the oldest replay event when buffer exceeds max (5000)', () => {
    for (let i = 0; i < 5000; i++) {
      store.replay.push(makeReplayEvent(i));
    }
    store.replay.push(makeReplayEvent(99999));
    expect(store.replay.all().length).toBe(5000);
    expect(store.replay.all()[0]!.y).toBe(1);
    expect(store.replay.all()[4999]!.y).toBe(99999);
  });

  it('should maintain insertion order up to capacity', () => {
    store.console.push(makeConsoleEntry('first'));
    store.console.push(makeConsoleEntry('second'));
    store.console.push(makeConsoleEntry('third'));
    const all = store.console.all();
    expect(all[0]!.id).toBe('first');
    expect(all[1]!.id).toBe('second');
    expect(all[2]!.id).toBe('third');
  });
});

// ─── reset() ─────────────────────────────────────────────────────────────────

describe('BufferStore — reset()', () => {
  let store: BufferStore;

  beforeEach(() => {
    store = new BufferStore();
    store.start();
    store.console.push(makeConsoleEntry('c1'));
    store.network.push(makeNetworkEntry('n1'));
    store.steps.push(makeStep('s1'));
    store.replay.push(makeReplayEvent(100));
  });

  it('should clear all console entries', () => {
    store.reset();
    expect(store.console.all().length).toBe(0);
  });

  it('should clear all network entries', () => {
    store.reset();
    expect(store.network.all().length).toBe(0);
  });

  it('should clear all step entries', () => {
    store.reset();
    expect(store.steps.all().length).toBe(0);
  });

  it('should clear all replay events', () => {
    store.reset();
    expect(store.replay.all().length).toBe(0);
  });

  it('should set recording to false', () => {
    store.reset();
    expect(store.recording).toBe(false);
  });

  it('should set startedAt to null', () => {
    store.reset();
    expect(store.startedAt).toBeNull();
  });
});

// ─── status() ─────────────────────────────────────────────────────────────────

describe('BufferStore — status()', () => {
  let store: BufferStore;

  beforeEach(() => {
    store = new BufferStore();
  });

  it('should return correct counts for mixed console entries', () => {
    store.console.push(makeConsoleEntry('c1', 'log'));
    store.console.push(makeConsoleEntry('c2', 'error'));
    store.console.push(makeConsoleEntry('c3', 'error'));
    store.console.push(makeConsoleEntry('c4', 'warn'));

    const status = store.status();
    expect(status.counts.console).toBe(4);
    expect(status.counts.errors).toBe(2);
  });

  it('should return correct failed network count', () => {
    store.network.push(makeNetworkEntry('n1', false));
    store.network.push(makeNetworkEntry('n2', true));
    store.network.push(makeNetworkEntry('n3', true));

    const status = store.status();
    expect(status.counts.network).toBe(3);
    expect(status.counts.failed).toBe(2);
  });

  it('should return correct steps count', () => {
    store.steps.push(makeStep('s1'));
    store.steps.push(makeStep('s2'));

    const status = store.status();
    expect(status.counts.steps).toBe(2);
  });

  it('should reflect recording state', () => {
    expect(store.status().recording).toBe(false);
    store.start();
    expect(store.status().recording).toBe(true);
    store.stop();
    expect(store.status().recording).toBe(false);
  });

  it('should reflect startedAt after start()', () => {
    const before = Date.now();
    store.start();
    const after = Date.now();
    const status = store.status();
    expect(status.startedAt).not.toBeNull();
    expect(status.startedAt!).toBeGreaterThanOrEqual(before);
    expect(status.startedAt!).toBeLessThanOrEqual(after);
  });

  it('should return zero counts for empty store', () => {
    const status = store.status();
    expect(status.counts.console).toBe(0);
    expect(status.counts.errors).toBe(0);
    expect(status.counts.network).toBe(0);
    expect(status.counts.failed).toBe(0);
    expect(status.counts.steps).toBe(0);
  });
});

// ─── packager network dedupe (issue #4) ───────────────────────────────────────
import { packageBundle } from '../../src/content/packager';
import { BufferStore } from '../../src/content/buffer-store';

describe('packageBundle — network dedupe by id', () => {
  it('should keep the last entry when ids collide (WS open then close)', () => {
    const b = new BufferStore();
    b.network.push({ id: 'ws1', url: 'wss://x', method: 'GET', status: 101, durationMs: 1, failed: false, ts: 1 } as any);
    b.network.push({ id: 'ws1', url: 'wss://x', method: 'GET', status: 1000, durationMs: 5, failed: false, ts: 2, frames: [{ dir: 'recv', data: 'hi', ts: 2 }] } as any);
    const pkg = packageBundle(b);
    const ws = pkg.network.filter((n) => n.id === 'ws1');
    expect(ws).toHaveLength(1);
    expect(ws[0]!.status).toBe(1000);
  });
});

// ─── Age-based retention (Instant Replay) ──────────────────────────────────────

describe('BufferStore — age-based retention', () => {
  it('should not evict by age until enableRetention is called', () => {
    const store = new BufferStore();
    const now = Date.now();
    store.console.push(consoleAt('old', now - 10 * 60_000)); // 10 min ago
    store.console.push(consoleAt('new', now));
    // No retention configured → count-cap only, both survive.
    expect(store.console.all().map((c) => c.id)).toEqual(['old', 'new']);
  });

  it('should drop console entries older than the retention window', () => {
    const store = new BufferStore();
    store.enableRetention(120_000); // 2 min
    const now = Date.now();
    store.console.push(consoleAt('stale', now - 5 * 60_000)); // outside window
    store.console.push(consoleAt('fresh', now)); // newest → resets the cutoff
    const ids = store.console.all().map((c) => c.id);
    expect(ids).toContain('fresh');
    expect(ids).not.toContain('stale');
  });

  it('should keep the newest snapshot before the cutoff as a seed anchor', () => {
    const store = new BufferStore();
    store.enableRetention(120_000);
    // Replay timeline is relative; eviction is relative to the newest item.
    store.replay.push(makeSnapshot(0)); // old keyframe (the anchor)
    store.replay.push(makeReplayEvent(1_000)); // old scroll (should be dropped)
    store.replay.push(makeReplayEvent(200_000)); // newest → cutoff = 80_000
    const kinds = store.replay.all();
    // The pre-cutoff snapshot is retained; the pre-cutoff scroll is not.
    expect(kinds.some((e) => e.kind === 'snapshot' && e.t === 0)).toBe(true);
    expect(kinds.some((e) => e.kind === 'scroll' && e.t === 1_000)).toBe(false);
    expect(kinds.some((e) => e.t === 200_000)).toBe(true);
  });
});

// ─── sliceWindow ────────────────────────────────────────────────────────────

describe('BufferStore — sliceWindow', () => {
  it('should include only console entries within the trailing window', () => {
    const store = new BufferStore();
    const now = Date.now();
    store.console.push(consoleAt('old', now - 90_000)); // outside 60s window
    store.console.push(consoleAt('recent', now - 10_000)); // inside
    const sliced = store.sliceWindow(60_000);
    const ids = sliced.console.all().map((c) => c.id);
    expect(ids).toEqual(['recent']);
  });

  it('should re-base the replay timeline to start at 0 from a seed snapshot', () => {
    const store = new BufferStore();
    // Simulate an always-on recorder whose epoch began 100s ago.
    store.replayEpoch = Date.now() - 100_000;
    store.replay.push(makeSnapshot(40_000)); // keyframe before the window start
    store.replay.push(makeReplayEvent(50_000));
    store.replay.push(makeReplayEvent(95_000));
    // Window start (relative) ≈ 100_000 - 60_000 = 40_000 → seed = the 40k snapshot.
    const sliced = store.sliceWindow(60_000);
    const evs = sliced.replay.all();
    expect(evs.length).toBeGreaterThan(0);
    expect(evs[0]!.kind).toBe('snapshot');
    expect(evs[0]!.t).toBe(0); // seed re-based to 0
    // Subsequent events are re-based against the seed (40k), staying ascending.
    expect(evs[1]!.t).toBe(10_000);
    expect(evs[2]!.t).toBe(55_000);
  });

  it('should yield an empty replay when nothing was recorded', () => {
    const store = new BufferStore();
    store.console.push(consoleAt('c', Date.now()));
    const sliced = store.sliceWindow(60_000);
    expect(sliced.replay.all()).toHaveLength(0);
    expect(sliced.console.all()).toHaveLength(1);
  });
});

// ─── Pinned initial snapshot (long-session styling) ───────────────────────────

describe('BufferStore — pinned initial snapshot', () => {
  it('should keep the initial snapshot at the front after the ring overflows', () => {
    const store = new BufferStore();
    store.pushReplay(makeSnapshot(0, '<html data-initial></html>')); // initial styled frame
    // Flood far past the 5000-event replay cap with mutations.
    for (let i = 1; i <= 6000; i++) {
      store.pushReplay({ t: i, kind: 'mutation', html: `<body>${i}</body>` });
    }
    const all = store.replay.all();
    // The initial snapshot survived and is still the seed at the front…
    expect(all[0]!.kind).toBe('snapshot');
    expect(all[0]!.html).toContain('data-initial');
    // …while the ring itself stayed bounded: pinned head (1) + capped items (5000).
    expect(all.length).toBe(5001);
  });

  it('should update the pin to the enriched snapshot emitted at the same t', () => {
    const store = new BufferStore();
    store.pushReplay(makeSnapshot(0, '<html data-readable></html>')); // readable-only
    store.pushReplay(makeSnapshot(0, '<html data-enriched></html>')); // enriched, same t
    store.pushReplay({ t: 500, kind: 'mutation', html: '<body>x</body>' });
    const all = store.replay.all();
    // Front is the enriched snapshot, present exactly once (no duplicate t=0).
    expect(all[0]!.html).toContain('data-enriched');
    expect(all.filter((e) => e.kind === 'snapshot').length).toBe(1);
  });

  it('should not pin later keyframes (t > initial)', () => {
    const store = new BufferStore();
    store.pushReplay(makeSnapshot(0, '<html data-initial></html>'));
    store.pushReplay(makeSnapshot(30_000, '<html data-keyframe></html>')); // a later keyframe
    const all = store.replay.all();
    expect(all[0]!.html).toContain('data-initial'); // initial stays pinned at front
    expect(all.some((e) => e.kind === 'snapshot' && e.html?.includes('data-keyframe'))).toBe(true);
  });

  it('should drop the pin on reset', () => {
    const store = new BufferStore();
    store.pushReplay(makeSnapshot(0));
    store.reset();
    expect(store.replay.all()).toHaveLength(0);
  });
});
