/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { BRIDGE_MARKER } from '../../src/shared/messaging';

// ── Fake socket base classes (happy-dom has no WebSocket/EventSource) ────────
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  _l: Record<string, Array<(ev: unknown) => void>> = {};
  constructor(
    public url: string,
    public protocols?: unknown,
  ) {}
  addEventListener(t: string, fn: (ev: unknown) => void): void {
    (this._l[t] ||= []).push(fn);
  }
  removeEventListener(): void {}
  send(): void {}
  close(): void {}
  _fire(t: string, ev: unknown): void {
    (this._l[t] ?? []).forEach((f) => f(ev));
  }
}

let posted: Array<{ marker?: string; type?: string; entry?: any }> = [];
const beaconImpl = vi.fn((_url: string, _data?: unknown) => true);
const fetchImpl = vi.fn(
  async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
);

beforeAll(async () => {
  (globalThis as any).WebSocket = class extends FakeSocket {};
  (globalThis as any).EventSource = class extends FakeSocket {};
  // navigator.sendBeacon (happy-dom may not provide it) — a mock so tests can
  // drive success / failure / throw return paths.
  Object.defineProperty(navigator, 'sendBeacon', {
    value: beaconImpl,
    configurable: true,
    writable: true,
  });
  // window.fetch returns a real happy-dom Response we can clone()/text();
  // a named mock so tests can drive error / oversized-body paths.
  (window as any).fetch = fetchImpl;

  vi.spyOn(window, 'postMessage').mockImplementation((msg: unknown) => {
    posted.push(msg as { marker?: string });
  });

  const { installErrorHook } = await import('../../src/injected/error-hook');
  const { installBeaconHook } = await import('../../src/injected/beacon-hook');
  const { installNetworkHook } = await import('../../src/injected/network-hook');
  const { installWebSocketHook } = await import('../../src/injected/websocket-hook');
  const { installEventSourceHook } = await import('../../src/injected/eventsource-hook');
  const { installWorkerHook } = await import('../../src/injected/worker-hook');
  installErrorHook();
  installBeaconHook();
  installNetworkHook();
  installWebSocketHook();
  installEventSourceHook();
  installWorkerHook(); // disabled-by-default: just exercises the safety return
});

beforeEach(() => {
  posted = [];
});

const bridge = () => posted.filter((m) => m.marker === BRIDGE_MARKER);
const ofType = (t: string) => bridge().filter((m) => m.type === t);

describe('error-hook', () => {
  it('captures uncaught errors', () => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', error: new Error('boom') }));
    const e = ofType('console').map((m) => m.entry);
    expect(e.some((x) => x.message === 'boom' && x.level === 'error')).toBe(true);
  });

  it('captures unhandled rejections', () => {
    const ev = new Event('unhandledrejection') as Event & { reason?: unknown };
    (ev as any).reason = new Error('nope');
    window.dispatchEvent(ev);
    expect(ofType('console').some((m) => m.entry.message.includes('Unhandled rejection: nope'))).toBe(true);
  });
});

describe('beacon-hook', () => {
  it('records a sendBeacon call as a network entry', () => {
    navigator.sendBeacon('https://a/track', 'payload');
    const n = ofType('network').map((m) => m.entry);
    const hit = n.find((x) => x.url === 'https://a/track' && x.transport === 'beacon');
    expect(hit).toBeTruthy();
    expect(hit.failed).toBe(false);
    expect(hit.requestBody).toBe('payload');
  });

  it('serializes URLSearchParams / FormData / Blob / ArrayBuffer bodies', () => {
    navigator.sendBeacon('https://a/u', new URLSearchParams({ a: '1' }));
    const fd = new FormData();
    fd.append('k', 'v');
    navigator.sendBeacon('https://a/f', fd);
    navigator.sendBeacon('https://a/b', new Blob(['x'], { type: 'text/plain' }));
    navigator.sendBeacon('https://a/ab', new ArrayBuffer(8));
    const bodies = ofType('network').map((m) => m.entry.requestBody as string);
    expect(bodies).toEqual(expect.arrayContaining([expect.stringContaining('a=1')]));
    expect(bodies.some((b) => b?.includes('k=v'))).toBe(true);
    expect(bodies.some((b) => b?.includes('[Blob'))).toBe(true);
    expect(bodies.some((b) => b?.includes('[ArrayBuffer'))).toBe(true);
  });

  it('marks the entry failed when sendBeacon returns false', () => {
    beaconImpl.mockReturnValueOnce(false);
    navigator.sendBeacon('https://a/queuefull', 'x');
    const hit = ofType('network').map((m) => m.entry).find((x) => x.url === 'https://a/queuefull');
    expect(hit.failed).toBe(true);
  });

  it('records a failed entry and re-throws when sendBeacon throws', () => {
    beaconImpl.mockImplementationOnce(() => {
      throw new Error('beacon boom');
    });
    expect(() => navigator.sendBeacon('https://a/throw', 'x')).toThrow('beacon boom');
    const hit = ofType('network').map((m) => m.entry).find((x) => x.url === 'https://a/throw');
    expect(hit.failed).toBe(true);
    expect(hit.statusText).toContain('beacon boom');
  });
});

describe('network-hook (fetch)', () => {
  it('records a fetch as a network entry with status + body', async () => {
    await window.fetch('https://api/data', { method: 'POST', body: 'q=1' });
    const n = ofType('network').map((m) => m.entry);
    const hit = n.find((x) => x.url === 'https://api/data');
    expect(hit).toBeTruthy();
    expect(hit.method).toBe('POST');
    expect(hit.status).toBe(200);
    expect(hit.failed).toBe(false);
  });

  it('records a failed entry (status 0) when fetch rejects', async () => {
    fetchImpl.mockRejectedValueOnce(new Error('network down'));
    await expect(window.fetch('https://api/err')).rejects.toThrow('network down');
    const hit = ofType('network').map((m) => m.entry).find((x) => x.url === 'https://api/err');
    expect(hit).toBeTruthy();
    expect(hit.status).toBe(0);
    expect(hit.failed).toBe(true);
    expect(hit.statusText).toContain('network down');
  });

  it('omits an oversized response body by content-length', async () => {
    fetchImpl.mockResolvedValueOnce(
      new Response('x', { status: 200, headers: { 'content-length': '5000000' } }),
    );
    await window.fetch('https://api/big');
    const hit = ofType('network').map((m) => m.entry).find((x) => x.url === 'https://api/big');
    expect(hit.responseBody).toContain('body omitted');
  });
});

describe('websocket-hook', () => {
  it('emits open then a failed close carrying the code/reason', () => {
    const ws = new (window as any).WebSocket('wss://a/socket');
    ws._fire('open', {});
    ws.send('hello'); // recorded as a send frame
    ws._fire('message', { data: 'hi back' });
    ws._fire('error', {});
    ws._fire('close', { wasClean: false, code: 1006, reason: 'gone' });
    const entries = ofType('network').map((m) => m.entry).filter((e) => e.transport === 'websocket');
    // error fires first (no detail), then close with the code — packager dedupes
    // by id keeping the last, so assert on the final failed entry.
    const closed = entries.filter((e) => e.failed).pop();
    expect(closed).toBeTruthy();
    expect(closed.statusText).toContain('1006');
    expect(closed.frames.length).toBeGreaterThanOrEqual(2); // send + recv
  });

  it('emits open then a clean close (wasClean) as not-failed', () => {
    const ws = new (window as any).WebSocket('wss://a/ok');
    ws._fire('open', {});
    ws._fire('close', { wasClean: true, code: 1000, reason: '' });
    const entries = ofType('network').map((m) => m.entry).filter((e) => e.transport === 'websocket' && e.url === 'wss://a/ok');
    const last = entries.pop();
    expect(last.failed).toBe(false);
    expect(last.statusText).toBe('Connection closed');
  });
});

describe('eventsource-hook', () => {
  it('emits an open entry when the SSE stream opens', () => {
    const es = new (window as any).EventSource('https://a/stream');
    es._fire('open', {});
    const entries = ofType('network').map((m) => m.entry).filter((e) => e.transport === 'eventsource');
    expect(entries.some((e) => e.statusText === 'SSE stream opened')).toBe(true);
  });

  it('records message frames and emits a failed entry on error', () => {
    const es = new (window as any).EventSource('https://a/stream2');
    es._fire('open', {});
    es._fire('message', { data: 'tick' });
    es.readyState = (globalThis as any).EventSource.CLOSED; // permanent close
    es._fire('error', {});
    const entries = ofType('network').map((m) => m.entry).filter((e) => e.transport === 'eventsource');
    const failed = entries.filter((e) => e.failed).pop();
    expect(failed).toBeTruthy();
    expect(failed.frames.length).toBeGreaterThanOrEqual(1);
  });
});

describe('network-hook (XHR)', () => {
  it('records an XHR as a network entry when loadend fires', () => {
    const xhr = new XMLHttpRequest();
    // The hook attaches its loadend listener inside the patched send(), so even
    // if the (server-less) send throws, the listener is wired; we then fire
    // loadend ourselves to exercise the emit path deterministically.
    try {
      xhr.open('POST', 'https://api/xhr-call');
    } catch {
      /* ignore */
    }
    try {
      xhr.send('request-body');
      xhr.abort(); // cancel the pending (server-less) request so teardown is clean
    } catch {
      /* server-less env */
    }
    xhr.dispatchEvent(new Event('loadend'));
    const hit = ofType('network').map((m) => m.entry).find((x) => x.url === 'https://api/xhr-call');
    expect(hit).toBeTruthy();
    expect(hit.method).toBe('POST');
    expect(hit.requestBody).toBe('request-body');
  });
});
