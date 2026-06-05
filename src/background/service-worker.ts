import type {
  RuntimeMessage,
  RuntimeResponse,
  WorkerMessage,
  WorkerResponse,
  IntegrationId,
} from '@shared/messaging';
import { CaptureBundle } from '@shared/types';
import { bundleDb } from '../content/db';
import { redactBundle } from '@shared/redact';
import { getIntegration } from '../integrations';
import { enableDeep, disableDeep, isDeep, collectDeep, fullPageScreenshot } from './deep-capture';
import { analyzeBundle, analyzeBundleStream, getAiConfig, chat } from '../ai/llm';
import { findDuplicates } from '../ai/duplicates';
import { setExtraRedactionPatterns } from '@shared/redact';
import { absolutizeCss } from '@shared/css-util';

// Cap on cross-origin CSS we inline per capture, mirroring the in-page budget.
const MAX_XORIGIN_CSS = 1_500_000;
const CSS_FETCH_TIMEOUT_MS = 4000;

// Ephemeral by design — holds NO capture state (PRD §8). Every handler reads
// from / writes to the durable IndexedDB store or chrome.storage and returns.
type AnyMessage = RuntimeMessage | WorkerMessage;
type AnyResponse = RuntimeResponse | WorkerResponse;

chrome.runtime.onMessage.addListener(
  (message: AnyMessage, sender, sendResponse: (r: AnyResponse) => void) => {
    void handle(message, sender)
      .then(sendResponse)
      .catch((err: unknown) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
    return true; // async
  },
);

// Fetch stylesheets the page context couldn't read (opaque cross-origin → CORS,
// or blocked by the page's CSP connect-src). The worker isn't subject to either
// and has <all_urls> host permission, so it fetches with credentials (cookies)
// to also resolve auth-gated CSS. Best-effort: failures are silently omitted.
async function fetchCrossOriginCss(
  sheets: { href: string }[],
): Promise<WorkerResponse> {
  const css: Record<string, string> = {};
  let total = 0;
  const work = sheets.map(async ({ href }) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CSS_FETCH_TIMEOUT_MS);
      const res = await fetch(href, { credentials: 'include', signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return;
      const text = await res.text();
      if (text && total < MAX_XORIGIN_CSS) {
        const slice = text.slice(0, MAX_XORIGIN_CSS - total);
        css[href] = absolutizeCss(slice, href);
        total += slice.length;
      }
    } catch {
      // CORS-after-all, network error, abort — leave it out.
    }
  });
  await Promise.allSettled(work);
  return { type: 'css:fetched', ok: true, css };
}

async function handle(
  message: AnyMessage,
  sender: chrome.runtime.MessageSender,
): Promise<AnyResponse> {
  switch (message.type) {
    case 'screenshot:capture':
      return captureScreenshot(sender);

    case 'bundle:save':
      return saveBundle(message.bundle, sender);

    case 'css:fetch':
      return fetchCrossOriginCss(message.sheets);

    case 'bundle:list': {
      // Reads the lightweight summary index only — never loads heavy payloads.
      const summaries = await bundleDb.summaries();
      const bundles = summaries.sort((a, b) => b.createdAt - a.createdAt);
      return { ok: true, bundles };
    }

    case 'bundle:get': {
      const bundle = await bundleDb.get(message.id);
      if (!bundle) return { ok: false, error: 'Bundle not found' };
      return { ok: true, bundle };
    }

    case 'bundle:delete':
      await bundleDb.delete(message.id);
      return { ok: true };

    case 'bundle:attachTest': {
      const bundle = await bundleDb.get(message.id);
      if (!bundle) return { ok: false, error: 'Bundle not found' };
      bundle.generatedTest = { filename: message.filename, source: message.source };
      await bundleDb.put(bundle);
      return { ok: true };
    }

    case 'bundle:setScreenshot': {
      const bundle = await bundleDb.get(message.id);
      if (!bundle) return { ok: false, error: 'Bundle not found' };
      bundle.screenshotDataUrl = message.dataUrl;
      await bundleDb.put(bundle);
      return { ok: true };
    }

    case 'bundle:setSteps': {
      const bundle = await bundleDb.get(message.id);
      if (!bundle) return { ok: false, error: 'Bundle not found' };
      bundle.steps = message.steps;
      await bundleDb.put(bundle);
      return { ok: true };
    }

    case 'bundle:file':
      return fileBundle(message.id, message.redact, message.integration);

    case 'integration:test':
      return testIntegration(message.id);

    case 'deep:enable': {
      const tabId = message.tabId ?? (await activeTabId());
      if (tabId === undefined) return { ok: false, error: 'No active tab' };
      await enableDeep(tabId);
      return { ok: true, deep: true };
    }

    case 'deep:disable': {
      const tabId = message.tabId ?? (await activeTabId());
      if (tabId === undefined) return { ok: false, error: 'No active tab' };
      await disableDeep(tabId);
      return { ok: true, deep: false };
    }

    case 'deep:status': {
      const tabId = await activeTabId();
      return { ok: true, deep: tabId !== undefined && isDeep(tabId) };
    }

    case 'ai:available':
      return { ok: true, available: (await getAiConfig()) !== null };

    case 'ai:test':
      return testAi();

    case 'ai:analyze':
      return analyzeWithAi(message.id);

    case 'ai:duplicates':
      return findDupes(message.id);

    default:
      return { ok: false, error: `Unhandled message in worker: ${(message as { type: string }).type}` };
  }
}

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function captureScreenshot(
  sender: chrome.runtime.MessageSender,
): Promise<WorkerResponse> {
  const windowId = sender.tab?.windowId;
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(
      windowId ?? chrome.windows.WINDOW_ID_CURRENT,
      { format: 'png' },
    );
    return { type: 'screenshot', ok: true, dataUrl };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Screenshot failed' };
  }
}

async function saveBundle(
  raw: CaptureBundle,
  sender: chrome.runtime.MessageSender,
): Promise<WorkerResponse> {
  const parsed = CaptureBundle.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'Invalid bundle shape' };
  const bundle = parsed.data;

  // Merge any deep-capture (CDP) network entries — full bodies + pre-injection
  // requests the monkey-patch couldn't see. They supersede on duplicate URLs.
  const tabId = sender.tab?.id;
  if (tabId !== undefined && isDeep(tabId)) {
    const deep = await collectDeep(tabId);
    const seen = new Set(deep.map((d) => `${d.method} ${d.url} ${d.status}`));
    const shallow = bundle.network.filter((n) => !seen.has(`${n.method} ${n.url} ${n.status}`));
    bundle.network = [...deep, ...shallow].sort((a, b) => a.ts - b.ts);
  }

  // Attach the screenshot now — only the worker can call captureVisibleTab,
  // and the originating tab is still the active/visible one at finish time.
  // In deep mode, prefer a true full-page CDP screenshot (feature F2).
  const full = tabId !== undefined ? await fullPageScreenshot(tabId) : null;
  if (full) {
    bundle.screenshotDataUrl = full;
  } else {
    const shot = await captureScreenshot(sender);
    if (shot.ok && shot.type === 'screenshot') bundle.screenshotDataUrl = shot.dataUrl;
  }

  await bundleDb.put(bundle);
  const reviewUrl = chrome.runtime.getURL(`src/review/review.html?id=${bundle.id}`);
  await chrome.tabs.create({ url: reviewUrl });
  return { type: 'bundle:saved', ok: true, reviewUrl };
}

async function fileBundle(
  id: string,
  redact: boolean,
  integrationId: IntegrationId,
): Promise<RuntimeResponse> {
  const stored = await bundleDb.get(id);
  if (!stored) return { ok: false, error: 'Bundle not found' };
  if (redact) await primeRedaction();
  const bundle = redact ? redactBundle(stored) : stored;

  const result = await getIntegration(integrationId).file(bundle);
  bundle.filed = {
    integration: result.integration,
    identifier: result.identifier,
    url: result.url,
    at: Date.now(),
  };
  await bundleDb.put(bundle); // persist redaction + filed metadata
  return { ok: true, filed: result };
}

// AI triage. We ALWAYS redact before sending to a third-party model, regardless
// of the per-report file toggle — the bundle leaving the browser to an external
// LLM is exactly the trust boundary redaction exists for. Result is cached on
// the bundle so re-opening doesn't re-bill the user's key.
async function analyzeWithAi(id: string): Promise<RuntimeResponse> {
  const cfg = await getAiConfig();
  if (!cfg) return { ok: false, error: 'No AI key configured — add one in Settings.' };
  const stored = await bundleDb.get(id);
  if (!stored) return { ok: false, error: 'Bundle not found' };
  await primeRedaction();
  const analysis = await analyzeBundle(redactBundle(stored), cfg);
  stored.aiAnalysis = analysis;
  await bundleDb.put(stored);
  return { ok: true, analysis };
}

async function findDupes(id: string): Promise<RuntimeResponse> {
  const cfg = await getAiConfig();
  if (!cfg) return { ok: false, error: 'No AI key configured — add one in Settings.' };
  const current = await bundleDb.get(id);
  if (!current) return { ok: false, error: 'Bundle not found' };
  await primeRedaction();
  // Duplicate detection fingerprints network/console, so it needs full bundles
  // (not summaries). Bounded by the MAX_REPORTS cap.
  const all = await bundleDb.allBundles();
  const duplicates = await findDuplicates(current, all, cfg);
  return { ok: true, duplicates };
}

// Validate an integration's stored credentials (feature: per-integration test).
async function testIntegration(id: IntegrationId): Promise<RuntimeResponse> {
  try {
    const result = await getIntegration(id).test();
    return result.ok ? { ok: true } : { ok: false, error: result.detail ?? 'Connection failed' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' };
  }
}

// Validate the configured AI key with a tiny round-trip (feature F5).
async function testAi(): Promise<RuntimeResponse> {
  const cfg = await getAiConfig();
  if (!cfg) return { ok: false, error: 'No AI key configured.' };
  const reply = await chat(cfg, 'You are a connectivity check.', "Reply with the single word: OK");
  return reply.trim().length > 0
    ? { ok: true }
    : { ok: false, error: 'Empty reply from provider' };
}

// Load user-defined redaction patterns (feature F7) into the redactor before
// any redact runs. Worker is ephemeral, so we prime on each send path.
async function primeRedaction(): Promise<void> {
  const { redactExtraPatterns } = await chrome.storage.local.get('redactExtraPatterns');
  setExtraRedactionPatterns(String(redactExtraPatterns ?? '').split('\n'));
}

// Streaming analysis (#5) over a long-lived Port: deltas as they arrive, then a
// final structured result. Same redact-before-send guarantee as analyzeWithAi.
chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('ai:analyze:')) return;
  const id = port.name.slice('ai:analyze:'.length);
  void (async () => {
    try {
      const cfg = await getAiConfig();
      if (!cfg) throw new Error('No AI key configured — add one in Settings.');
      const stored = await bundleDb.get(id);
      if (!stored) throw new Error('Bundle not found');
      const analysis = await analyzeBundleStream(redactBundle(stored), cfg, (delta) =>
        port.postMessage({ type: 'delta', delta }),
      );
      stored.aiAnalysis = analysis;
      await bundleDb.put(stored);
      port.postMessage({ type: 'done', analysis });
    } catch (err) {
      port.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
    } finally {
      port.disconnect();
    }
  })();
});

// Keyboard shortcut (feature F1): one-shot capture of the active tab.
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'capture-bug') return;
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'capture:finish' });
    } catch {
      // No content script on this tab (chrome:// etc.) — nothing to capture.
    }
  })();
});

