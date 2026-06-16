// Session-replay player (gap #1). Dependency-free — no rrweb import.
//
// Architecture:
//  - The snapshot HTML is rendered into a sandboxed <iframe srcdoc> so page
//    scripts never execute and styles are isolated from the review page.
//  - A transport bar (play/pause + range scrubber + time readout) lets the
//    user navigate the event timeline.
//  - Playing: advances through events in `t` order on a requestAnimationFrame
//    loop; time is wall-clock relative to the recording timeline.
//  - Scrubbing: jumps to the nearest preceding snapshot, then fast-applies all
//    deltas up to the target time.
//  - Cursor dot: an absolutely-positioned <div> over the iframe viewport that
//    mirrors `mouse` events.
//  - Resize events: reflected in a viewport label beneath the iframe.

import type { CaptureBundle, ReplayEvent } from '@shared/types';

// ─── helpers ─────────────────────────────────────────────────────────────────

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

// Find the last snapshot event at or before `targetT`.
function lastSnapshotBefore(events: readonly ReplayEvent[], targetT: number): number {
  let idx = -1;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.t > targetT) break;
    if (ev.kind === 'snapshot' || ev.kind === 'mutation') idx = i;
  }
  return idx;
}

// Extract the <body> markup from a captured frame. Full-document snapshots and
// body-only mutation frames both contain a <body>; fall back to the raw HTML.
function frameBody(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (doc.body) return doc.body.innerHTML;
  } catch {
    // fall through
  }
  return html;
}

// Recompose a frame into a self-contained document. WHY: captured frames use
// origin-relative URLs for CSS/images; rendered via srcdoc they'd resolve
// against the extension origin and 404 (page renders unstyled). Injecting a
// <base href> pointing at the original page makes those resolve. Body-only
// mutation frames also drop the <head> entirely, so we carry the first
// snapshot's stylesheets/links into every frame for consistent styling.
function composeFrame(html: string, headExtras: string, baseHref: string): string {
  const base = baseHref
    ? `<base href="${baseHref.replace(/"/g, '&quot;')}">`
    : '';
  return `<!DOCTYPE html><html><head>${base}${headExtras}</head><body>${frameBody(html)}</body></html>`;
}

// Pull the styling-relevant <head> content (links, styles, meta) from the first
// full snapshot. Strips any existing <base> so ours wins.
function extractHeadExtras(snapshotHtml: string): string {
  try {
    const doc = new DOMParser().parseFromString(snapshotHtml, 'text/html');
    doc.head?.querySelectorAll('base, script').forEach((n) => n.remove());
    return doc.head?.innerHTML ?? '';
  } catch {
    return '';
  }
}

// ─── Cursor projection (exported for unit tests) ─────────────────────────────
//
// Mouse events store clientX/Y in the ORIGINAL viewport's coordinate space,
// but the replay iframe usually renders much smaller — raw coordinates land
// far outside the visible frame. Scale by the width ratio, then clamp inside
// the player wrap so the fixed-position dot can never drift over unrelated
// review UI. Returned coordinates are offsets from the wrap's origin.
export function projectCursor(
  evX: number,
  evY: number,
  iframeWidth: number,
  capturedWidth: number,
  maxX: number,
  maxY: number,
): { x: number; y: number } {
  const scale = capturedWidth > 0 && iframeWidth > 0 ? iframeWidth / capturedWidth : 1;
  const clamp = (v: number, max: number): number => Math.min(Math.max(v, 0), Math.max(max, 0));
  return { x: clamp(evX * scale, maxX), y: clamp(evY * scale, maxY) };
}

// ─── Frame gate (exported for unit tests) ─────────────────────────────────────
//
// Assigning iframe.srcdoc parses ASYNCHRONOUSLY: scroll/input deltas applied
// synchronously right after the assignment land on the PREVIOUS document and
// are discarded with it. The gate queues deltas while a swap is in flight and
// hands them back when the iframe's `load` fires; a monotonic token makes a
// superseded load (rapid scrubbing) a no-op instead of replaying stale deltas
// onto a newer document.
export class FrameGate {
  private token = 0;
  private loading = false;
  private queue: ReplayEvent[] = [];

  /** A new srcdoc swap starts: drop deltas queued for the superseded frame. */
  beginSwap(): number {
    this.loading = true;
    this.queue = [];
    return ++this.token;
  }

  /** Queue a delta while a swap is in flight. Returns true when queued. */
  defer(ev: ReplayEvent): boolean {
    if (!this.loading) return false;
    this.queue.push(ev);
    return true;
  }

  /**
   * The iframe finished loading for `token`. Returns the queued deltas to
   * apply, or null when a later swap superseded this load.
   */
  completeSwap(token: number): ReplayEvent[] | null {
    if (token !== this.token) return null;
    this.loading = false;
    const queued = this.queue;
    this.queue = [];
    return queued;
  }
}

// Everything a delta needs to mutate the live player.
interface PlayerCtx {
  iframe: HTMLIFrameElement;
  cursor: HTMLElement;
  viewportLabel: HTMLElement;
  viewportWrap: HTMLElement;
  capturedWidth: number;
}

// Apply a single delta (non-frame) event to the live iframe + overlays.
// Snapshot/mutation frames are handled by the frame gate in mountReplay.
function applyDelta(event: ReplayEvent, ctx: PlayerCtx): void {
  switch (event.kind) {
    case 'scroll': {
      const doc = ctx.iframe.contentDocument;
      if (!doc) break;
      // A selector means an inner scroll container; otherwise it's the window.
      if (event.selector) {
        const el = doc.querySelector(event.selector);
        if (el) {
          el.scrollLeft = event.x ?? 0;
          el.scrollTop = event.y ?? 0;
        }
      } else if (doc.scrollingElement) {
        doc.scrollingElement.scrollLeft = event.x ?? 0;
        doc.scrollingElement.scrollTop = event.y ?? 0;
      }
      break;
    }
    case 'input': {
      // Reflect the value into the matching element so the iframe state is
      // consistent (useful when scrubbing paused at an input event).
      if (event.selector) {
        const doc = ctx.iframe.contentDocument;
        const el = doc?.querySelector<HTMLInputElement>(event.selector);
        if (el && event.value != null) el.value = event.value;
      }
      break;
    }
    case 'resize': {
      const w = event.w ?? 0;
      const h = event.h ?? 0;
      if (w > 0 && h > 0) {
        ctx.viewportLabel.textContent = `${w} × ${h}`;
      }
      break;
    }
    case 'mouse': {
      // Project original-viewport coordinates into the (smaller) iframe and
      // clamp inside the wrap. The dot is position:fixed, so translate in page
      // coordinates anchored at the wrap's origin.
      const wrapRect = ctx.viewportWrap.getBoundingClientRect();
      const p = projectCursor(
        event.x ?? 0,
        event.y ?? 0,
        ctx.iframe.clientWidth,
        ctx.capturedWidth,
        wrapRect.width,
        wrapRect.height,
      );
      ctx.cursor.style.transform = `translate(${wrapRect.left + p.x}px, ${wrapRect.top + p.y}px)`;
      ctx.cursor.style.display = 'block';
      break;
    }
    default:
      break;
  }
}

// ─── main export ──────────────────────────────────────────────────────────────

export function mountReplay(host: HTMLElement, bundle: CaptureBundle): void {
  const events = bundle.replay ?? [];

  // Guard: need at least a snapshot to show anything useful.
  const firstSnapshot = events.find((e) => e.kind === 'snapshot' || e.kind === 'mutation');
  if (!firstSnapshot) {
    host.innerHTML =
      '<p class="replay-empty">No initial snapshot in this replay recording.</p>';
    return;
  }

  const duration = events.length > 0 ? events[events.length - 1]!.t : 0;

  // Resolve the original page URL as a base so relative CSS/image URLs load,
  // and carry the richest initial <head> styles into every frame. The recorder
  // emits two snapshots at the initial timestamp — a readable-only one and an
  // enriched one with fetched cross-origin CSS — so pick the last (enriched).
  const baseHref = bundle.environment?.url ?? '';
  const initialT = firstSnapshot.t;
  // Pick the head from the snapshot that ACTUALLY carries inlined CSS (the
  // async-enriched frame, marked data-gotcha-inline). WHY: cross-origin CSS is
  // fetched after the readable-only frame is emitted at the same `t`, and on a
  // long recording the t=0 frame can roll out of the ring while a later styled
  // keyframe survives. The old logic only looked at t===initialT and so fell
  // back to an un-styled head whenever the enriched t=0 frame was absent —
  // exactly the "replay renders unstyled on some pages" symptom. Scan ALL
  // snapshots, richest inlined-CSS frame first.
  const isFrame = (e: ReplayEvent): boolean =>
    (e.kind === 'snapshot' || e.kind === 'mutation') && e.html != null;
  const styled = events
    .filter((e) => isFrame(e) && e.html!.includes('data-gotcha-inline'))
    .sort((a, b) => b.html!.length - a.html!.length);
  const headSource =
    styled[0] ??
    events.filter((e) => isFrame(e) && e.t === initialT).pop() ??
    firstSnapshot;
  const headExtras = extractHeadExtras(headSource.html ?? '');
  const wrap = (html: string): string => composeFrame(html, headExtras, baseHref);

  // ── Build DOM ─────────────────────────────────────────────────────────────
  host.innerHTML = '';
  host.className = 'replay-host';

  // Viewport area
  const viewportWrap = document.createElement('div');
  viewportWrap.className = 'replay-viewport-wrap';

  const iframe = document.createElement('iframe');
  iframe.className = 'replay-iframe';
  iframe.sandbox.add('allow-same-origin'); // allow DOM reads (scroll etc.) but no scripts
  iframe.srcdoc = wrap(firstSnapshot.html ?? '');
  iframe.title = 'Session replay';

  // Cursor overlay
  const cursor = document.createElement('div');
  cursor.className = 'replay-cursor';
  cursor.setAttribute('aria-hidden', 'true');

  const viewportLabel = document.createElement('span');
  viewportLabel.className = 'replay-viewport-label';
  viewportLabel.textContent = `${bundle.environment.viewport.width} × ${bundle.environment.viewport.height}`;

  viewportWrap.appendChild(iframe);
  viewportWrap.appendChild(cursor);

  // Transport bar
  const bar = document.createElement('div');
  bar.className = 'replay-bar';

  const playBtn = document.createElement('button');
  playBtn.className = 'replay-btn replay-play';
  playBtn.type = 'button';
  playBtn.setAttribute('aria-label', 'Play');
  playBtn.textContent = '▶';

  const scrubber = document.createElement('input');
  scrubber.type = 'range';
  scrubber.className = 'replay-scrubber';
  scrubber.min = '0';
  scrubber.max = String(Math.max(duration, 1));
  scrubber.value = '0';
  scrubber.step = '1';
  scrubber.setAttribute('aria-label', 'Playback position');

  const timeEl = document.createElement('span');
  timeEl.className = 'replay-time';
  timeEl.textContent = `0:00 / ${fmt(duration)}`;

  const maxBtn = document.createElement('button');
  maxBtn.className = 'replay-btn replay-max';
  maxBtn.type = 'button';
  maxBtn.setAttribute('aria-label', 'Maximize');
  maxBtn.title = 'Maximize';
  maxBtn.textContent = '⛶';

  bar.appendChild(playBtn);
  bar.appendChild(scrubber);
  bar.appendChild(timeEl);
  bar.appendChild(maxBtn);

  // Honest framing (PRD): the player is a DOM reconstruction, not a video
  // recording — it can't reproduce canvas/WebGL/<video> pixels, nested iframes,
  // or stylesheets that were cross-origin without CORS. Say so, so a degraded
  // frame reads as a known limitation rather than a bug.
  const note = document.createElement('p');
  note.className = 'replay-note';
  note.textContent =
    'Reconstructed from the captured DOM — not a pixel video. Canvas/WebGL/<video>, nested iframes, and CORS-restricted CSS may not render. Enable Deep capture for a true pixel recording.';

  host.appendChild(viewportWrap);
  host.appendChild(viewportLabel);
  host.appendChild(bar);
  host.appendChild(note);

  // ── Playback state ────────────────────────────────────────────────────────

  let playing = false;
  let currentT = 0;        // ms into recording timeline
  let wallStart = 0;        // performance.now() when play was pressed
  let timelineAtPlay = 0;   // currentT value when play was pressed
  let eventIdx = 0;         // next event index to apply
  let rafHandle = 0;

  const ctx: PlayerCtx = {
    iframe,
    cursor,
    viewportLabel,
    viewportWrap,
    capturedWidth: bundle.environment.viewport.width,
  };
  const gate = new FrameGate();

  // Swap the iframe to a new frame. srcdoc parses asynchronously, so deltas
  // dispatched while it loads are queued by the gate and applied in the one-shot
  // `load` handler — applying them synchronously here would mutate the OLD
  // document, which is discarded when parsing finishes.
  function setFrame(html: string): void {
    const token = gate.beginSwap();
    iframe.addEventListener(
      'load',
      () => {
        const queued = gate.completeSwap(token);
        if (!queued) return; // a later seek/frame superseded this load
        for (const ev of queued) applyDelta(ev, ctx);
      },
      { once: true },
    );
    iframe.srcdoc = wrap(html);
  }

  // Route an event: frames swap the document, deltas apply immediately — or
  // queue behind an in-flight swap so they land on the document they belong to.
  function dispatch(ev: ReplayEvent): void {
    if (ev.kind === 'snapshot' || ev.kind === 'mutation') {
      if (ev.html != null) setFrame(ev.html);
      return;
    }
    if (gate.defer(ev)) return;
    applyDelta(ev, ctx);
  }

  function updateScrubberUI(): void {
    scrubber.value = String(currentT);
    timeEl.textContent = `${fmt(currentT)} / ${fmt(duration)}`;
  }

  // Seek to `targetT`: find last snapshot at/before, apply it, then fast-apply
  // all events from there to targetT (queued behind the snapshot's load).
  function seekTo(targetT: number): void {
    currentT = Math.max(0, Math.min(targetT, duration));
    const snapIdx = lastSnapshotBefore(events, currentT);
    if (snapIdx >= 0) {
      dispatch(events[snapIdx]!);
      // Fast-apply events from snapIdx+1 up to currentT.
      for (let i = snapIdx + 1; i < events.length; i++) {
        const ev = events[i]!;
        if (ev.t > currentT) break;
        dispatch(ev);
      }
      // Set next event index to the first event after currentT.
      eventIdx = snapIdx + 1;
      while (eventIdx < events.length && events[eventIdx]!.t <= currentT) {
        eventIdx++;
      }
    } else {
      eventIdx = 0;
    }
    updateScrubberUI();
  }

  // RAF loop: advance currentT by wall-clock delta, apply due events.
  function tick(): void {
    if (!playing) return;
    const wallNow = performance.now();
    currentT = Math.min(timelineAtPlay + (wallNow - wallStart), duration);

    while (eventIdx < events.length && events[eventIdx]!.t <= currentT) {
      dispatch(events[eventIdx]!);
      eventIdx++;
    }

    updateScrubberUI();

    if (currentT >= duration) {
      pause();
      return;
    }

    rafHandle = requestAnimationFrame(tick);
  }

  function play(): void {
    if (playing) return;
    if (currentT >= duration) seekTo(0);
    playing = true;
    wallStart = performance.now();
    timelineAtPlay = currentT;
    playBtn.textContent = '⏸';
    playBtn.setAttribute('aria-label', 'Pause');
    rafHandle = requestAnimationFrame(tick);
  }

  function pause(): void {
    playing = false;
    cancelAnimationFrame(rafHandle);
    playBtn.textContent = '▶';
    playBtn.setAttribute('aria-label', 'Play');
  }

  // ── Event wiring ──────────────────────────────────────────────────────────

  playBtn.addEventListener('click', () => {
    if (playing) pause();
    else play();
  });

  function setMaximized(on: boolean): void {
    host.classList.toggle('replay-host--max', on);
    maxBtn.textContent = on ? '🗗' : '⛶';
    const label = on ? 'Minimize' : 'Maximize';
    maxBtn.setAttribute('aria-label', label);
    maxBtn.title = label;
  }

  maxBtn.addEventListener('click', () => {
    setMaximized(!host.classList.contains('replay-host--max'));
  });

  scrubber.addEventListener('input', () => {
    if (playing) pause();
    seekTo(Number(scrubber.value));
  });

  // Keyboard: space = play/pause, arrow keys = ±5s.
  bar.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault();
      if (playing) pause(); else play();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (playing) pause();
      seekTo(currentT - 5000);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (playing) pause();
      seekTo(currentT + 5000);
    } else if (e.key === 'Escape' && host.classList.contains('replay-host--max')) {
      e.preventDefault();
      setMaximized(false);
    }
  });

  // Initialise to t=0 (snapshot already set as srcdoc above).
  seekTo(0);
}
