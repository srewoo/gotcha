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
import { BufferStore } from './buffer-store';
import { packageBundle } from './packager';
import { CaptureWidget } from './widget';

// ISOLATED-world content script. Runs in every frame (all_frames), but only the
// TOP frame owns the buffers, widget, and capture lifecycle. Sub-frames forward
// the events their MAIN-world hooks emit up to the top frame (issue #6).
const isTop = window === window.top;

let paused = false; // widget pause/resume (feature F6)
let denied = false; // capture disabled on this domain (feature F7)

const buffers = new BufferStore();
const widget = new CaptureWidget(
  () => void finishCapture(),
  (next) => {
    // Pause/resume: stop buffering + replay while paused (feature F6).
    paused = next;
    replayControl(!next);
  },
);

// Tell the MAIN-world replay recorder to start/stop (gap #1 gating + pause).
function replayControl(on: boolean): void {
  window.postMessage({ marker: CONTROL_MARKER, action: on ? 'replay-on' : 'replay-off' }, '*');
}

// Console/network/steps buffer always-on for retroactive one-click capture.
buffers.start();

// Domains the user has opted out of (feature F7). MAIN hooks still run, but we
// never buffer, package, or surface anything here.
void chrome.storage.local.get('captureDenyDomains').then(({ captureDenyDomains }) => {
  const list = String(captureDenyDomains ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  denied = list.some((d) => location.hostname === d || location.hostname.endsWith(`.${d}`));
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
      buffers.steps.push(data.step);
      break;
    case 'replay':
      buffers.replay.push(data.event);
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
      // Begin a clean, visible recording session: reset buffers so the repro
      // steps start fresh, mount the widget, and start replay recording.
      buffers.reset();
      buffers.start();
      paused = false;
      replayControl(true);
      widget.mount(buffers.startedAt ?? Date.now());
      widget.update(buffers.status());
      return { ok: true, status: buffers.status() };

    case 'capture:stop':
      buffers.stop();
      replayControl(false);
      widget.unmount();
      return { ok: true, status: buffers.status() };

    case 'capture:status':
      return { ok: true, status: buffers.status() };

    case 'capture:finish':
      return finishCapture();

    default:
      return { ok: false, error: `Unhandled message in content: ${message.type}` };
  }
}

// Package the bundle (we hold the DOM + buffers here) and hand persistence to
// the worker, which owns the extension-origin store and the screenshot API.
// Invoked both from the popup's one-click path and the widget's Finish button.
async function finishCapture(): Promise<RuntimeResponse> {
  if (denied) return { ok: false, error: 'Capture is disabled on this domain (Gotcha settings)' };
  const bundle = packageBundle(buffers);
  const saved = (await chrome.runtime.sendMessage({
    type: 'bundle:save',
    bundle,
  } satisfies WorkerMessage)) as WorkerResponse | undefined;
  widget.unmount();
  replayControl(false);
  paused = false;
  buffers.reset();
  buffers.start();
  if (!saved || !saved.ok) {
    return { ok: false, error: saved && !saved.ok ? saved.error : 'Failed to save bundle' };
  }
  if (saved.type !== 'bundle:saved') return { ok: false, error: 'Unexpected save response' };
  return { ok: true, reviewUrl: saved.reviewUrl };
}
