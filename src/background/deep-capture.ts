import type { NetworkEntry } from '@shared/types';
import { uid } from '@shared/uid';

// Opt-in deep capture via the Chrome DevTools Protocol (PRD §8 dual-mode).
// The monkey-patch (MAIN world) is frictionless but can't see requests fired
// before injection or bodies the page never exposes. CDP can — at the cost of
// the "Gotcha is debugging this tab" banner, hence opt-in.
//
// The service worker is ephemeral, so completed entries are flushed to
// chrome.storage.session as they finish — the in-flight map is the only thing
// lost on eviction, and the user is mid-session when that's unlikely.

const PROTOCOL = '1.3';
const MAX_BODY = 65_536;

interface Pending {
  url: string;
  method: string;
  status: number;
  statusText?: string | undefined;
  requestHeaders?: Record<string, string> | undefined;
  responseHeaders?: Record<string, string> | undefined;
  requestBody?: string | undefined;
  ts: number;
}

const pending = new Map<string, Pending>(); // requestId → partial
const attached = new Set<number>(); // tabIds currently deep-captured

const key = (tabId: number): string => `deep:${tabId}`;

function clip(text: string): string {
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}…` : text;
}

async function appendEntry(tabId: number, entry: NetworkEntry): Promise<void> {
  const k = key(tabId);
  const stored = ((await chrome.storage.session.get(k))[k] as NetworkEntry[] | undefined) ?? [];
  stored.push(entry);
  await chrome.storage.session.set({ [k]: stored });
}

function onEvent(source: chrome.debugger.Debuggee, method: string, params?: object): void {
  const tabId = source.tabId;
  if (tabId === undefined || !attached.has(tabId)) return;
  void route(tabId, method, params as Record<string, unknown>);
}

async function route(tabId: number, method: string, p: Record<string, unknown>): Promise<void> {
  if (method === 'Network.requestWillBeSent') {
    const req = p.request as { url: string; method: string; headers: Record<string, string>; postData?: string };
    pending.set(p.requestId as string, {
      url: req.url,
      method: req.method,
      status: 0,
      requestHeaders: req.headers,
      requestBody: req.postData ? clip(req.postData) : undefined,
      ts: Date.now(),
    });
  } else if (method === 'Network.responseReceived') {
    const entry = pending.get(p.requestId as string);
    const resp = p.response as { status: number; statusText: string; headers: Record<string, string> };
    if (entry) {
      entry.status = resp.status;
      entry.statusText = resp.statusText;
      entry.responseHeaders = resp.headers;
    }
  } else if (method === 'Network.loadingFinished') {
    await finishRequest(tabId, p.requestId as string);
  }
}

async function finishRequest(tabId: number, requestId: string): Promise<void> {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  let responseBody: string | undefined;
  try {
    const body = (await chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', {
      requestId,
    })) as { body: string; base64Encoded: boolean };
    responseBody = body.base64Encoded ? '[binary body omitted]' : clip(body.body);
  } catch {
    responseBody = undefined;
  }
  await appendEntry(tabId, {
    id: uid(),
    url: entry.url,
    method: entry.method,
    status: entry.status,
    statusText: entry.statusText,
    requestHeaders: entry.requestHeaders,
    responseHeaders: entry.responseHeaders,
    requestBody: entry.requestBody,
    responseBody,
    durationMs: Date.now() - entry.ts,
    failed: entry.status === 0 || entry.status >= 400,
    ts: entry.ts,
  });
}

let listenerBound = false;
function bindListener(): void {
  if (listenerBound) return;
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) attached.delete(source.tabId);
  });
  listenerBound = true;
}

export async function enableDeep(tabId: number): Promise<void> {
  bindListener();
  await chrome.debugger.attach({ tabId }, PROTOCOL);
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
  attached.add(tabId);
  await chrome.storage.session.remove(key(tabId));
}

export async function disableDeep(tabId: number): Promise<void> {
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // already detached
  }
}

export function isDeep(tabId: number): boolean {
  return attached.has(tabId);
}

// Full-page screenshot via CDP (feature F2). Only works while deep-capture is
// attached; captures beyond the viewport in one shot — far cleaner than
// scroll-and-stitch. Returns a PNG data URL, or null if unavailable.
export async function fullPageScreenshot(tabId: number): Promise<string | null> {
  if (!attached.has(tabId)) return null;
  try {
    const result = (await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    })) as { data: string };
    return result.data ? `data:image/png;base64,${result.data}` : null;
  } catch {
    return null;
  }
}

// Pull collected deep entries for a tab and clear them. Called at finish so the
// bundle gets full-body + pre-injection requests the monkey-patch missed.
export async function collectDeep(tabId: number): Promise<NetworkEntry[]> {
  const k = key(tabId);
  const stored = ((await chrome.storage.session.get(k))[k] as NetworkEntry[] | undefined) ?? [];
  await chrome.storage.session.remove(k);
  return stored;
}
