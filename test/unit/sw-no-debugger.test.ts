import { describe, it, expect, beforeAll } from 'vitest';
import { chromeApi } from '../setup/chrome-mock';

// Regression guard (defense-in-depth): `debugger` is now a required permission,
// so chrome.debugger is normally present. But the service worker (via
// deep-capture's top-level bindListener) must still NOT crash at load if the
// API is ever absent — accessing chrome.debugger unconditionally would throw at
// module eval and kill the worker, so NO messages would ever be handled and the
// whole extension would silently break. (Originally caught by the e2e harness.)
beforeAll(async () => {
  // Simulate chrome.debugger being unavailable.
  delete (chromeApi as unknown as { debugger?: unknown }).debugger;
  await import('../../src/background/service-worker');
});

describe('service worker — loads even when chrome.debugger is unavailable', () => {
  it('registers its onMessage listener even when chrome.debugger is undefined', () => {
    // If the module had thrown at load, no listener would be registered.
    expect(chromeApi.runtime.onMessage._listeners.length).toBeGreaterThan(0);
  });
});
