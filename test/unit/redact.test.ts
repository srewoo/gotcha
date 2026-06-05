import { describe, it, expect } from 'vitest';
import { maskString, redactBundle } from '../../src/shared/redact';
import type { CaptureBundle } from '../../src/shared/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const REDACTED = '«redacted»';

function makeBundle(overrides: Partial<CaptureBundle> = {}): CaptureBundle {
  return {
    id: 'test-id-001',
    title: 'Test bundle',
    console: [],
    network: [],
    steps: [],
    replay: [],
    environment: {
      url: 'https://example.com',
      userAgent: 'Mozilla/5.0',
      browser: 'Chrome',
      os: 'macOS',
      viewport: { width: 1280, height: 720 },
      dpr: 1,
      locale: 'en-US',
      capturedAt: 1700000000000,
    },
    redacted: false,
    createdAt: 1700000000000,
    ...overrides,
  };
}

// ─── maskString ──────────────────────────────────────────────────────────────

describe('maskString', () => {
  it('should mask email addresses', () => {
    expect(maskString('Contact us at user@example.com for help')).toBe(
      `Contact us at ${REDACTED} for help`,
    );
  });

  it('should mask multiple emails in one string', () => {
    const result = maskString('From: a@foo.com To: b@bar.org');
    expect(result).not.toContain('@');
    expect(result.split(REDACTED).length - 1).toBe(2);
  });

  it('should mask Bearer tokens', () => {
    expect(maskString('Authorization: Bearer eyABCDEFGHIJ123')).toContain(REDACTED);
    expect(maskString('Authorization: Bearer eyABCDEFGHIJ123')).not.toContain('eyABCDEFGHIJ123');
  });

  it('should mask JWT-like strings starting with eyJ', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.hash';
    expect(maskString(jwt)).toContain(REDACTED);
    expect(maskString(jwt)).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  });

  it('should mask credit-card-like number runs (13-19 digit sequences)', () => {
    // 16-digit card number with spaces
    const result = maskString('Card: 4111 1111 1111 1111');
    expect(result).toContain(REDACTED);
  });

  it('should preserve non-sensitive plain text', () => {
    const plain = 'The quick brown fox jumps over the lazy dog.';
    expect(maskString(plain)).toBe(plain);
  });

  it('should preserve numbers that are clearly not card numbers', () => {
    expect(maskString('Error code 404 on page 1')).toBe('Error code 404 on page 1');
  });
});

// ─── redactBundle — headers ───────────────────────────────────────────────────

describe('redactBundle — secret request/response headers', () => {
  const secretHeaders = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'x-csrf-token', 'proxy-authorization'];

  for (const header of secretHeaders) {
    it(`should redact the "${header}" request header`, () => {
      const bundle = makeBundle({
        network: [
          {
            id: 'n1',
            url: 'https://api.example.com/data',
            method: 'GET',
            status: 200,
            requestHeaders: { [header]: 'super-secret-value', 'content-type': 'application/json' },
            durationMs: 100,
            failed: false,
            ts: 1700000000000,
          },
        ],
      });
      const result = redactBundle(bundle);
      expect(result.network[0]!.requestHeaders![header]).toBe(REDACTED);
      expect(result.network[0]!.requestHeaders!['content-type']).toBe('application/json');
    });
  }

  it('should redact authorization in response headers', () => {
    const bundle = makeBundle({
      network: [
        {
          id: 'n1',
          url: 'https://api.example.com/data',
          method: 'GET',
          status: 200,
          responseHeaders: { 'set-cookie': 'session=abc123; HttpOnly', 'x-powered-by': 'Express' },
          durationMs: 50,
          failed: false,
          ts: 1700000000000,
        },
      ],
    });
    const result = redactBundle(bundle);
    expect(result.network[0]!.responseHeaders!['set-cookie']).toBe(REDACTED);
    expect(result.network[0]!.responseHeaders!['x-powered-by']).toBe('Express');
  });

  it('should be case-insensitive for header names', () => {
    const bundle = makeBundle({
      network: [
        {
          id: 'n1',
          url: 'https://api.example.com/data',
          method: 'GET',
          status: 200,
          requestHeaders: { 'Authorization': 'Bearer token123', 'Cookie': 'sid=xyz' },
          durationMs: 50,
          failed: false,
          ts: 1700000000000,
        },
      ],
    });
    const result = redactBundle(bundle);
    expect(result.network[0]!.requestHeaders!['Authorization']).toBe(REDACTED);
    expect(result.network[0]!.requestHeaders!['Cookie']).toBe(REDACTED);
  });
});

// ─── redactBundle — body masking ──────────────────────────────────────────────

describe('redactBundle — body field masking', () => {
  it('should mask email in request body', () => {
    const bundle = makeBundle({
      network: [
        {
          id: 'n1',
          url: 'https://api.example.com/login',
          method: 'POST',
          status: 200,
          requestBody: '{"email":"user@example.com","remember":true}',
          durationMs: 50,
          failed: false,
          ts: 1700000000000,
        },
      ],
    });
    const result = redactBundle(bundle);
    expect(result.network[0]!.requestBody).not.toContain('user@example.com');
    expect(result.network[0]!.requestBody).toContain(REDACTED);
  });

  it('should mask secret-named JSON fields (password, token, secret, cvv, pin)', () => {
    const secretFields = ['password', 'token', 'secret', 'cvv', 'pin'];
    for (const field of secretFields) {
      const bundle = makeBundle({
        network: [
          {
            id: 'n1',
            url: 'https://api.example.com/data',
            method: 'POST',
            status: 200,
            requestBody: `{"${field}":"super-sensitive-value","other":"keep-me"}`,
            durationMs: 50,
            failed: false,
            ts: 1700000000000,
          },
        ],
      });
      const result = redactBundle(bundle);
      expect(result.network[0]!.requestBody).not.toContain('super-sensitive-value');
      expect(result.network[0]!.requestBody).toContain('keep-me');
    }
  });

  it('should preserve non-sensitive response body content', () => {
    const bundle = makeBundle({
      network: [
        {
          id: 'n1',
          url: 'https://api.example.com/products',
          method: 'GET',
          status: 200,
          responseBody: '{"products":[{"id":1,"name":"Widget","price":9.99}]}',
          durationMs: 50,
          failed: false,
          ts: 1700000000000,
        },
      ],
    });
    const result = redactBundle(bundle);
    expect(result.network[0]!.responseBody).toBe('{"products":[{"id":1,"name":"Widget","price":9.99}]}');
  });
});

// ─── redactBundle — console messages ─────────────────────────────────────────

describe('redactBundle — console message masking', () => {
  it('should mask email in console messages', () => {
    const bundle = makeBundle({
      console: [
        { id: 'c1', level: 'error', message: 'Failed to load user@example.com', ts: 1700000000000 },
      ],
    });
    const result = redactBundle(bundle);
    expect(result.console[0]!.message).not.toContain('user@example.com');
    expect(result.console[0]!.message).toContain(REDACTED);
  });

  it('should mask Bearer tokens in console messages', () => {
    const bundle = makeBundle({
      console: [
        { id: 'c1', level: 'log', message: 'Sending Authorization: Bearer abc123xyz456', ts: 1700000000000 },
      ],
    });
    const result = redactBundle(bundle);
    expect(result.console[0]!.message).not.toContain('abc123xyz456');
  });

  it('should preserve console messages without sensitive data', () => {
    const bundle = makeBundle({
      console: [
        { id: 'c1', level: 'log', message: 'Component mounted successfully', ts: 1700000000000 },
      ],
    });
    const result = redactBundle(bundle);
    expect(result.console[0]!.message).toBe('Component mounted successfully');
  });
});

// ─── redactBundle — steps ─────────────────────────────────────────────────────

describe('redactBundle — step value masking', () => {
  it('should mask email typed into an input step', () => {
    const bundle = makeBundle({
      steps: [
        { id: 's1', kind: 'input', label: 'Email field', value: 'user@example.com', ts: 1700000000000 },
      ],
    });
    const result = redactBundle(bundle);
    expect(result.steps[0]!.value).not.toContain('user@example.com');
    expect(result.steps[0]!.value).toContain(REDACTED);
  });

  it('should leave step value undefined if it was undefined', () => {
    const bundle = makeBundle({
      steps: [
        { id: 's1', kind: 'click', label: 'Submit button', ts: 1700000000000 },
      ],
    });
    const result = redactBundle(bundle);
    expect(result.steps[0]!.value).toBeUndefined();
  });
});

// ─── redactBundle — replay events ─────────────────────────────────────────────

describe('redactBundle — replay events html/value masking', () => {
  it('should mask email in replay html payload', () => {
    const bundle = makeBundle({
      replay: [
        { t: 100, kind: 'snapshot', html: '<div>Contact: user@example.com</div>' },
      ],
    });
    const result = redactBundle(bundle);
    expect(result.replay![0]!.html).not.toContain('user@example.com');
    expect(result.replay![0]!.html).toContain(REDACTED);
  });

  it('should mask Bearer token in replay value payload', () => {
    const bundle = makeBundle({
      replay: [
        { t: 200, kind: 'input', selector: '#token-field', value: 'Bearer eyJsometoken12345' },
      ],
    });
    const result = redactBundle(bundle);
    expect(result.replay![0]!.value).not.toContain('eyJsometoken12345');
  });

  it('should leave replay html undefined when it was not set', () => {
    const bundle = makeBundle({
      replay: [
        { t: 300, kind: 'scroll', x: 0, y: 100 },
      ],
    });
    const result = redactBundle(bundle);
    expect(result.replay![0]!.html).toBeUndefined();
  });
});

// ─── redactBundle — WebSocket frames ─────────────────────────────────────────

describe('redactBundle — WebSocket frame data masking', () => {
  it('should mask email in WebSocket frame data', () => {
    const bundle = makeBundle({
      network: [
        {
          id: 'n1',
          url: 'wss://api.example.com/ws',
          method: 'GET',
          status: 101,
          transport: 'websocket',
          frames: [
            { dir: 'send', data: '{"user":"admin@corp.com","action":"subscribe"}', ts: 1700000000001 },
            { dir: 'recv', data: '{"status":"ok"}', ts: 1700000000002 },
          ],
          durationMs: 5000,
          failed: false,
          ts: 1700000000000,
        },
      ],
    });
    const result = redactBundle(bundle);
    expect(result.network[0]!.frames![0]!.data).not.toContain('admin@corp.com');
    expect(result.network[0]!.frames![0]!.data).toContain(REDACTED);
    // Non-sensitive frame preserved
    expect(result.network[0]!.frames![1]!.data).toBe('{"status":"ok"}');
  });
});

// ─── redactBundle — redacted flag & idempotency ───────────────────────────────

describe('redactBundle — redacted flag and idempotency', () => {
  it('should set redacted: true on the output bundle', () => {
    const bundle = makeBundle({ redacted: false });
    const result = redactBundle(bundle);
    expect(result.redacted).toBe(true);
  });

  it('should be idempotent — redacting twice produces the same result as once', () => {
    const bundle = makeBundle({
      console: [
        { id: 'c1', level: 'error', message: 'user@example.com failed auth', ts: 1700000000000 },
      ],
      network: [
        {
          id: 'n1',
          url: 'https://api.example.com/login',
          method: 'POST',
          status: 401,
          requestHeaders: { authorization: 'Bearer token123abc' },
          requestBody: '{"password":"hunter2"}',
          durationMs: 50,
          failed: true,
          ts: 1700000000000,
        },
      ],
    });
    const once = redactBundle(bundle);
    const twice = redactBundle(once);
    expect(twice.console[0]!.message).toBe(once.console[0]!.message);
    expect(twice.network[0]!.requestHeaders!['authorization']).toBe(once.network[0]!.requestHeaders!['authorization']);
    expect(twice.network[0]!.requestBody).toBe(once.network[0]!.requestBody);
    expect(twice.redacted).toBe(true);
  });

  it('should not mutate the original bundle', () => {
    const originalMessage = 'user@example.com logged in';
    const bundle = makeBundle({
      console: [{ id: 'c1', level: 'log', message: originalMessage, ts: 1700000000000 }],
    });
    redactBundle(bundle);
    expect(bundle.console[0]!.message).toBe(originalMessage);
    expect(bundle.redacted).toBe(false);
  });
});

// ─── Redaction completeness (audit fixes) ─────────────────────────────────────

describe('redactBundle — URL and DOM snapshot masking', () => {
  const base = () => ({
    id: 'b1', title: 'x', console: [], network: [], steps: [], replay: [],
    environment: { url: 'https://a.com', userAgent: 'x', browser: 'Chrome', os: 'mac',
      viewport: { width: 1, height: 1 }, dpr: 1, locale: 'en', capturedAt: 0 },
    redacted: false, createdAt: 0,
  });

  it('should mask secret query-string params in a network URL', () => {
    const b = { ...base(), network: [{
      id: 'n1', url: 'https://api.x.com/cb?access_token=abc123&page=2',
      method: 'GET', status: 200, durationMs: 1, failed: false, ts: 0,
    }] } as any;
    const out = redactBundle(b);
    expect(out.network[0].url).not.toContain('abc123');
    expect(out.network[0].url).toContain('page=2');
  });

  it('should mask emails embedded in the DOM snapshot', () => {
    const b = { ...base(), domSnapshot: '<div>jane@acme.com</div>' } as any;
    expect(redactBundle(b).domSnapshot).not.toContain('jane@acme.com');
  });
});

// ─── Custom redaction patterns (feature F7) ───────────────────────────────────

import { setExtraRedactionPatterns } from '../../src/shared/redact';

describe('setExtraRedactionPatterns', () => {
  it('should mask a user-defined pattern and ignore invalid regex', () => {
    setExtraRedactionPatterns(['acme-\\d{4}', '(['] /* invalid, skipped */);
    expect(maskString('ref acme-1234 done')).not.toContain('acme-1234');
    setExtraRedactionPatterns([]); // reset for other tests
    expect(maskString('ref acme-1234 done')).toContain('acme-1234');
  });
});
