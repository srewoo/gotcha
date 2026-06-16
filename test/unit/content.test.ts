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

  it('should buffer a sub-frame bridge event when the worker relays frame:event', async () => {
    const before = (await onMessage({ type: 'capture:status' })).status.counts.console;
    const res = await onMessage({
      type: 'frame:event',
      payload: { marker: BRIDGE_MARKER, type: 'console', entry: { id: 'fc1', level: 'log', message: 'from sub-frame', ts: 2 } },
    });
    expect(res).toEqual({ ok: true });
    const after = (await onMessage({ type: 'capture:status' })).status.counts.console;
    expect(after).toBe(before + 1);
  });

  it('should not buffer a frame:event whose payload is not a bridge message', async () => {
    const before = (await onMessage({ type: 'capture:status' })).status.counts;
    const res = await onMessage({ type: 'frame:event', payload: { type: 'console', entry: { id: 'x' } } });
    expect(res).toEqual({ ok: true });
    const after = (await onMessage({ type: 'capture:status' })).status.counts;
    expect(after).toEqual(before);
  });

  it('should ignore a forged window message using the old frame-forward marker', async () => {
    const before = (await onMessage({ type: 'capture:status' })).status.counts;
    // A third-party iframe (or the host page) posting the legacy relay shape
    // must no longer poison the buffers — the window relay is gone.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          marker: '__gotcha_frame_fwd__',
          payload: { marker: BRIDGE_MARKER, type: 'console', entry: { id: 'evil', level: 'error', message: 'forged', ts: 3 } },
        },
        source: window as unknown as Window,
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    const after = (await onMessage({ type: 'capture:status' })).status.counts;
    expect(after).toEqual(before);
  });

  it('should not mutate the live buffer event when enrichment patches the seed snapshot', async () => {
    // Fresh session so finishCapture packages the live buffers directly (the
    // path that previously wrote enriched HTML through to the ring's object).
    await onMessage({ type: 'capture:start' });
    const liveEvent = { t: 0, kind: 'snapshot', html: '<html><head></head><body>y</body></html>' };
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { marker: BRIDGE_MARKER, type: 'replay', event: liveEvent },
        source: window as unknown as Window,
      }),
    );
    await new Promise((r) => setTimeout(r, 5));

    // One unreadable cross-origin stylesheet so enrichment has work to do.
    Object.defineProperty(document, 'styleSheets', {
      configurable: true,
      get: () => [
        {
          href: 'https://cdn.example.com/x.css',
          get cssRules(): never {
            throw new Error('CORS');
          },
        },
      ],
    });

    let savedBundle: any;
    (chromeApi.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation((m: any) => {
      if (m.type === 'css:fetch') {
        return Promise.resolve({ type: 'css:fetched', ok: true, css: { 'https://cdn.example.com/x.css': '.a{color:red}' } });
      }
      savedBundle = m.bundle;
      return Promise.resolve({ type: 'bundle:saved', ok: true, reviewUrl: 'chrome-extension://x/review.html?id=m' });
    });

    const res = await onMessage({ type: 'capture:finish' });
    expect(res.ok).toBe(true);
    // The saved bundle's seed carries the injected style…
    const seed = savedBundle.replay.find((e: any) => e.kind === 'snapshot');
    expect(seed.html).toContain('data-gotcha-xorigin');
    // …but the object that was owned by the live ring is untouched.
    expect(liveEvent.html).toBe('<html><head></head><body>y</body></html>');

    Object.defineProperty(document, 'styleSheets', { configurable: true, get: () => [] });
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
