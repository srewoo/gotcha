/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

// ── Fake streaming Response (happy-dom Response lacks a reliable streaming
// surface) — minimal clone()/body.getReader() shape the reader-based capture
// needs, with controllable chunks, an optional never-ending tail, and a
// cancellation probe. ─────────────────────────────────────────────────────────
function streamingResponse(
  chunks: Array<string | Uint8Array>,
  opts: { endless?: boolean; headers?: Record<string, string> } = {},
) {
  const enc = new TextEncoder();
  const bin = chunks.map((c) => (typeof c === 'string' ? enc.encode(c) : c));
  let i = 0;
  let cancelled = false;
  let pending: ((r: { done: boolean; value?: Uint8Array }) => void) | null = null;
  const reader = {
    read(): Promise<{ done: boolean; value?: Uint8Array }> {
      if (cancelled) return Promise.resolve({ done: true });
      if (i < bin.length) return Promise.resolve({ done: false, value: bin[i++] });
      if (!opts.endless) return Promise.resolve({ done: true });
      // Stream stays open: park the read until cancel() resolves it.
      return new Promise((res) => {
        pending = res;
      });
    },
    cancel(): Promise<void> {
      cancelled = true;
      pending?.({ done: true });
      pending = null;
      return Promise.resolve();
    },
  };
  const resp = {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(opts.headers ?? {}),
    clone() {
      return this;
    },
    body: { getReader: () => reader },
  };
  return { resp: resp as unknown as Response, wasCancelled: () => cancelled };
}

let posted: Array<{ marker?: string; type?: string; entry?: any; step?: any }> = [];
const beaconImpl = vi.fn((_url: string, _data?: unknown) => true);
let origXhrOpen: typeof XMLHttpRequest.prototype.open;
let origXhrSend: typeof XMLHttpRequest.prototype.send;
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
  // a named mock so tests can drive error / oversized-body / streaming paths.
  (window as any).fetch = fetchImpl;

  // happy-dom's native XHR open/send would attempt REAL network requests to the
  // test URLs (ENOTFOUND noise + non-hermetic tests). The XHR hook captures
  // proto.open/proto.send at install time and calls them, so stub them to
  // no-ops here — the wrapper (loadend listener, body serialization) is still
  // exercised; the synthetic events the tests dispatch drive the emit path.
  origXhrOpen = XMLHttpRequest.prototype.open;
  origXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function () {};
  XMLHttpRequest.prototype.send = function () {};

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
  installWorkerHook(); // enabled-by-default: wraps Worker when available, else no-ops
});

beforeEach(() => {
  posted = [];
});

afterAll(() => {
  XMLHttpRequest.prototype.open = origXhrOpen;
  XMLHttpRequest.prototype.send = origXhrSend;
});

const bridge = () => posted.filter((m) => m.marker === BRIDGE_MARKER);
const ofType = (t: string) => bridge().filter((m) => m.type === t);
// fetch entries now emit from a detached task — poll for them.
const waitForEntry = (url: string) =>
  vi.waitFor(() => {
    const hit = ofType('network')
      .map((m) => m.entry)
      .find((x) => x.url === url);
    expect(hit).toBeTruthy();
    return hit;
  });

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

  it('should record an uncaught error once when installErrorHook is called twice', async () => {
    const { installErrorHook } = await import('../../src/injected/error-hook');
    installErrorHook(); // second call — module-level guard makes it a no-op
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'once-only', error: new Error('once-only') }),
    );
    const hits = ofType('console').filter((m) => m.entry.message === 'once-only');
    expect(hits.length).toBe(1);
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
    expect(bodies.some((b) => b?.includes('[binary 8 bytes]'))).toBe(true);
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
    const hit = await waitForEntry('https://api/data');
    expect(hit.method).toBe('POST');
    expect(hit.status).toBe(200);
    expect(hit.failed).toBe(false);
    expect(hit.requestBody).toBe('q=1');
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
    const hit = await waitForEntry('https://api/big');
    expect(hit.responseBody).toContain('body omitted');
  });

  it('should resolve the page promise before the body read completes when the response streams', async () => {
    vi.useFakeTimers();
    try {
      const { resp, wasCancelled } = streamingResponse(['data: tok1\n'], { endless: true });
      fetchImpl.mockResolvedValueOnce(resp);
      // The page's await resolves even though the clone read is still pending
      // on the open stream — the old inline `await clone.text()` hung here.
      const res = await window.fetch('https://api/stream');
      expect(res.status).toBe(200);
      expect(ofType('network').some((m) => m.entry.url === 'https://api/stream')).toBe(false);
      // After the time budget the reader is cancelled and the entry emits with
      // the bytes that arrived so far.
      await vi.advanceTimersByTimeAsync(3_000);
      const hit = ofType('network').map((m) => m.entry).find((x) => x.url === 'https://api/stream');
      expect(hit).toBeTruthy();
      expect(hit.responseBody).toContain('data: tok1');
      expect(hit.status).toBe(200);
      expect(wasCancelled()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should cancel the reader and clip the body when a chunked stream exceeds the byte cap', async () => {
    // Two 600 KB chunks cross the 1 MB read cap on an endless stream — only
    // the cap cancel (not stream end, not the time budget) can stop the read.
    const chunk = new Uint8Array(600_000).fill(97); // 'a'
    const { resp, wasCancelled } = streamingResponse([chunk, chunk], { endless: true });
    fetchImpl.mockResolvedValueOnce(resp);
    await window.fetch('https://api/bigstream');
    const hit = await waitForEntry('https://api/bigstream');
    expect(wasCancelled()).toBe(true);
    expect(hit.responseBody).toContain('bytes total'); // clip() marker
  });

  it('should serialize FormData and URLSearchParams request bodies when passed to fetch', async () => {
    const fd = new FormData();
    fd.append('user', 'amy');
    await window.fetch('https://api/form', { method: 'POST', body: fd });
    await window.fetch('https://api/usp', { method: 'POST', body: new URLSearchParams({ q: 'x' }) });
    const form = await waitForEntry('https://api/form');
    const usp = await waitForEntry('https://api/usp');
    expect(form.requestBody).toContain('user=amy');
    expect(form.requestBody).not.toContain('[object FormData]');
    expect(usp.requestBody).toBe('q=x');
  });

  it('should record a fetch once when installNetworkHook is called twice', async () => {
    const { installNetworkHook } = await import('../../src/injected/network-hook');
    installNetworkHook(); // second call — module-level guard makes it a no-op
    await window.fetch('https://api/once');
    await waitForEntry('https://api/once');
    const hits = ofType('network').filter((m) => m.entry.url === 'https://api/once');
    expect(hits.length).toBe(1);
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

  it('should keep the newest frames when received frames exceed the cap', () => {
    const ws = new (window as any).WebSocket('wss://a/chatty');
    ws._fire('open', {});
    // 205 frames against a 200-frame cap — the sliding window must drop the
    // 5 oldest, not freeze at the first 200.
    for (let i = 0; i < 205; i++) ws._fire('message', { data: `m${i}` });
    ws._fire('close', { wasClean: true, code: 1000, reason: '' });
    const last = ofType('network')
      .map((m) => m.entry)
      .filter((e) => e.url === 'wss://a/chatty')
      .pop();
    expect(last.frames.length).toBe(200);
    expect(last.frames[0].data).toBe('m5');
    expect(last.frames[199].data).toBe('m204');
  });

  it('should keep the newest frames when sent frames exceed the cap', () => {
    const ws = new (window as any).WebSocket('wss://a/sender');
    ws._fire('open', {});
    for (let i = 0; i < 203; i++) ws.send(`s${i}`);
    ws._fire('close', { wasClean: true, code: 1000, reason: '' });
    const last = ofType('network')
      .map((m) => m.entry)
      .filter((e) => e.url === 'wss://a/sender')
      .pop();
    expect(last.frames.length).toBe(200);
    expect(last.frames[0].data).toBe('s3');
    expect(last.frames[199].data).toBe('s202');
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

  it('should keep the newest frames when received frames exceed the cap', () => {
    const es = new (window as any).EventSource('https://a/chatty-sse');
    es._fire('open', {});
    // 55 frames against a 50-frame cap — keep the most recent 50.
    for (let i = 0; i < 55; i++) es._fire('message', { data: `e${i}` });
    es.readyState = (globalThis as any).EventSource.CLOSED;
    es._fire('error', {});
    const last = ofType('network')
      .map((m) => m.entry)
      .filter((e) => e.url === 'https://a/chatty-sse')
      .pop();
    expect(last.frames.length).toBe(50);
    expect(last.frames[0].data).toBe('e5');
    expect(last.frames[49].data).toBe('e54');
  });

  it('should record named SSE events once when the page listens for a custom event type', () => {
    const es = new (window as any).EventSource('https://a/named');
    es._fire('open', {});
    const seen: unknown[] = [];
    es.addEventListener('chunk', (ev: any) => seen.push(ev.data));
    es.addEventListener('chunk', () => {}); // second listener — recorder must not duplicate
    es._fire('chunk', { data: 'tok-1' });
    es.readyState = (globalThis as any).EventSource.CLOSED;
    es._fire('error', {});
    const last = ofType('network')
      .map((m) => m.entry)
      .filter((e) => e.url === 'https://a/named')
      .pop();
    const chunkFrames = last.frames.filter((f: any) => f.data === 'chunk: tok-1');
    expect(chunkFrames.length).toBe(1);
    // The page's own listeners still fire normally.
    expect(seen).toEqual(['tok-1']);
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

  it('should mark the entry as not failed when the XHR is aborted', () => {
    const xhr = new XMLHttpRequest();
    try {
      xhr.open('GET', 'https://api/xhr-abort');
    } catch {
      /* ignore */
    }
    try {
      xhr.send();
    } catch {
      /* server-less env */
    }
    // User-initiated abort (e.g. SPA nav cancel): status is 0, but this is
    // NOT a network failure.
    xhr.dispatchEvent(new Event('abort'));
    xhr.dispatchEvent(new Event('loadend'));
    const hit = ofType('network').map((m) => m.entry).find((x) => x.url === 'https://api/xhr-abort');
    expect(hit).toBeTruthy();
    expect(hit.failed).toBe(false);
    expect(hit.statusText).toBe('aborted');
  });

  it('should mark the entry as failed with statusText timeout when the XHR times out', () => {
    const xhr = new XMLHttpRequest();
    try {
      xhr.open('GET', 'https://api/xhr-timeout');
    } catch {
      /* ignore */
    }
    try {
      xhr.send();
    } catch {
      /* server-less env */
    }
    xhr.dispatchEvent(new Event('timeout'));
    xhr.dispatchEvent(new Event('loadend'));
    const hit = ofType('network').map((m) => m.entry).find((x) => x.url === 'https://api/xhr-timeout');
    expect(hit).toBeTruthy();
    expect(hit.failed).toBe(true);
    expect(hit.statusText).toBe('timeout');
  });

  it('should parse response headers into the entry when loadend fires', () => {
    const xhr = new XMLHttpRequest();
    try {
      xhr.open('GET', 'https://api/xhr-headers');
    } catch {
      /* ignore */
    }
    // happy-dom never completes a server-less request, so stub the raw header
    // block the way a browser returns it (CRLF-separated "Name: value" lines).
    Object.defineProperty(xhr, 'getAllResponseHeaders', {
      value: () => 'Content-Type: application/json\r\nX-Request-Id: abc123\r\n',
      configurable: true,
    });
    try {
      xhr.send();
    } catch {
      /* server-less env */
    }
    xhr.dispatchEvent(new Event('loadend'));
    const hit = ofType('network').map((m) => m.entry).find((x) => x.url === 'https://api/xhr-headers');
    expect(hit).toBeTruthy();
    expect(hit.responseHeaders).toMatchObject({
      'content-type': 'application/json',
      'x-request-id': 'abc123',
    });
  });

  it('should serialize URLSearchParams and FormData bodies when sent via XHR', () => {
    const xhr = new XMLHttpRequest();
    try {
      xhr.open('POST', 'https://api/xhr-usp');
    } catch {
      /* ignore */
    }
    try {
      xhr.send(new URLSearchParams({ a: '1' }) as any);
    } catch {
      /* server-less env */
    }
    xhr.dispatchEvent(new Event('loadend'));

    const xhr2 = new XMLHttpRequest();
    try {
      xhr2.open('POST', 'https://api/xhr-form');
    } catch {
      /* ignore */
    }
    const fd = new FormData();
    fd.append('k', 'v');
    try {
      xhr2.send(fd as any);
    } catch {
      /* server-less env */
    }
    xhr2.dispatchEvent(new Event('loadend'));

    const entries = ofType('network').map((m) => m.entry);
    expect(entries.find((x) => x.url === 'https://api/xhr-usp').requestBody).toBe('a=1');
    expect(entries.find((x) => x.url === 'https://api/xhr-form').requestBody).toContain('k=v');
  });
});

describe('repro-recorder', () => {
  it('should record steps once when installReproRecorder is called twice', async () => {
    const { installReproRecorder } = await import('../../src/injected/repro-recorder');
    installReproRecorder();
    const steps = () => bridge().filter((m) => m.type === 'step');
    expect(steps().length).toBe(1); // initial navigate
    installReproRecorder(); // second call — guard: no second navigate, no duplicate listeners
    expect(steps().length).toBe(1);
    document.body.innerHTML = '<button id="b">Go</button>';
    document.getElementById('b')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const clicks = steps().filter((m) => m.step?.kind === 'click');
    expect(clicks.length).toBe(1);
  });
});
