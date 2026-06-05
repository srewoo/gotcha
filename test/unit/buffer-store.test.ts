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

// ─── Ring eviction ───────────────────────────────────────────────────────────

describe('BufferStore — Ring eviction', () => {
  let store: BufferStore;

  beforeEach(() => {
    store = new BufferStore();
  });

  it('should evict the oldest console entry when buffer exceeds max (500)', () => {
    // Fill console ring to capacity
    for (let i = 0; i < 500; i++) {
      store.console.push(makeConsoleEntry(`c${i}`));
    }
    expect(store.console.all().length).toBe(500);
    expect(store.console.all()[0]!.id).toBe('c0');

    // Push one more — c0 should be evicted
    store.console.push(makeConsoleEntry('c500'));
    expect(store.console.all().length).toBe(500);
    expect(store.console.all()[0]!.id).toBe('c1');
    expect(store.console.all()[499]!.id).toBe('c500');
  });

  it('should evict the oldest network entry when buffer exceeds max (300)', () => {
    for (let i = 0; i < 300; i++) {
      store.network.push(makeNetworkEntry(`n${i}`));
    }
    expect(store.network.all().length).toBe(300);

    store.network.push(makeNetworkEntry('n300'));
    expect(store.network.all().length).toBe(300);
    expect(store.network.all()[0]!.id).toBe('n1');
    expect(store.network.all()[299]!.id).toBe('n300');
  });

  it('should evict the oldest step when buffer exceeds max (200)', () => {
    for (let i = 0; i < 200; i++) {
      store.steps.push(makeStep(`s${i}`));
    }
    store.steps.push(makeStep('s200'));
    expect(store.steps.all().length).toBe(200);
    expect(store.steps.all()[0]!.id).toBe('s1');
  });

  it('should evict the oldest replay event when buffer exceeds max (3000)', () => {
    for (let i = 0; i < 3000; i++) {
      store.replay.push(makeReplayEvent(i));
    }
    store.replay.push(makeReplayEvent(9999));
    expect(store.replay.all().length).toBe(3000);
    expect(store.replay.all()[0]!.y).toBe(1);
    expect(store.replay.all()[2999]!.y).toBe(9999);
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
