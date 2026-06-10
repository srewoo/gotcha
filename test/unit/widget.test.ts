/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import { CaptureWidget } from '../../src/content/widget';
import type { CaptureStatus } from '../../src/shared/messaging';

const status = (over: Partial<CaptureStatus['counts']> = {}): CaptureStatus => ({
  recording: true,
  startedAt: Date.now(),
  counts: { console: 3, errors: 1, network: 5, failed: 2, steps: 4, ...over },
});

describe('content/widget — CaptureWidget', () => {
  it('mounts a host element and is idempotent', () => {
    const w = new CaptureWidget(() => {});
    expect(w.mounted).toBe(false);
    w.mount(Date.now());
    expect(w.mounted).toBe(true);
    expect(document.getElementById('__gotcha_widget_host__')).toBeTruthy();
    w.mount(Date.now()); // second mount is a no-op
    w.unmount();
    expect(w.mounted).toBe(false);
    expect(document.getElementById('__gotcha_widget_host__')).toBeNull();
  });

  it('accepts update() before/after mount without throwing', () => {
    // The widget renders into a CLOSED shadow root, so its internals aren't
    // reachable from a unit test — interaction/visual behaviour is covered by
    // the Playwright e2e harness. Here we assert the public surface is safe.
    const w = new CaptureWidget(() => {});
    expect(() => w.update(status())).not.toThrow(); // no-op before mount
    w.mount(Date.now());
    expect(() => w.update(status({ failed: 7 }))).not.toThrow();
    w.unmount();
  });
});
