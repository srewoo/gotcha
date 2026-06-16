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
  // CDP keys pending requests by requestId only, so each entry remembers its
  // tab to allow correct per-tab cleanup on detach/disable.
  tabId: number;
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

// The in-memory `attached` Set dies with every MV3 worker eviction while the
// debugger stays attached to the tab — so the tab-id list is mirrored into
// chrome.storage.session (cleared on browser exit, like the entries) and
// rehydrated at module load. Without it, a revived worker drops every CDP
// event, reports deep:status off, and re-enable throws "already attached".
const ATTACHED_KEY = 'deep:attachedTabs';

async function persistAttached(): Promise<void> {
  try {
    await chrome.storage.session.set({ [ATTACHED_KEY]: [...attached] });
  } catch {
    // storage.session unavailable (shouldn't happen in MV3) — in-memory only.
  }
}

async function readPersistedAttached(): Promise<number[]> {
  try {
    const got = await chrome.storage.session.get(ATTACHED_KEY);
    const list = got[ATTACHED_KEY];
    return Array.isArray(list) ? (list as number[]) : [];
  } catch {
    return [];
  }
}

// ─── Screencast (true-pixel video) state ──────────────────────────────────────
// Frames are large, so they're held in memory (not flushed per-frame to session
// storage — that'd be O(n²) re-writes). A worker eviction mid-repro loses them,
// the same accepted tradeoff as the in-flight `pending` map. Bounded by count.
const MAX_SCREENCAST_FRAMES = 150;
// Hard cap on screencast (true-pixel video) LENGTH. Frames captured more than
// this many ms after the screencast started are dropped (still ack'd so the
// stream doesn't stall). Bounds memory + bundle size on long repro sessions.
const MAX_SCREENCAST_MS = 100_000; // 100 seconds
const screencast = new Map<number, ScreencastFrame[]>(); // tabId → frames
const screencastStart = new Map<number, number>(); // tabId → epoch (Date.now at start)

// Serializes session-storage writes for the entries key. Each completion used
// to spawn an unserialized read-modify-write chain; two requests finishing
// concurrently would both read the same stored array and the second `set`
// silently overwrote the first's entry. tabId → tail of the write chain.
const writeQueues = new Map<number, Promise<void>>();

function enqueueWrite(tabId: number, doAppend: () => Promise<void>): Promise<void> {
  const next = (writeQueues.get(tabId) ?? Promise.resolve()).then(doAppend).catch(() => {});
  writeQueues.set(tabId, next);
  return next;
}

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

// Drop all per-tab in-memory state. Called on disable AND on external detach so
// neither path leaks screencast frames, pending requests, or write queues.
function clearTabState(tabId: number): void {
  screencast.delete(tabId);
  screencastStart.delete(tabId);
  for (const [requestId, entry] of pending) {
    if (entry.tabId === tabId) pending.delete(requestId);
  }
  writeQueues.delete(tabId);
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
      tabId,
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
  } else if (method === 'Network.loadingFailed') {
    // CORS / DNS / abort / offline — the request never "finishes", so without
    // this branch the entry sat in `pending` forever and was never flushed.
    await failRequest(tabId, p.requestId as string, p);
  } else if (method === 'Page.screencastFrame') {
    await onScreencastFrame(tabId, p);
  }
}

// Rehydrate the attached-tab Set (and screencast acking state) after an MV3
// worker eviction. Events that arrive between worker revival and this async
// read completing are dropped — a window of a few ms, accepted: it's strictly
// better than dropping every event for the rest of the session.
async function rehydrate(): Promise<void> {
  // chrome.storage can be absent in non-extension test contexts — bail safely.
  if (!chrome.storage?.session) return;
  for (const tabId of await readPersistedAttached()) {
    attached.add(tabId);
    // Frames captured before the eviction are gone (in-memory by design), but
    // the screencast maps must exist again so frame acking resumes and the
    // CDP stream keeps flowing into the revived worker.
    if (!screencast.has(tabId)) {
      screencast.set(tabId, []);
      screencastStart.set(tabId, Date.now());
    }
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
    const t = Date.now() - epoch;
    // Drop frames past the 100s length cap (still ack'd below so CDP doesn't stall).
    if (t <= MAX_SCREENCAST_MS) {
      frames.push({ t, data: `data:image/jpeg;base64,${data}` });
    }
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
  await enqueueWrite(tabId, () =>
    appendEntry(tabId, {
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
    }),
  );
}

// Flush a request that failed at the network layer (Network.loadingFailed).
// There's no response body to fetch; the CDP errorText (e.g. net::ERR_FAILED)
// is surfaced as the statusText so the review page shows WHY it failed.
async function failRequest(tabId: number, requestId: string, p: Record<string, unknown>): Promise<void> {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  const statusText = p.canceled ? 'canceled' : String(p.errorText ?? 'net::ERR_FAILED');
  await enqueueWrite(tabId, () =>
    appendEntry(tabId, {
      id: uid(),
      url: entry.url,
      method: entry.method,
      status: entry.status,
      statusText,
      requestHeaders: entry.requestHeaders,
      responseHeaders: entry.responseHeaders,
      requestBody: entry.requestBody,
      durationMs: Date.now() - entry.ts,
      failed: true,
      ts: entry.ts,
    }),
  );
}

let listenerBound = false;
function bindListener(): void {
  // `debugger` is now a required permission, so `chrome.debugger` is normally
  // present at module load. The `?.` guard is kept as cheap defense-in-depth:
  // if the API is ever unavailable (e.g. a stripped test global), accessing it
  // unconditionally would throw and crash the whole service worker.
  if (listenerBound || !chrome.debugger?.onEvent) return;
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) {
      attached.delete(source.tabId);
      void persistAttached();
      clearTabState(source.tabId);
    }
  });
  listenerBound = true;
}

// Best-effort synchronous bind on worker startup (MV3): if the debugger
// permission is already granted, a revived worker can route events for a
// still-attached tab. A no-op when the permission isn't granted yet.
bindListener();
// Async rehydration of the attached set — see rehydrate() for the drop window.
void rehydrate().catch(() => {});

export async function enableDeep(tabId: number): Promise<void> {
  bindListener();
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL);
  } catch (err) {
    // "Another debugger is already attached" + the tab in OUR persisted set
    // means a worker eviction orphaned the attachment — recover by re-arming
    // the domains below instead of failing the user's re-enable.
    const msg = err instanceof Error ? err.message : String(err);
    const ours = (await readPersistedAttached()).includes(tabId);
    if (!/already attached/i.test(msg) || !ours) throw err;
  }
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
  } catch (err) {
    // Don't leave the debugger attached but untracked — that would make every
    // later enable fail with "already attached" with no way out.
    attached.delete(tabId);
    await persistAttached();
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // already detached
    }
    throw err;
  }
  attached.add(tabId);
  await persistAttached();
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
  await persistAttached();
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
  clearTabState(tabId);
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
  // Let any in-flight appendEntry writes land first so a request that finished
  // moments before the user hit "finish" isn't lost to the read-then-clear.
  await (writeQueues.get(tabId) ?? Promise.resolve());
  const k = key(tabId);
  const stored = ((await chrome.storage.session.get(k))[k] as NetworkEntry[] | undefined) ?? [];
  await chrome.storage.session.remove(k);
  return stored;
}
