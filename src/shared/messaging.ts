import type {
  ConsoleEntry,
  NetworkEntry,
  ReproStep,
  ReplayEvent,
  CaptureBundle,
  AiAnalysis,
} from './types';

export type IntegrationId = 'linear' | 'jira' | 'github' | 'slack';

// ─── content → service worker (extension-origin operations) ─────────────────
// The content script cannot reach the extension-origin IndexedDB or
// chrome.tabs.captureVisibleTab, so it delegates persistence + screenshot to
// the worker. The worker is the only writer of the durable store.
export type WorkerMessage =
  | { type: 'bundle:save'; bundle: CaptureBundle }
  | { type: 'screenshot:capture' }
  // Fetch cross-origin stylesheets the page context can't read (CORS/CSP). The
  // worker has <all_urls> host permission, so it fetches them with credentials.
  | { type: 'css:fetch'; sheets: { href: string }[] };

export type WorkerResponse =
  | { type: 'bundle:saved'; ok: true; reviewUrl: string }
  | { type: 'screenshot'; ok: true; dataUrl: string }
  // Per-href CSS text (absolutized); hrefs that failed are omitted.
  | { type: 'css:fetched'; ok: true; css: Record<string, string> }
  | { ok: false; error: string };

// All window.postMessage payloads from MAIN world carry this marker so the
// ISOLATED content script can distinguish them from page traffic.
export const BRIDGE_MARKER = '__gotcha_bridge__' as const;

// ─── MAIN world → ISOLATED content (via window.postMessage) ─────────────────
export type BridgeMessage =
  | { marker: typeof BRIDGE_MARKER; type: 'console'; entry: ConsoleEntry }
  | { marker: typeof BRIDGE_MARKER; type: 'network'; entry: NetworkEntry }
  | { marker: typeof BRIDGE_MARKER; type: 'step'; step: ReproStep }
  | { marker: typeof BRIDGE_MARKER; type: 'replay'; event: ReplayEvent };

// ─── popup / review ↔ content / worker (via chrome.runtime) ─────────────────
export type RuntimeMessage =
  | { type: 'capture:start' }
  | { type: 'capture:stop' }
  | { type: 'capture:status' }
  | { type: 'capture:finish' } // snapshot DOM + screenshot, persist, open review
  | { type: 'capture:shareLastMinute' } // package the trailing window (no session), open review
  | { type: 'bundle:get'; id: string }
  | { type: 'bundle:list' }
  | { type: 'bundle:delete'; id: string }
  | { type: 'bundle:attachTest'; id: string; filename: string; source: string }
  | { type: 'bundle:setScreenshot'; id: string; dataUrl: string }
  | { type: 'bundle:setSteps'; id: string; steps: ReproStep[] }
  | { type: 'bundle:file'; id: string; redact: boolean; integration: IntegrationId }
  | { type: 'integration:test'; id: IntegrationId }
  | { type: 'deep:enable'; tabId?: number | undefined }
  | { type: 'deep:disable'; tabId?: number | undefined }
  | { type: 'deep:status' }
  // AI triage: analyse the bundle with the user's own key (redacts first).
  | { type: 'ai:analyze'; id: string }
  | { type: 'ai:duplicates'; id: string }
  | { type: 'ai:available' }
  | { type: 'ai:test' };

// Likely-duplicate match surfaced before filing (#3). Defined here (not in the
// ai module) so shared stays dependency-free.
export interface DuplicateMatch {
  id: string;
  title: string;
  reason: string;
}

export interface CaptureStatus {
  recording: boolean;
  startedAt: number | null;
  counts: { console: number; errors: number; network: number; failed: number; steps: number };
}

export interface FiledResult {
  integration: IntegrationId;
  identifier: string;
  url: string;
  simulated: boolean;
}

// Lightweight row for lists (popup, dashboard) — never carries the screenshot
// or DOM snapshot, so listing stays cheap.
export interface BundleSummary {
  id: string;
  title: string;
  createdAt: number;
  counts: { console: number; errors: number; network: number; failed: number; steps: number };
  hasTest: boolean;
  filed: { integration: IntegrationId; identifier: string; url: string } | null;
}

export type RuntimeResponse =
  | { ok: true; status: CaptureStatus }
  | { ok: true; bundle: CaptureBundle }
  | { ok: true; bundles: BundleSummary[] }
  | { ok: true; reviewUrl: string }
  | { ok: true; filed: FiledResult }
  | { ok: true; deep: boolean }
  | { ok: true; analysis: AiAnalysis }
  | { ok: true; available: boolean }
  | { ok: true; duplicates: DuplicateMatch[] }
  | { ok: true }
  | { ok: false; error: string };

export function isBridgeMessage(data: unknown): data is BridgeMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { marker?: unknown }).marker === BRIDGE_MARKER
  );
}

// ─── ISOLATED content → MAIN world control (via window.postMessage) ──────────
// Used to start/stop the session-replay recorder (gap #1 gating + pause/resume).
export const CONTROL_MARKER = '__gotcha_control__' as const;
// 'replay-on' starts a fresh, session-scoped recording (epoch reset, t=0
// snapshot). 'replay-always-on' starts the always-on Instant Replay recorder
// (stable epoch + periodic keyframes). 'replay-off' tears either one down.
export type ControlMessage = {
  marker: typeof CONTROL_MARKER;
  action: 'replay-on' | 'replay-off' | 'replay-always-on';
};

export function isControlMessage(data: unknown): data is ControlMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { marker?: unknown }).marker === CONTROL_MARKER
  );
}

// ─── sub-frame → top-frame forwarding (issue #6: all_frames capture) ─────────
// A sub-frame's content script wraps each bridge message and posts it to
// window.top, where the top content script (the buffer owner) unwraps it.
export const FRAME_FWD_MARKER = '__gotcha_frame_fwd__' as const;
export type FrameForward = { marker: typeof FRAME_FWD_MARKER; payload: BridgeMessage };

export function isFrameForward(data: unknown): data is FrameForward {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { marker?: unknown }).marker === FRAME_FWD_MARKER
  );
}
