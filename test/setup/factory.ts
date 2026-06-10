import type { CaptureBundle } from '../../src/shared/types';

export function makeBundle(overrides: Partial<CaptureBundle> = {}): CaptureBundle {
  return {
    id: 'abc123def456',
    title: 'Login flow regression',
    console: [],
    network: [],
    steps: [],
    replay: [],
    environment: {
      url: 'https://app.example.com/login?token=secret',
      userAgent: 'Mozilla/5.0',
      browser: 'Chrome',
      os: 'macOS',
      viewport: { width: 1280, height: 720 },
      dpr: 2,
      locale: 'en-US',
      capturedAt: 1700000000000,
    },
    redacted: false,
    createdAt: 1700000000000,
    ...overrides,
  };
}
