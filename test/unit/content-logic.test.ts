/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import { post } from '../../src/injected/bridge';
import { BRIDGE_MARKER } from '../../src/shared/messaging';
import { packageBundle } from '../../src/content/packager';
import { captureEnvironment } from '../../src/content/environment';
import { BufferStore } from '../../src/content/buffer-store';

describe('injected/bridge — post', () => {
  it('posts the message via window.postMessage with the page origin', () => {
    const spy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    post({ marker: BRIDGE_MARKER, type: 'console', entry: { id: 'c1', level: 'log', message: 'x', ts: 1 } });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('never throws even if postMessage fails', () => {
    const spy = vi.spyOn(window, 'postMessage').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() =>
      post({ marker: BRIDGE_MARKER, type: 'console', entry: { id: 'c1', level: 'log', message: 'x', ts: 1 } }),
    ).not.toThrow();
    spy.mockRestore();
  });
});

describe('content/environment — captureEnvironment', () => {
  it('captures url, viewport, dpr, locale and parses the UA', () => {
    const env = captureEnvironment();
    expect(env.url).toBe(location.href);
    expect(env.viewport.width).toBe(window.innerWidth);
    expect(typeof env.browser).toBe('string');
    expect(typeof env.os).toBe('string');
    expect(env.capturedAt).toBeGreaterThan(0);
  });

  it('parses Chrome on macOS from a known UA string', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
    const env = captureEnvironment();
    expect(env.browser).toBe('Chrome 120');
    expect(env.os).toContain('macOS');
    vi.restoreAllMocks();
  });

  it('parses browser + OS across the UA matrix', () => {
    const cases: Array<[string, string, string]> = [
      ['Mozilla/5.0 (Windows NT 10.0) Edg/121.0', 'Edge 121', 'Windows 10/11'],
      ['Mozilla/5.0 (X11; Linux x86_64) Firefox/118.0', 'Firefox 118', 'Linux'],
      ['Mozilla/5.0 (Linux; Android 13) Chrome/119.0.0.0', 'Chrome 119', 'Android'],
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1', 'Safari 604', 'iOS'],
      ['totally-unknown-agent', 'Unknown', 'Unknown'],
    ];
    for (const [ua, browser, os] of cases) {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
      const env = captureEnvironment();
      expect(env.browser).toBe(browser);
      expect(env.os).toBe(os);
      vi.restoreAllMocks();
    }
  });
});

describe('content/packager — packageBundle', () => {
  it('derives the title from the first failed request', () => {
    const buffers = new BufferStore();
    buffers.network.push({ id: 'n1', url: 'https://a.com/api/save', method: 'POST', status: 500, durationMs: 3, failed: true, ts: 1 });
    const bundle = packageBundle(buffers);
    expect(bundle.title).toBe('500 on POST /api/save');
    expect(bundle.redacted).toBe(false);
    expect(bundle.id).toBeTruthy();
  });

  it('falls back to the first console error, then the URL', () => {
    const b1 = new BufferStore();
    b1.console.push({ id: 'c1', level: 'error', message: 'TypeError: x is null', ts: 1 });
    expect(packageBundle(b1).title).toBe('TypeError: x is null');

    const b2 = new BufferStore();
    expect(packageBundle(b2).title).toContain('Issue on');
  });

  it('dedupes network entries by id, keeping the last (close supersedes open)', () => {
    const buffers = new BufferStore();
    buffers.network.push({ id: 'ws1', url: 'wss://a', method: 'GET', status: 101, durationMs: 0, failed: false, ts: 1, transport: 'websocket' });
    buffers.network.push({ id: 'ws1', url: 'wss://a', method: 'GET', status: 1000, durationMs: 9, failed: false, ts: 2, transport: 'websocket', frames: [{ dir: 'recv', data: 'hi', ts: 2 }] });
    const bundle = packageBundle(buffers);
    const ws = bundle.network.filter((n) => n.id === 'ws1');
    expect(ws).toHaveLength(1);
    expect(ws[0]!.status).toBe(1000);
    expect(ws[0]!.frames).toHaveLength(1);
  });
});
