import { BRIDGE_MARKER, post } from './bridge';
import { uid } from '@shared/uid';
import type { NetworkEntry } from '@shared/types';

// Cap captured bodies so a multi-MB response can't bloat the buffer or freeze
// serialization. Deep mode (chrome.debugger, v1.5) lifts this.
const MAX_BODY = 65_536;
// If a response declares more than this many bytes, we DON'T read it into
// memory at all (reading a 100 MB download just to clip to 64 KB is wasteful
// and can OOM the tab). We record a placeholder instead. (Issue #2)
const MAX_READ_BYTES = 1_000_000;

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

async function bodyFromInit(init?: RequestInit): Promise<string | undefined> {
  if (!init?.body) return undefined;
  if (typeof init.body === 'string') return clip(init.body);
  try {
    return clip(String(init.body));
  } catch {
    return undefined;
  }
}

function installFetchHook(): void {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const started = Date.now();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const requestBody = await bodyFromInit(init);

    try {
      const response = await originalFetch(input, init);
      let responseBody: string | undefined;
      const tooLarge = declaredTooLarge(response.headers);
      if (tooLarge !== null) {
        responseBody = `[body omitted: ${tooLarge} bytes]`;
      } else {
        const clone = response.clone();
        try {
          responseBody = clip(await clone.text());
        } catch {
          responseBody = undefined;
        }
      }
      emit({
        id: uid(),
        url,
        method: method.toUpperCase(),
        status: response.status,
        statusText: response.statusText,
        responseHeaders: headersToObject(response.headers),
        requestBody,
        responseBody,
        durationMs: Date.now() - started,
        failed: !response.ok,
        ts: started,
      });
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
      if (typeof body === 'string') meta.body = clip(body);
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
        emit({
          id: uid(),
          url: meta.url,
          method: meta.method,
          status: this.status,
          statusText: this.statusText,
          requestBody: meta.body,
          responseBody,
          durationMs: Date.now() - meta.started,
          failed: this.status === 0 || this.status >= 400,
          ts: meta.started,
        });
      });
    }
    return send.call(this, body ?? null);
  };
}

export function installNetworkHook(): void {
  installFetchHook();
  installXhrHook();
}
