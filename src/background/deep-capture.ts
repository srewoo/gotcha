import type { NetworkEntry, ScreencastFrame } from '@shared/types';
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
const MAX_BODY = 131_072;

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

// ─── Screencast (true-pixel video) state ──────────────────────────────────────
// Frames are large, so they're held in memory (not flushed per-frame to session
// storage — that'd be O(n²) re-writes). A worker eviction mid-repro loses them,
// the same accepted tradeoff as the in-flight `pending` map. Bounded by count.
const MAX_SCREENCAST_FRAMES = 150;
const screencast = new Map<number, ScreencastFrame[]>(); // tabId → frames
const screencastStart = new Map<number, number>(); // tabId → epoch (Date.now at start)

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
  // route() awaits CDP/storage calls that can reject; swallow so a single failed
  // event can't surface as an unhandled rejection in the worker.
  void route(tabId, method, params as Record<string, unknown>).catch(() => {});
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
  } else if (method === 'Page.screencastFrame') {
    await onScreencastFrame(tabId, p);
  }
}

// Store a screencast frame (capped) and ACK it so CDP sends the next one.
// Without the ack, Chrome stops emitting frames after a few.
async function onScreencastFrame(tabId: number, p: Record<string, unknown>): Promise<void> {
  const sessionId = p.sessionId as number;
  const data = p.data as string; // base64 JPEG (no data: prefix)
  const frames = screencast.get(tabId);
  if (frames && data && frames.length < MAX_SCREENCAST_FRAMES) {
    const epoch = screencastStart.get(tabId) ?? Date.now();
    frames.push({ t: Date.now() - epoch, data: `data:image/jpeg;base64,${data}` });
  }
  // Always ack (even when we drop the frame) so the stream keeps flowing.
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.screencastFrameAck', { sessionId });
  } catch {
    // tab detached mid-stream — ignore
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
  // `debugger` is an OPTIONAL permission (requested only when the user enables
  // deep capture), so `chrome.debugger` is undefined until it's granted.
  // Accessing it unconditionally at module load would throw and crash the whole
  // service worker. Bail out safely until the API is present — enableDeep()
  // re-invokes this after the permission is granted.
  if (listenerBound || !chrome.debugger?.onEvent) return;
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) attached.delete(source.tabId);
  });
  listenerBound = true;
}

// Best-effort synchronous bind on worker startup (MV3): if the debugger
// permission is already granted, a revived worker can route events for a
// still-attached tab. A no-op when the permission isn't granted yet.
bindListener();

export async function enableDeep(tabId: number): Promise<void> {
  bindListener();
  await chrome.debugger.attach({ tabId }, PROTOCOL);
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
  attached.add(tabId);
  await chrome.storage.session.remove(key(tabId));
  // Start the true-pixel screencast. Downscaled + JPEG + everyNthFrame keep the
  // payload bounded; frames accumulate in memory until finish.
  screencast.set(tabId, []);
  screencastStart.set(tabId, Date.now());
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
    await chrome.debugger.sendCommand({ tabId }, 'Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: 1280,
      maxHeight: 720,
      everyNthFrame: 2,
    });
  } catch {
    // Screencast is best-effort — deep network capture still works without it.
  }
}

export async function disableDeep(tabId: number): Promise<void> {
  attached.delete(tabId);
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.stopScreencast', {});
  } catch {
    // not screencasting / already detached
  }
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // already detached
  }
}

// Pull collected screencast frames for a tab and clear them. Called at finish.
export function collectScreencast(tabId: number): ScreencastFrame[] {
  const frames = screencast.get(tabId) ?? [];
  screencast.delete(tabId);
  screencastStart.delete(tabId);
  return frames;
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
