import { BRIDGE_MARKER, post } from './bridge';
import { uid } from '@shared/uid';
import type { NetworkEntry } from '@shared/types';
import { serializeBody } from './body-serializer';

// Cap captured bodies so a multi-MB response can't bloat the buffer or freeze
// serialization. Deep mode (chrome.debugger, v1.5) lifts this.
const MAX_BODY = 65_536;
// If a response declares more than this many bytes, we DON'T read it into
// memory at all (reading a 100 MB download just to clip to 64 KB is wasteful
// and can OOM the tab). We record a placeholder instead. (Issue #2)
const MAX_READ_BYTES = 1_000_000;
// Streamed responses (SSE-over-fetch, LLM token streams) may never end. Stop
// reading the clone after this budget and emit with whatever bytes arrived —
// otherwise the entry never emits and the clone's tee buffer grows unbounded.
const STREAM_READ_BUDGET_MS = 3_000;

function clip(text: string): string {
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}… [${text.length} bytes total]` : text;
}

function declaredTooLarge(headers: { get(name: string): string | null }): number | null {
  const len = Number(headers.get('content-length'));
  return Number.isFinite(len) && len > MAX_READ_BYTES ? len : null;
}

function emit(entry: NetworkEntry): void {
  post({ marker: BRIDGE_MARKER, type: 'network', entry });
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function bodyFromInit(init?: RequestInit): string | undefined {
  if (init?.body == null) return undefined;
  const serialized = serializeBody(init.body);
  return serialized === undefined ? undefined : clip(serialized);
}

// Cancelling must never throw into our capture path — and test doubles may
// return undefined from cancel(), so normalise through Promise.resolve.
function cancelQuietly(reader: { cancel(): Promise<unknown> | void }): void {
  try {
    void Promise.resolve(reader.cancel()).catch(() => {});
  } catch {
    // ignore
  }
}

// Read the cloned response body WITHOUT ever blocking the page's fetch:
// incremental decode with a hard byte cap (cancel past MAX_READ_BYTES — the
// content-length check above can't see chunked responses) and a time budget
// (cancel after STREAM_READ_BUDGET_MS so an endless stream still emits).
async function readClonedBody(response: Response): Promise<string | undefined> {
  let clone: Response;
  try {
    clone = response.clone();
  } catch {
    return undefined; // body already disturbed — nothing to capture
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = typeof clone.body?.getReader === 'function' ? clone.body.getReader() : undefined;
  } catch {
    reader = undefined;
  }
  if (!reader) {
    // No streaming surface (older polyfills / test doubles): such bodies are
    // already fully buffered, so text() can't hang here.
    try {
      return clip(await clone.text());
    } catch {
      return undefined;
    }
  }

  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let expired = false;
  const r = reader;
  const budget = setTimeout(() => {
    expired = true;
    // Cancel resolves any pending read() with done:true, unblocking the loop.
    cancelQuietly(r);
  }, STREAM_READ_BUDGET_MS);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        bytes += value.byteLength;
        text += decoder.decode(value, { stream: true });
      }
      if (expired) break;
      if (bytes > MAX_READ_BYTES) {
        cancelQuietly(reader);
        break;
      }
    }
  } catch {
    // Reader failure mid-stream — keep whatever bytes arrived.
  } finally {
    clearTimeout(budget);
  }
  text += decoder.decode(); // flush any buffered partial code point
  return text ? clip(text) : undefined;
}

function installFetchHook(): void {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const started = Date.now();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const requestBody = bodyFromInit(init);

    try {
      const response = await originalFetch(input, init);
      const durationMs = Date.now() - started;
      const tooLarge = declaredTooLarge(response.headers);
      // Status/headers are known synchronously; only the body is late. Capture
      // it in a DETACHED task so the page's `await fetch()` resolves now —
      // buffering the clone inline hangs streamed responses forever. (Issue #1)
      void (async () => {
        const responseBody =
          tooLarge !== null
            ? `[body omitted: ${tooLarge} bytes]`
            : await readClonedBody(response);
        emit({
          id: uid(),
          url,
          method: method.toUpperCase(),
          status: response.status,
          statusText: response.statusText,
          responseHeaders: headersToObject(response.headers),
          requestBody,
          responseBody,
          durationMs,
          failed: !response.ok,
          ts: started,
        });
      })();
      return response;
    } catch (err) {
      emit({
        id: uid(),
        url,
        method: method.toUpperCase(),
        status: 0,
        statusText: err instanceof Error ? err.message : 'Network error',
        requestBody,
        durationMs: Date.now() - started,
        failed: true,
        ts: started,
      });
      throw err;
    }
  };
}

interface TrackedXhr extends XMLHttpRequest {
  __gotcha?: { method: string; url: string; started: number; body?: string };
}

// Parse the CRLF-separated "name: value" lines from getAllResponseHeaders()
// into the entry shape (names lowercased, matching Headers semantics).
function parseXhrHeaders(raw: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function installXhrHook(): void {
  const proto = XMLHttpRequest.prototype;
  const open = proto.open;
  const send = proto.send;

  proto.open = function (this: TrackedXhr, method: string, url: string | URL, ...rest: unknown[]) {
    this.__gotcha = { method: method.toUpperCase(), url: String(url), started: 0 };
    // @ts-expect-error — forwarding the native variadic signature.
    return open.call(this, method, url, ...rest);
  };

  proto.send = function (this: TrackedXhr, body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = this.__gotcha;
    if (meta) {
      meta.started = Date.now();
      const serialized = serializeBody(body);
      if (serialized !== undefined) meta.body = clip(serialized);
      // Distinguish user-initiated aborts (SPA nav cancels — NOT failures) and
      // timeouts from genuine network errors: all three end with status 0, so
      // loadend alone can't tell them apart. (Issue #3)
      let ended: 'abort' | 'timeout' | undefined;
      this.addEventListener('abort', () => {
        ended = 'abort';
      });
      this.addEventListener('timeout', () => {
        ended = 'timeout';
      });
      this.addEventListener('loadend', () => {
        let responseBody: string | undefined;
        try {
          const declared = Number(this.getResponseHeader('content-length'));
          if (Number.isFinite(declared) && declared > MAX_READ_BYTES) {
            responseBody = `[body omitted: ${declared} bytes]`;
          } else {
            responseBody =
              this.responseType === '' || this.responseType === 'text'
                ? clip(this.responseText)
                : undefined;
          }
        } catch {
          responseBody = undefined;
        }
        let responseHeaders: Record<string, string> | undefined;
        try {
          responseHeaders = parseXhrHeaders(this.getAllResponseHeaders() ?? '');
        } catch {
          responseHeaders = undefined;
        }
        emit({
          id: uid(),
          url: meta.url,
          method: meta.method,
          status: this.status,
          statusText:
            ended === 'abort' ? 'aborted' : ended === 'timeout' ? 'timeout' : this.statusText,
          responseHeaders,
          requestBody: meta.body,
          responseBody,
          durationMs: Date.now() - meta.started,
          failed:
            ended === 'abort'
              ? false
              : ended === 'timeout'
                ? true
                : this.status === 0 || this.status >= 400,
          ts: meta.started,
        });
      });
    }
    return send.call(this, body ?? null);
  };
}

// Guard against double-install (script may be re-evaluated by the page).
let installed = false;

export function installNetworkHook(): void {
  if (installed) return;
  installed = true;

  installFetchHook();
  installXhrHook();
}
