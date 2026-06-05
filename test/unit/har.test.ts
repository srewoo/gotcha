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
});
