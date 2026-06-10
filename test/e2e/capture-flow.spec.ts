import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './fixture-server';

const EXT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');

let context: BrowserContext;
let serviceWorker: Worker;
let fixture: { url: string; close: () => Promise<void> };

test.beforeAll(async () => {
  fixture = await startFixtureServer();
  // MV3 service workers only register under HEADED Chromium — new-headless loads
  // the extension but never spins up its worker. CI must run this under a
  // virtual display (xvfb-run -a npm run test:e2e).
  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      '--no-sandbox', // required when running as root / in a container
      '--disable-setuid-sandbox',
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
    ],
  });
  serviceWorker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
});

test.afterAll(async () => {
  await context?.close();
  await fixture?.close();
});

// Open the fixture app, let the always-on buffers fill, then drive a one-click
// capture from the service worker against that exact tab (fire-and-forget — the
// response only resolves after the review tab opens). Returns the review Page.
async function captureAndOpenReview(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(fixture.url);
  await expect(page.getByRole('heading', { name: 'Buggy App' })).toBeVisible();
  await page.bringToFront(); // captureVisibleTab needs the tab visible/focused
  await page.waitForTimeout(500); // collect console error + failed request

  const reviewPagePromise = context.waitForEvent('page');
  await serviceWorker.evaluate(async (url: string) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => typeof t.url === 'string' && t.url.startsWith(url));
    // Fire-and-forget: finishCapture packages + saves + opens the review tab,
    // and only THEN responds — awaiting here would race the tab open.
    if (tab?.id !== undefined) void chrome.tabs.sendMessage(tab.id, { type: 'capture:finish' });
  }, fixture.url);

  const reviewPage = await reviewPagePromise;
  await reviewPage.waitForLoadState('domcontentloaded');
  return reviewPage;
}

test('captures a bug on a live page and opens the review screen', async () => {
  const reviewPage = await captureAndOpenReview();
  expect(reviewPage.url()).toContain('review.html?id=');
  await expect(reviewPage.locator('#title')).toBeVisible();
  expect((await reviewPage.locator('#title').inputValue()).length).toBeGreaterThan(0);
});

test('generates a Playwright regression test from the capture', async () => {
  const reviewPage = await captureAndOpenReview();
  const genBtn = reviewPage.locator('#gen-test');
  await expect(genBtn).toBeVisible();
  await genBtn.click();
  await expect(reviewPage.locator('#rv-test-code')).toContainText('@playwright/test', { timeout: 25_000 });
});
