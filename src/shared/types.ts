import { z } from 'zod';

// ─── Console ────────────────────────────────────────────────────────────────
export const ConsoleLevel = z.enum(['log', 'info', 'warn', 'error', 'debug']);
export type ConsoleLevel = z.infer<typeof ConsoleLevel>;

export const ConsoleEntry = z.object({
  id: z.string(),
  level: ConsoleLevel,
  message: z.string(),
  stack: z.string().optional(),
  ts: z.number(),
});
export type ConsoleEntry = z.infer<typeof ConsoleEntry>;

// ─── Network ────────────────────────────────────────────────────────────────
// Which API produced the entry. `fetch`/`xhr` are the monkey-patched defaults;
// `beacon`/`websocket`/`eventsource`/`worker` close the capture blind spots
// (gap #6); `cdp` is a deep-capture (chrome.debugger) entry.
export const NetworkTransport = z.enum([
  'fetch',
  'xhr',
  'beacon',
  'websocket',
  'eventsource',
  'worker',
  'cdp',
]);
export type NetworkTransport = z.infer<typeof NetworkTransport>;

// One frame on a long-lived connection (WebSocket / EventSource), so the
// review/replay can show the message timeline, not just the handshake.
export const SocketFrame = z.object({
  dir: z.enum(['send', 'recv']),
  data: z.string(),
  ts: z.number(),
});
export type SocketFrame = z.infer<typeof SocketFrame>;

export const NetworkEntry = z.object({
  id: z.string(),
  url: z.string(),
  method: z.string(),
  status: z.number(),
  statusText: z.string().optional(),
  requestHeaders: z.record(z.string()).optional(),
  responseHeaders: z.record(z.string()).optional(),
  requestBody: z.string().optional(),
  responseBody: z.string().optional(),
  durationMs: z.number(),
  failed: z.boolean(),
  ts: z.number(),
  // Defaults to fetch/xhr when absent (back-compat with bundles captured
  // before transports existed).
  transport: NetworkTransport.optional(),
  // Populated for websocket/eventsource entries.
  frames: z.array(SocketFrame).optional(),
});
export type NetworkEntry = z.infer<typeof NetworkEntry>;

// ─── Repro steps ────────────────────────────────────────────────────────────
export const ReproStepKind = z.enum(['navigate', 'click', 'input', 'submit', 'keypress']);
export type ReproStepKind = z.infer<typeof ReproStepKind>;

export const ReproStep = z.object({
  id: z.string(),
  kind: ReproStepKind,
  selector: z.string().optional(),
  // Ranked alternative selectors (best-first), seeds the test-gen selector
  // engine (gap #3) so a flaky `tag.class` isn't the only option.
  selectorCandidates: z.array(z.string()).optional(),
  label: z.string(),
  value: z.string().optional(),
  ts: z.number(),
});
export type ReproStep = z.infer<typeof ReproStep>;

// ─── Session replay (gap #1) ──────────────────────────────────────────────────
// A lightweight rrweb-style event stream: one full DOM snapshot followed by
// incremental mutations / scroll / input / viewport events, so visual & timing
// bugs that a single screenshot loses become watchable. The recorder masks
// sensitive inputs at capture time (mirroring dom-snapshot); redactBundle masks
// `html`/`value` again before the bundle leaves the browser.
export const ReplayEventKind = z.enum([
  'snapshot',
  'mutation',
  'scroll',
  'input',
  'resize',
  'mouse',
]);
export type ReplayEventKind = z.infer<typeof ReplayEventKind>;

export const ReplayEvent = z.object({
  t: z.number(), // ms since capture epoch (relative timeline)
  kind: ReplayEventKind,
  html: z.string().optional(), // snapshot / mutation payload
  selector: z.string().optional(), // input / mutation target
  value: z.string().optional(), // input value (masked if sensitive)
  x: z.number().optional(), // scroll / mouse / resize geometry
  y: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
});
export type ReplayEvent = z.infer<typeof ReplayEvent>;

// ─── Environment ────────────────────────────────────────────────────────────
export const Environment = z.object({
  url: z.string(),
  userAgent: z.string(),
  browser: z.string(),
  os: z.string(),
  viewport: z.object({ width: z.number(), height: z.number() }),
  dpr: z.number(),
  locale: z.string(),
  capturedAt: z.number(),
});
export type Environment = z.infer<typeof Environment>;

// ─── AI triage (bring-your-own-key) ───────────────────────────────────────────
export const Severity = z.enum(['P0', 'P1', 'P2', 'P3']);
export type Severity = z.infer<typeof Severity>;

// The structured shape the LLM is asked to return (before we stamp
// provider/model/at). Validated at the trust boundary after the API call.
// Only summary/rootCauses/debuggingSteps are required; the rest are optional so
// a cheaper/older model that omits them still validates.
export const AiAnalysisResult = z.object({
  summary: z.string(),
  rootCauses: z.array(z.string()),
  debuggingSteps: z.array(z.string()),
  // #1 — a crisp title derived from the evidence.
  suggestedTitle: z.string().optional(),
  // #4 — severity suggestion to pre-fill the file step.
  severity: z.object({ level: Severity, reason: z.string() }).optional(),
  // #2 — test-gen hints: a chosen selector per step + an end-state assertion.
  testHints: z
    .object({
      endStateAssertion: z.string().optional(),
      selectors: z.array(z.object({ stepId: z.string(), selector: z.string() })).optional(),
    })
    .optional(),
});
export type AiAnalysisResult = z.infer<typeof AiAnalysisResult>;

// The cached analysis stored on a bundle = the model result + provenance.
export const AiAnalysis = AiAnalysisResult.extend({
  provider: z.string(),
  model: z.string(),
  at: z.number(),
});
export type AiAnalysis = z.infer<typeof AiAnalysis>;

// ─── CDP screencast (true-pixel video, deep-capture only) ─────────────────────
// Unlike the DOM replay (a reconstruction), screencast frames are actual
// rendered pixels from chrome.debugger's Page.startScreencast — so canvas/WebGL,
// <video>, nested iframes, and cross-origin CSS all show faithfully. Each frame
// is a JPEG data URL stamped on the relative capture timeline.
export const ScreencastFrame = z.object({
  t: z.number(), // ms since capture start
  data: z.string(), // data:image/jpeg;base64,…
});
export type ScreencastFrame = z.infer<typeof ScreencastFrame>;

// ─── The bundle ─────────────────────────────────────────────────────────────
export const CaptureBundle = z.object({
  id: z.string(),
  title: z.string(),
  console: z.array(ConsoleEntry),
  network: z.array(NetworkEntry),
  steps: z.array(ReproStep),
  domSnapshot: z.string().optional(),
  screenshotDataUrl: z.string().optional(),
  // Session-replay event stream (gap #1). Optional for back-compat.
  replay: z.array(ReplayEvent).optional(),
  // True-pixel CDP screencast frames (deep-capture only). Optional.
  screencast: z.array(ScreencastFrame).optional(),
  environment: Environment,
  redacted: z.boolean(),
  createdAt: z.number(),
  // Set once filed: where it landed and the generated regression test.
  filed: z
    .object({ integration: z.string(), identifier: z.string(), url: z.string(), at: z.number() })
    .optional(),
  generatedTest: z.object({ filename: z.string(), source: z.string() }).optional(),
  // AI triage (bring-your-own-key). Produced on explicit request from the
  // already-redacted bundle; cached so it isn't re-billed on every open.
  aiAnalysis: AiAnalysis.optional(),
});
export type CaptureBundle = z.infer<typeof CaptureBundle>;
