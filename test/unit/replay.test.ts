import { describe, it, expect } from 'vitest';
import { projectCursor, FrameGate } from '../../src/review/replay';
import type { ReplayEvent } from '../../src/shared/types';

// The player shell (mountReplay) is e2e territory; these cover the extracted
// pure logic — cursor projection math and the srcdoc-swap frame gate.

describe('review/replay — projectCursor', () => {
  it('should scale captured-viewport coordinates by the iframe/captured width ratio', () => {
    // Captured at 1280px wide, iframe renders at 640px → everything halves.
    const p = projectCursor(640, 400, 640, 1280, 10_000, 10_000);
    expect(p).toEqual({ x: 320, y: 200 });
  });

  it('should clamp the projected point inside the wrap bounds when it overshoots', () => {
    // A click near the captured right edge must not escape the 600×380 wrap.
    const p = projectCursor(1279, 950, 600, 1280, 600, 380);
    expect(p.x).toBeLessThanOrEqual(600);
    expect(p.y).toBeLessThanOrEqual(380);
    expect(p.y).toBe(380); // 950 * (600/1280) ≈ 445 → clamped to maxY
  });

  it('should clamp negative coordinates to zero when events carry out-of-view positions', () => {
    const p = projectCursor(-50, -10, 640, 1280, 600, 380);
    expect(p).toEqual({ x: 0, y: 0 });
  });

  it('should fall back to scale 1 when the captured width is zero or missing', () => {
    const p = projectCursor(100, 50, 640, 0, 10_000, 10_000);
    expect(p).toEqual({ x: 100, y: 50 });
  });

  it('should fall back to scale 1 when the iframe has not been laid out yet (width 0)', () => {
    const p = projectCursor(100, 50, 0, 1280, 10_000, 10_000);
    expect(p).toEqual({ x: 100, y: 50 });
  });
});

describe('review/replay — FrameGate', () => {
  const delta = (kind: ReplayEvent['kind'], t: number): ReplayEvent => ({ t, kind });

  it('should not defer deltas when no srcdoc swap is in flight', () => {
    const gate = new FrameGate();
    expect(gate.defer(delta('scroll', 1))).toBe(false);
  });

  it('should queue deltas during a swap and hand them back when the matching load completes', () => {
    const gate = new FrameGate();
    const token = gate.beginSwap();
    const a = delta('scroll', 1);
    const b = delta('input', 2);
    expect(gate.defer(a)).toBe(true);
    expect(gate.defer(b)).toBe(true);
    expect(gate.completeSwap(token)).toEqual([a, b]);
    // Swap finished — subsequent deltas apply directly again.
    expect(gate.defer(delta('scroll', 3))).toBe(false);
  });

  it('should return null for a superseded load when a later seek swapped frames again', () => {
    const gate = new FrameGate();
    const first = gate.beginSwap();
    gate.defer(delta('scroll', 1)); // belongs to the first (now stale) frame
    const second = gate.beginSwap();
    const fresh = delta('input', 2);
    gate.defer(fresh);
    // Out-of-order load for the first swap must be a no-op…
    expect(gate.completeSwap(first)).toBeNull();
    // …and must not have flushed or leaked the latest swap's queue.
    expect(gate.completeSwap(second)).toEqual([fresh]);
  });

  it('should drop deltas queued for a superseded frame when a new swap begins', () => {
    const gate = new FrameGate();
    gate.beginSwap();
    gate.defer(delta('scroll', 1)); // stale — targets the superseded document
    const second = gate.beginSwap();
    expect(gate.completeSwap(second)).toEqual([]);
  });

  it('should return an empty queue when a swap completes with no deltas deferred', () => {
    const gate = new FrameGate();
    const token = gate.beginSwap();
    expect(gate.completeSwap(token)).toEqual([]);
  });
});
