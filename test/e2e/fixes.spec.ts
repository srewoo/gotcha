import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, type Fixture } from './fixture-server';

// Live-browser smoke tests for the high-risk fixes unit tests can't fully reach:
// the streaming-hang fetch fix, the cross-frame (all_frames) relay that replaced
// window.postMessage, cross-origin CSS + web-font data-URI inlining, and the
// review/dashboard UI shells.
//
// NOTE: the injected hooks emit at document_start, but a page's load-time
// console/fetch can fire before the ISOLATED content script's message listener
// is ready, so those earliest events are dropped (a pre-existing capture
// characteristic). These tests therefore trigger their signals AFTER load via
// evaluate(), which is when real interactive bugs occur anyway.

const EXT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');

let context: BrowserContext;
let serviceWorker: Worker;
let fixture: Fixture;

test.beforeAll(async () => {
  fixture = await startFixtureServer();
  // MV3 service workers only register under HEADED Chromium.
  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
    ],
  });
  serviceWorker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  // Always-on visual recording → replay keyframes exist, so cross-origin CSS
  // enrichment has a seed snapshot to attach the inlined font to.
  await serviceWorker.evaluate(() =>
    chrome.storage.local.set({ instantReplay: true, captureUserEvents: true }),
  );
});

test.afterAll(async () => {
  await context?.close();
  await fixture?.close();
});

async function openApp(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(fixture.url);
  await expect(page.getByRole('heading', { name: 'Buggy App' })).toBeVisible();
  // Let the content scripts install, instant-replay emit its first keyframe, the
  // cross-origin stylesheet load, and the sub-frame's content script attach.
  await page.waitForTimeout(900);
  return page;
}

async function captureReview(page: Page): Promise<Page> {
  await page.bringToFront(); // captureVisibleTab needs the tab focused
  const reviewPagePromise = context.waitForEvent('page');
  await serviceWorker.evaluate(async (url: string) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => typeof t.url === 'string' && t.url.startsWith(url));
    if (tab?.id !== undefined) void chrome.tabs.sendMessage(tab.id, { type: 'capture:finish' });
  }, fixture.url);
  const reviewPage = await reviewPagePromise;
  await reviewPage.waitForLoadState('domcontentloaded');
  await expect(reviewPage.locator('#title')).toBeVisible();
  return reviewPage;
}

// Read the persisted bundle from the extension store via the review page's
// chrome.runtime (same extension origin).
async function getBundle(reviewPage: Page): Promise<any> {
  return reviewPage.evaluate(async () => {
    const id = new URL(location.href).searchParams.get('id');
    const res: any = await chrome.runtime.sendMessage({ type: 'bundle:get', id });
    return res?.bundle ?? null;
  });
}

test('a streaming fetch resolves on the page and is captured without hanging', async () => {
  const page = await openApp();
  // Kick off an endless same-origin stream AFTER load. The hook must return the
  // Response without draining the (never-ending) body, so the page promise
  // resolves promptly — the old inline `await clone.text()` hung here forever.
  await page.evaluate(() => {
    (window as { __streamReturned?: boolean }).__streamReturned = false;
    void fetch('/stream').then(() => {
      (window as { __streamReturned?: boolean }).__streamReturned = true;
    });
  });
  await expect
    .poll(() => page.evaluate(() => (window as { __streamReturned?: boolean }).__streamReturned === true), {
      timeout: 2000,
    })
    .toBe(true);

  // The detached body read emits the entry after its ~3s budget — wait past it,
  // then confirm the hook captured the streamed request (proving it processed
  // the response, not merely that native fetch resolved on headers).
  await page.waitForTimeout(3500);
  const reviewPage = await captureReview(page);
  const bundle = await getBundle(reviewPage);
  const urls = (bundle.network ?? []).map((n: { url: string }) => n.url);
  expect(urls.some((u: string) => u.endsWith('/stream'))).toBe(true);
  await page.close();
  await reviewPage.close();
});

test('captures a cross-origin sub-frame error via the runtime relay', async () => {
  const page = await openApp();
  const frame = page.frames().find((f) => f.url().includes('/frame.html'));
  expect(frame, 'cross-origin sub-frame should be present').toBeTruthy();
  // Fire in the sub-frame post-load: its MAIN-world hook → its content script →
  // chrome.runtime frame:event → worker → top frame (frameId 0) → buffers.
  await frame!.evaluate(() => console.error('subframe boom: widget failed to init'));
  await page.waitForTimeout(500);

  const reviewPage = await captureReview(page);
  const bundle = await getBundle(reviewPage);
  const messages = (bundle.console ?? []).map((c: { message: string }) => c.message).join('\n');
  expect(messages).toContain('subframe boom');
  await page.close();
  await reviewPage.close();
});

test('inlines a cross-origin web font as a data URI in the replay snapshot', async () => {
  const page = await openApp();
  const reviewPage = await captureReview(page);
  const bundle = await getBundle(reviewPage);
  const snapHtml = (bundle.replay ?? [])
    .filter((e: { kind: string; html?: string }) => e.kind === 'snapshot' && e.html)
    .map((e: { html: string }) => e.html)
    .join('');
  // The worker fetched the no-CORS CDN sheet (data-gotcha-xorigin marker) and
  // inlined its @font-face source as a CORS-free data: URI.
  expect(snapHtml).toContain('data-gotcha-xorigin');
  expect(snapHtml).toContain('data:font/woff2;base64,');
  await page.close();
  await reviewPage.close();
});

test('persists an edited report title to the store', async () => {
  const page = await openApp();
  const reviewPage = await captureReview(page);

  await reviewPage.fill('#title', 'Edited title — regression');
  await reviewPage.locator('#title').blur(); // fire change → bundle:setSteps{title}

  await expect
    .poll(
      () =>
        reviewPage.evaluate(async () => {
          const bid = new URL(location.href).searchParams.get('id');
          const res: any = await chrome.runtime.sendMessage({ type: 'bundle:get', id: bid });
          return res?.bundle?.title ?? '';
        }),
      { timeout: 8000 },
    )
    .toBe('Edited title — regression');

  await page.close();
  await reviewPage.close();
});

test('deep capture attaches the debugger (required permission is granted)', async () => {
  // Regression for the Chrome "debugger cannot be optional" omission: with
  // 'debugger' now a required permission, deep:enable must actually attach.
  const page = await openApp();
  await page.bringToFront();
  const tabId = await serviceWorker.evaluate(async (url: string) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => typeof t.url === 'string' && t.url.startsWith(url))?.id;
  }, fixture.url);
  expect(tabId).toBeTruthy();

  // Drive the worker from a SEPARATE extension page — chrome.runtime.sendMessage
  // from the worker's own context doesn't reach its own onMessage listener.
  const helpUrl = await serviceWorker.evaluate(() => chrome.runtime.getURL('src/help/help.html'));
  const sender = await context.newPage();
  await sender.goto(helpUrl);

  // deep:enable returning deep:true proves chrome.debugger.attach worked — which
  // is only possible because 'debugger' is granted. If Chrome had omitted the
  // permission (the optional-permission bug), chrome.debugger would be undefined
  // and enableDeep would fail instead. We don't assert deep:status afterwards:
  // Playwright itself drives Chrome over CDP and contends for the tab's single
  // debugger client, so the attach can be torn down immediately in-harness.
  const enable = await sender.evaluate(
    (id) => chrome.runtime.sendMessage({ type: 'deep:enable', tabId: id }) as Promise<any>,
    tabId,
  );
  expect(enable?.ok).toBe(true);
  expect(enable?.deep).toBe(true);

  await sender.evaluate(
    (id) => chrome.runtime.sendMessage({ type: 'deep:disable', tabId: id }) as Promise<any>,
    tabId,
  );
  await sender.close();
  await page.close();
});

test('dashboard lists a captured report and deletes it', async () => {
  const page = await openApp();
  const reviewPage = await captureReview(page);
  await reviewPage.close();

  const dashUrl = await serviceWorker.evaluate(() =>
    chrome.runtime.getURL('src/dashboard/dashboard.html'),
  );
  const dash = await context.newPage();
  dash.on('dialog', (d) => void d.accept()); // deleteReport() guards with confirm()
  await dash.goto(dashUrl);
  const rows = dash.locator('tr[data-id]');
  await expect(rows.first()).toBeVisible({ timeout: 8000 });
  const before = await rows.count();
  expect(before).toBeGreaterThan(0);

  await dash.locator('.del-btn').first().click();
  await expect.poll(() => rows.count(), { timeout: 8000 }).toBe(before - 1);

  await page.close();
  await dash.close();
});
