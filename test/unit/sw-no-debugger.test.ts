import { describe, it, expect, beforeAll } from 'vitest';
import { chromeApi } from '../setup/chrome-mock';

// Regression guard: `debugger` is an OPTIONAL permission, so `chrome.debugger`
// is undefined until the user enables deep capture. The service worker (via
// deep-capture's top-level bindListener) must NOT touch chrome.debugger at load
// time, or the whole worker crashes and no messages are ever handled — which
// silently breaks the entire extension. (Caught by the e2e harness.)
beforeAll(async () => {
  // Simulate the permission NOT being granted.
  delete (chromeApi as unknown as { debugger?: unknown }).debugger;
  await import('../../src/background/service-worker');
});

describe('service worker — loads without the optional debugger permission', () => {
  it('registers its onMessage listener even when chrome.debugger is undefined', () => {
    // If the module had thrown at load, no listener would be registered.
    expect(chromeApi.runtime.onMessage._listeners.length).toBeGreaterThan(0);
  });
});
