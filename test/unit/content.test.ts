/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { chromeApi } from '../setup/chrome-mock';
import { BRIDGE_MARKER } from '../../src/shared/messaging';

// The content script registers a chrome.runtime.onMessage listener at import
// and wires a window 'message' listener for bridge events. Import once.
beforeAll(async () => {
  await import('../../src/content/content');
});

function onMessage(message: unknown): Promise<any> {
  return new Promise((resolve) => {
    const listener = chromeApi.runtime.onMessage._listeners[0]!;
    listener(message, {}, resolve);
  });
}

describe('content script — capture lifecycle messaging', () => {
  it('reports status', async () => {
    const res = await onMessage({ type: 'capture:status' });
    expect(res.ok).toBe(true);
    expect(res.status).toMatchObject({ recording: expect.any(Boolean) });
  });

  it('starts and stops a recording session', async () => {
    const start = await onMessage({ type: 'capture:start' });
    expect(start.ok).toBe(true);
    expect(start.status.recording).toBe(true);
    const stop = await onMessage({ type: 'capture:stop' });
    expect(stop.ok).toBe(true);
    expect(stop.status.recording).toBe(false);
  });

  it('buffers bridge events posted from the MAIN world', async () => {
    // The content script only buffers messages whose source IS this window
    // (same-frame MAIN-world hooks), so dispatch a MessageEvent with source set.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { marker: BRIDGE_MARKER, type: 'console', entry: { id: 'c1', level: 'error', message: 'boom', ts: 1 } },
        source: window as unknown as Window,
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    const res = await onMessage({ type: 'capture:status' });
    expect(res.status.counts.console).toBeGreaterThanOrEqual(1);
  });

  it('buffers network, step and replay bridge events', async () => {
    const fire = (payload: unknown) =>
      window.dispatchEvent(new MessageEvent('message', { data: payload, source: window as unknown as Window }));
    fire({ marker: BRIDGE_MARKER, type: 'network', entry: { id: 'n1', url: 'https://a/x', method: 'GET', status: 500, durationMs: 1, failed: true, ts: 1 } });
    fire({ marker: BRIDGE_MARKER, type: 'step', step: { id: 'st1', kind: 'click', label: 'Go', ts: 1 } });
    fire({ marker: BRIDGE_MARKER, type: 'replay', event: { t: 0, kind: 'snapshot', html: '<html></html>' } });
    await new Promise((r) => setTimeout(r, 5));
    const res = await onMessage({ type: 'capture:status' });
    expect(res.status.counts.network).toBeGreaterThanOrEqual(1);
    expect(res.status.counts.failed).toBeGreaterThanOrEqual(1);
    expect(res.status.counts.steps).toBeGreaterThanOrEqual(1);
  });

  it('rejects an unknown message type', async () => {
    const res = await onMessage({ type: 'bogus' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Unhandled message in content');
  });

  it('finishes a capture, packaging + handing the bundle to the worker', async () => {
    // Worker save responds with a review URL.
    (chromeApi.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      type: 'bundle:saved',
      ok: true,
      reviewUrl: 'chrome-extension://x/review.html?id=z',
    });
    const res = await onMessage({ type: 'capture:finish' });
    expect(res.ok).toBe(true);
    expect(res.reviewUrl).toContain('review.html');
  });

  it('surfaces a worker save failure on finish', async () => {
    (chromeApi.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: 'disk full',
    });
    const res = await onMessage({ type: 'capture:finish' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('disk full');
  });

  it('shares the last minute, enriching cross-origin CSS via the worker', async () => {
    // Seed a replay snapshot so enrichCrossOriginCss has a seed to patch.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          marker: BRIDGE_MARKER,
          type: 'replay',
          event: { t: 0, kind: 'snapshot', html: '<html><head></head><body>x</body></html>' },
        },
        source: window as unknown as Window,
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    (chromeApi.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation((m: { type: string }) => {
      if (m.type === 'css:fetch') return Promise.resolve({ type: 'css:fetched', ok: true, css: {} });
      return Promise.resolve({ type: 'bundle:saved', ok: true, reviewUrl: 'chrome-extension://x/review.html?id=s' });
    });
    const res = await onMessage({ type: 'capture:shareLastMinute' });
    expect(res.ok).toBe(true);
    expect(res.reviewUrl).toContain('review.html');
  });
});
