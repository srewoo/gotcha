import { describe, it, expect } from 'vitest';
import { buildHar } from '../../src/share/har';
import type { CaptureBundle } from '../../src/shared/types';

function bundle(net: any[]): CaptureBundle {
  return {
    id: 'abc123', title: 't', console: [], network: net, steps: [], replay: [],
    environment: { url: 'https://a.com', userAgent: 'x', browser: 'Chrome', os: 'mac',
      viewport: { width: 1, height: 1 }, dpr: 1, locale: 'en', capturedAt: 0 },
    redacted: false, createdAt: 1700000000000,
  } as CaptureBundle;
}

describe('buildHar', () => {
  const net = [{ id: 'n1', url: 'https://api.x.com/v1/users?access_token=zzz', method: 'GET',
    status: 500, statusText: 'err', durationMs: 12, failed: true, ts: 1700000000001,
    responseBody: 'boom' }];

  it('should produce valid HAR 1.2 with one entry per request', () => {
    const out = buildHar(bundle(net), { redact: false });
    const har = JSON.parse(out.json);
    expect(har.log.version).toBe('1.2');
    expect(har.log.entries).toHaveLength(1);
    expect(har.log.entries[0].request.method).toBe('GET');
    expect(har.log.entries[0].response.status).toBe(500);
    expect(out.filename).toMatch(/\.har$/);
  });

  it('should mask secret query tokens in the URL when redaction is on', () => {
    const out = buildHar(bundle(net), { redact: true });
    expect(out.json).not.toContain('zzz');
  });

  it('maps request body, headers, query string and sorts entries by ts', () => {
    const out = buildHar(
      bundle([
        {
          id: 'n2', url: 'https://api/x?a=1&b=2', method: 'POST', status: 200, statusText: 'OK',
          durationMs: 5, failed: false, ts: 1700000000005,
          requestHeaders: { 'x-test': '1' }, responseHeaders: { 'content-type': 'application/json' },
          requestBody: '{"q":1}', responseBody: '{"r":2}',
        },
        {
          id: 'n1', url: 'https://api/y', method: 'GET', status: 304, durationMs: 1, failed: false, ts: 1700000000001,
        },
      ]),
      { redact: false },
    );
    const har = JSON.parse(out.json);
    // sorted ascending by ts → n1 (GET /y) first
    expect(har.log.entries[0].request.url).toBe('https://api/y');
    const post = har.log.entries[1];
    expect(post.request.postData.text).toBe('{"q":1}');
    expect(post.request.queryString).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ]);
    expect(post.request.headers).toContainEqual({ name: 'x-test', value: '1' });
    expect(post.response.content.mimeType).toBe('application/json');
  });

  it('handles an empty network log', () => {
    const har = JSON.parse(buildHar(bundle([]), { redact: false }).json);
    expect(har.log.entries).toEqual([]);
  });
});
