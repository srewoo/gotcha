import type { CaptureBundle, NetworkEntry } from '@shared/types';
import { redactBundle } from '@shared/redact';

// Export the captured network log as a HAR 1.2 file (feature F4). Devs import
// HAR straight into Chrome DevTools, Charles, or Proxyman — so a Gotcha capture
// drops into the tooling they already use. Honors the redaction toggle.

export interface ExportedHar {
  filename: string;
  json: string;
}

interface HarHeader {
  name: string;
  value: string;
}

function headers(map?: Record<string, string>): HarHeader[] {
  return map ? Object.entries(map).map(([name, value]) => ({ name, value })) : [];
}

// Case-insensitive content-type lookup. WHY: deep-capture stores raw CDP
// header casing (`Content-Type`), while the fetch hook lowercases — a
// case-sensitive index miss made exactly the richest entries fall back to
// text/plain in HAR viewers.
function contentTypeOf(h?: Record<string, string>): string {
  return Object.entries(h ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? 'text/plain';
}

function queryString(url: string): HarHeader[] {
  try {
    return [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function toEntry(n: NetworkEntry): unknown {
  return {
    startedDateTime: new Date(n.ts).toISOString(),
    time: n.durationMs,
    _transport: n.transport ?? 'fetch',
    request: {
      method: n.method,
      url: n.url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: headers(n.requestHeaders),
      queryString: queryString(n.url),
      postData: n.requestBody ? { mimeType: 'application/octet-stream', text: n.requestBody } : undefined,
      headersSize: -1,
      bodySize: n.requestBody ? n.requestBody.length : 0,
    },
    response: {
      status: n.status,
      statusText: n.statusText ?? '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: headers(n.responseHeaders),
      content: {
        size: n.responseBody ? n.responseBody.length : 0,
        mimeType: contentTypeOf(n.responseHeaders),
        text: n.responseBody ?? '',
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: n.responseBody ? n.responseBody.length : -1,
    },
    cache: {},
    timings: { send: 0, wait: n.durationMs, receive: 0 },
  };
}

export function buildHar(bundle: CaptureBundle, opts: { redact: boolean }): ExportedHar {
  const b = opts.redact ? redactBundle(bundle) : bundle;
  // Page start = earliest entry timestamp. WHY: b.createdAt is when the capture
  // FINISHED, which postdates every entry — viewers would show negative offsets
  // for the whole waterfall. Fall back to createdAt when there are no entries.
  const pageStart = b.network.length > 0 ? Math.min(...b.network.map((n) => n.ts)) : b.createdAt;
  const har = {
    log: {
      version: '1.2',
      creator: { name: 'Gotcha', version: '0.1.0' },
      pages: [
        {
          startedDateTime: new Date(pageStart).toISOString(),
          id: b.id,
          title: b.title,
          pageTimings: {},
        },
      ],
      entries: b.network
        .slice()
        .sort((a, c) => a.ts - c.ts)
        .map((n) => ({ ...(toEntry(n) as object), pageref: b.id })),
    },
  };
  return { filename: `gotcha-${b.id.slice(0, 6)}.har`, json: JSON.stringify(har, null, 2) };
}
