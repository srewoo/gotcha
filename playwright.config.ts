import { defineConfig } from '@playwright/test';

// E2E harness for the built extension. These tests load dist/ as an unpacked
// MV3 extension and drive the real capture → review → file flow in Chromium —
// covering the chrome.* wiring (content script, service worker, IndexedDB,
// review page) that unit tests can't reach. Run `npm run build` first.
export default defineConfig({
  testDir: './test/e2e',
  // Each spec owns a persistent browser context with the extension loaded, so
  // run serially to avoid debugger/port contention.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
});
