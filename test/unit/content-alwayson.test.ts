/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { chromeApi, storageLocal } from '../setup/chrome-mock';
import { CONTROL_MARKER } from '../../src/shared/messaging';

let controls: string[] = [];
function onMessage(message: unknown): Promise<any> {
  return new Promise((resolve) => {
    chromeApi.runtime.onMessage._listeners[0]!(message, {}, resolve);
  });
}

beforeAll(async () => {
  // Configure always-on Instant Replay + deny-list BEFORE the content script
  // imports, so its settings-load branch runs the always-on path.
  storageLocal.set({ instantReplay: true, captureUserEvents: false, captureDenyDomains: 'evil.com' });
  vi.spyOn(window, 'postMessage').mockImplementation((msg: unknown) => {
    const m = msg as { marker?: string; action?: string };
    if (m.marker === CONTROL_MARKER && m.action) controls.push(m.action);
  });
  await import('../../src/content/content');
  await new Promise((r) => setTimeout(r, 10)); // let the async storage.get resolve
});

describe('content script — always-on Instant Replay init', () => {
  it('starts the always-on replay recorder when instantReplay is enabled', () => {
    expect(controls).toContain('replay-always-on');
  });

  it('mounts the widget on capture:start and rearms always-on after stop', async () => {
    const start = await onMessage({ type: 'capture:start' });
    expect(start.ok).toBe(true);
    expect(controls).toContain('replay-on'); // fresh session recorder
    const stop = await onMessage({ type: 'capture:stop' });
    expect(stop.ok).toBe(true);
    // After abandoning a session, always-on Instant Replay is re-armed.
    expect(controls.filter((c) => c === 'replay-always-on').length).toBeGreaterThanOrEqual(2);
  });

  it('retroactive one-click finish slices the retained window (always-on path)', async () => {
    (chromeApi.runtime.sendMessage as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
      type: 'bundle:saved',
      ok: true,
      reviewUrl: 'chrome-extension://x/review.html?id=r',
    });
    const res = await onMessage({ type: 'capture:finish' });
    expect(res.ok).toBe(true);
    expect(res.reviewUrl).toContain('review.html');
  });
});
