import { describe, it, expect } from 'vitest';
import { buildSummary } from '../../src/content/db';
import type { CaptureBundle } from '../../src/shared/types';

// buildSummary is the canonical bundle → lightweight index-row derivation that
// keeps the dashboard list off the heavy payload. Pure + deterministic, so it's
// unit-testable without IndexedDB (which the db module only touches lazily).

function bundle(overrides: Partial<CaptureBundle> = {}): CaptureBundle {
  return {
    id: 'abc123',
    title: 'Some bug',
    console: [],
    network: [],
    steps: [],
    replay: [],
    environment: {
      url: 'https://x.test/',
      userAgent: 'UA',
      browser: 'Chrome',
      os: 'macOS',
      viewport: { width: 1, height: 1 },
      dpr: 1,
      locale: 'en',
      capturedAt: 1,
    },
    redacted: true,
    createdAt: 123,
    ...overrides,
  };
}

describe('buildSummary', () => {
  it('should derive counts and carry id/title/createdAt', () => {
    const s = buildSummary(
      bundle({
        console: [
          { id: 'c1', level: 'log', message: 'a', ts: 1 },
          { id: 'c2', level: 'error', message: 'b', ts: 2 },
          { id: 'c3', level: 'error', message: 'c', ts: 3 },
        ],
        network: [
          { id: 'n1', url: 'u', method: 'GET', status: 200, durationMs: 1, failed: false, ts: 1 },
          { id: 'n2', url: 'u', method: 'GET', status: 500, durationMs: 1, failed: true, ts: 2 },
        ],
        steps: [{ id: 's1', kind: 'click', label: 'x', ts: 1 }],
      }),
    );
    expect(s.id).toBe('abc123');
    expect(s.title).toBe('Some bug');
    expect(s.createdAt).toBe(123);
    expect(s.counts).toEqual({ console: 3, errors: 2, network: 2, failed: 1, steps: 1 });
  });

  it('should reflect hasTest and a null filed by default', () => {
    expect(buildSummary(bundle()).hasTest).toBe(false);
    expect(buildSummary(bundle()).filed).toBeNull();
    expect(
      buildSummary(bundle({ generatedTest: { filename: 'f.spec.ts', source: '//' } })).hasTest,
    ).toBe(true);
  });

  it('should project the filed reference when present', () => {
    const s = buildSummary(
      bundle({ filed: { integration: 'linear', identifier: 'GOT-1', url: 'https://l/1', at: 9 } }),
    );
    expect(s.filed).toEqual({ integration: 'linear', identifier: 'GOT-1', url: 'https://l/1' });
  });
});
