import {
  isBridgeMessage,
  isFrameForward,
  CONTROL_MARKER,
  FRAME_FWD_MARKER,
} from '@shared/messaging';
import type {
  BridgeMessage,
  RuntimeMessage,
  RuntimeResponse,
  WorkerMessage,
  WorkerResponse,
} from '@shared/messaging';
import { RETENTION_MS, SHARE_WINDOW_MS } from '@shared/capture-config';
import type { CaptureBundle } from '@shared/types';
import { BufferStore } from './buffer-store';
import { packageBundle } from './packager';
import { CaptureWidget } from './widget';

// ISOLATED-world content script. Runs in every frame (all_frames), but only the
// TOP frame owns the buffers, widget, and capture lifecycle. Sub-frames forward
// the events their MAIN-world hooks emit up to the top frame (issue #6).
const isTop = window === window.top;

let paused = false; // widget pause/resume (feature F6)
let denied = false; // capture disabled on this domain (feature F7)
let captureUserEvents = true; // record clicks/nav as repro steps (setting; default on)
let alwaysOnReplay = false; // always-on visual replay (Instant Replay / Share last minute)
let sessionActive = false; // an explicit recording session is in progress (vs retroactive)

const buffers = new BufferStore();
const widget = new CaptureWidget(
  () => void finishCapture(),
  (next) => {
    // Pause/resume: stop buffering + replay while paused (feature F6).
    paused = next;
    replayControl(!next);
  },
);

// Control the MAIN-world replay recorder. 'replay-on' = fresh session,
// 'replay-always-on' = always-on Instant Replay, 'replay-off' = tear down.
function postControl(action: 'replay-on' | 'replay-off' | 'replay-always-on'): void {
  window.postMessage({ marker: CONTROL_MARKER, action }, '*');
}
function replayControl(on: boolean): void {
  postControl(on ? 'replay-on' : 'replay-off');
}
// After a session ends, resume always-on Instant Replay if it's enabled.
function rearmAlwaysOn(): void {
  if (alwaysOnReplay && !denied) postControl('replay-always-on');
}

// Console/network/steps buffer always-on for retroactive one-click capture.
buffers.start();

// Load capture settings. Deny-domains (feature F7) gate all buffering; the
// Instant Replay / Share-last-minute toggles start the always-on visual
// recorder and rolling retention.
void chrome.storage.local
  .get(['captureDenyDomains', 'instantReplay', 'shareLastMinute', 'captureUserEvents'])
  .then((s) => {
    const list = String(s.captureDenyDomains ?? '')
      .split(/[\n,]/)
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    denied = list.some((d) => location.hostname === d || location.hostname.endsWith(`.${d}`));

    captureUserEvents = s.captureUserEvents !== false; // default on

    // Always-on visual replay backs both Instant Replay and the retroactive
    // visual replay in "Share last minute". Top frame only (sub-frame replay is
    // not captured), and never on opted-out domains.
    alwaysOnReplay = s.instantReplay === true || s.shareLastMinute === true;
    if (isTop && alwaysOnReplay && !denied) {
      buffers.enableRetention(RETENTION_MS);
      postControl('replay-always-on');
    }
  });

function bufferBridge(data: BridgeMessage): void {
  if (denied || paused) return;
  switch (data.type) {
    case 'console':
      buffers.console.push(data.entry);
      break;
    case 'network':
      buffers.network.push(data.entry);
      break;
    case 'step':
      // "Capture User Events": clicks/navigation/etc. recorded as repro steps.
      if (captureUserEvents) buffers.steps.push(data.step);
      break;
    case 'replay':
      buffers.pushReplay(data.event);
      break;
  }
  if (widget.mounted) widget.update(buffers.status());
}

// ─── MAIN world (this frame) + forwarded sub-frame events → buffers ──────────
window.addEventListener('message', (event) => {
  if (event.source === window && isBridgeMessage(event.data)) {
    if (isTop) bufferBridge(event.data);
    else window.top?.postMessage({ marker: FRAME_FWD_MARKER, payload: event.data }, '*');
    return;
  }
  // Top frame: events forwarded up from a sub-frame.
  if (isTop && isFrameForward(event.data)) bufferBridge(event.data.payload);
});

// Only the top frame talks to the popup/worker — sub-frames must not respond
// (chrome.tabs.sendMessage fans out to all frames; multiple responders race).
if (isTop) {
  chrome.runtime.onMessage.addListener(
    (message: RuntimeMessage, _sender, sendResponse: (r: RuntimeResponse) => void) => {
      void handle(message).then(sendResponse).catch((err: unknown) => {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      });
      return true; // async response
    },
  );
}

async function handle(message: RuntimeMessage): Promise<RuntimeResponse> {
  if (denied && (message.type === 'capture:start' || message.type === 'capture:finish')) {
    return { ok: false, error: 'Capture is disabled on this domain (Gotcha settings)' };
  }
  switch (message.type) {
    case 'capture:start':
      // Begin a clean, visible recording session: tear down any always-on
      // recorder, reset buffers so the repro steps start fresh, mount the
      // widget, and start a fresh session replay recording (epoch reset → t=0).
      replayControl(false);
      buffers.reset();
      buffers.start();
      paused = false;
      sessionActive = true;
      replayControl(true);
      widget.mount(buffers.startedAt ?? Date.now());
      widget.update(buffers.status());
      return { ok: true, status: buffers.status() };

    case 'capture:stop':
      buffers.stop();
      sessionActive = false;
      replayControl(false);
      widget.unmount();
      // Discard the abandoned session and resume always-on capture cleanly.
      if (alwaysOnReplay) buffers.reset();
      rearmAlwaysOn();
      return { ok: true, status: buffers.status() };

    case 'capture:status':
      return { ok: true, status: buffers.status() };

    case 'capture:finish':
      return finishCapture();

    case 'capture:shareLastMinute':
      return shareLastMinute();

    default:
      return { ok: false, error: `Unhandled message in content: ${message.type}` };
  }
}

// Inline cross-origin stylesheets the page context couldn't read (opaque CORS /
// blocked by CSP) into the replay's seed snapshot, fetched via the worker (which
// has <all_urls> permission and isn't CORS/CSP-bound). The player carries the
// seed snapshot's <head> into every frame, so one injection styles the whole
// replay. Best-effort: never blocks or fails the save.
async function enrichCrossOriginCss(bundle: CaptureBundle): Promise<void> {
  try {
    const replay = bundle.replay;
    if (!replay || replay.length === 0) return;

    // The snapshot the player reads <head> styles from: the last full snapshot
    // at the initial timestamp (mirrors replay.ts's headSource selection).
    const snapshots = replay.filter((e) => e.kind === 'snapshot' && e.html != null);
    if (snapshots.length === 0) return;
    const initialT = snapshots[0]!.t;
    const seed = snapshots.filter((e) => e.t === initialT).pop() ?? snapshots[0]!;
    if (seed.html == null || !seed.html.includes('</head>')) return;

    // Hrefs of stylesheets whose rules the page context can't read (the recorder
    // already inlined the readable + adopted ones).
    const sheets: { href: string }[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      if (!sheet.href) continue;
      try {
        void sheet.cssRules; // readable → already inlined; skip
      } catch {
        sheets.push({ href: sheet.href });
      }
    }
    if (sheets.length === 0) return;

    const res = (await chrome.runtime.sendMessage({
      type: 'css:fetch',
      sheets,
    } satisfies WorkerMessage)) as WorkerResponse | undefined;
    if (!res || !res.ok || res.type !== 'css:fetched') return;

    const css = Object.values(res.css).join('\n');
    if (!css) return;
    seed.html = seed.html.replace('</head>', `<style data-gotcha-xorigin>${css}</style></head>`);
  } catch {
    // Never let CSS enrichment block the capture.
  }
}

// Package the bundle (we hold the DOM + buffers here) and hand persistence to
// the worker, which owns the extension-origin store and the screenshot API.
// Invoked both from the popup's one-click path and the widget's Finish button.
async function finishCapture(): Promise<RuntimeResponse> {
  if (denied) return { ok: false, error: 'Capture is disabled on this domain (Gotcha settings)' };
  // In a session the buffers already hold a clean t=0 timeline. For a retroactive
  // one-click capture with Instant Replay on, slice+rebase the retained window so
  // the replay player gets a 0-based, seekable timeline.
  const source =
    !sessionActive && alwaysOnReplay ? buffers.sliceWindow(RETENTION_MS) : buffers;
  const bundle = packageBundle(source);
  await enrichCrossOriginCss(bundle);
  const saved = (await chrome.runtime.sendMessage({
    type: 'bundle:save',
    bundle,
  } satisfies WorkerMessage)) as WorkerResponse | undefined;
  widget.unmount();
  replayControl(false);
  paused = false;
  sessionActive = false;
  buffers.reset();
  buffers.start();
  rearmAlwaysOn();
  if (!saved || !saved.ok) {
    return { ok: false, error: saved && !saved.ok ? saved.error : 'Failed to save bundle' };
  }
  if (saved.type !== 'bundle:saved') return { ok: false, error: 'Unexpected save response' };
  return { ok: true, reviewUrl: saved.reviewUrl };
}

// "Share last minute": package only the trailing SHARE_WINDOW_MS of everything
// (logs, network, steps, and re-based visual replay) and open review — without a
// recording session and without disturbing the ongoing always-on capture.
async function shareLastMinute(): Promise<RuntimeResponse> {
  if (denied) return { ok: false, error: 'Capture is disabled on this domain (Gotcha settings)' };
  const bundle = packageBundle(buffers.sliceWindow(SHARE_WINDOW_MS));
  await enrichCrossOriginCss(bundle);
  const saved = (await chrome.runtime.sendMessage({
    type: 'bundle:save',
    bundle,
  } satisfies WorkerMessage)) as WorkerResponse | undefined;
  if (!saved || !saved.ok) {
    return { ok: false, error: saved && !saved.ok ? saved.error : 'Failed to save bundle' };
  }
  if (saved.type !== 'bundle:saved') return { ok: false, error: 'Unexpected save response' };
  return { ok: true, reviewUrl: saved.reviewUrl };
}
