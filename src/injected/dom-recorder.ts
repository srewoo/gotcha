// Session-replay recorder (gap #1). MAIN-world only — no chrome.* APIs.
//
// Strategy:
//  - Initial snapshot: clones the live DOM, strips scripts/noscript, masks
//    sensitive input values, emits a `snapshot` event with t=0.
//  - Mutations: a MutationObserver coalesces mutation records; at most once
//    every MUTATION_THROTTLE_MS it emits a fresh body snapshot. This is
//    deliberately simpler than a patch-based approach — correctness and event
//    volume matter more than byte-perfect diffs at this stage.
//  - Scroll / resize / mouse: throttled window listeners.
//  - Input: 'input' and 'change' events with value masking for sensitive fields.
//
// Tradeoff note: emitting a full body snapshot on mutations means events can be
// a few KB each on complex pages. The ring buffer in buffer-store.ts caps total
// events at 3000, which is sufficient for ~5 min of typical activity. A future
// v2 can switch to attribute/text diffs for lower volume.

import { BRIDGE_MARKER, post } from './bridge';
import { isControlMessage } from '@shared/messaging';
import type { ReplayEvent } from '@shared/types';

// Throttle intervals (ms).
const MUTATION_THROTTLE_MS = 250;
const SCROLL_THROTTLE_MS = 100;
const RESIZE_THROTTLE_MS = 200;
const MOUSE_THROTTLE_MS = 200;

// Defensive cap: stop emitting mutations after this many events to avoid
// flooding the ring buffer on pathologically dynamic pages.
const MAX_MUTATION_EVENTS = 500;

// Max characters kept for input values (non-sensitive).
const MAX_INPUT_VALUE = 120;

// Cap each snapshot's HTML so a large DOM can't bloat memory / IndexedDB. A
// snapshot beyond this is truncated (replay still renders the head of it).
const MAX_SNAPSHOT_HTML = 250_000;

// The initial full snapshot also carries inlined CSS (see collectInlineCss),
// so it gets a larger budget. Only ONE per recording, so the cost is bounded.
const MAX_FULL_SNAPSHOT_HTML = 2_000_000;
const MAX_INLINE_CSS = 1_500_000;

function capHtml(html: string, max: number = MAX_SNAPSHOT_HTML): string {
  return html.length > max
    ? `${html.slice(0, max)}<!-- …truncated by Gotcha (${html.length} bytes) -->`
    : html;
}

// Serialize every readable stylesheet into a single CSS string. WHY: authenticated
// SPAs (e.g. Atlassian/Mindtickle) load CSS from cross-origin, cookie-gated
// <link>s. At replay time the iframe runs on the extension origin and can't
// fetch them, so the page renders unstyled. Here — in the page's own world,
// same-origin and within the user's session — we can read cssRules and embed
// the actual CSS, making the replay self-contained. Cross-origin sheets without
// CORS throw on .cssRules access; we skip those (their <link> stays as a
// best-effort fallback).
// Time budget for fetching opaque cross-origin sheets before we emit whatever
// CSS we have. Keeps the initial snapshot from stalling on a slow CDN.
const CSS_FETCH_TIMEOUT_MS = 2500;

// Serialize a single readable sheet's rules. Returns '' if opaque (throws).
function readSheetRules(sheet: CSSStyleSheet, budget: number): string {
  let css = '';
  const rules = sheet.cssRules; // throws for opaque cross-origin sheets
  for (const rule of Array.from(rules)) {
    css += rule.cssText + '\n';
    if (css.length >= budget) break;
  }
  return css;
}

// Rewrite relative url(...) refs in fetched CSS to absolute, resolved against
// the stylesheet's own location — otherwise fonts/background images would
// resolve against the replay's <base> (the page URL) and break.
function absolutizeCss(css: string, baseHref: string): string {
  return css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/g,
    (m: string, quote: string, url: string): string => {
      if (/^(?:data:|https?:|\/\/|#)/i.test(url)) return m;
      try {
        return `url(${quote}${new URL(url, baseHref).href}${quote})`;
      } catch {
        return m;
      }
    },
  );
}

// Synchronous, readable-only CSS — used as an immediate fallback if the async
// path errors.
function collectInlineCss(): string {
  let css = '';
  for (const sheet of Array.from(document.styleSheets)) {
    if (css.length >= MAX_INLINE_CSS) break;
    try {
      css += readSheetRules(sheet, MAX_INLINE_CSS - css.length);
    } catch {
      // Unreadable cross-origin sheet — left as a <link> fallback.
    }
  }
  return css;
}

// Full CSS collection: reads readable sheets synchronously and fetch()es opaque
// cross-origin sheets from the page context (credentials included → auth-gated
// CSS loads), preserving cascade order. Bounded by MAX_INLINE_CSS and a wall-
// clock timeout so a slow CDN can't hang capture.
async function collectInlineCssAsync(): Promise<string> {
  const parts: string[] = [];
  const pending: Array<Promise<void>> = [];
  let size = 0;

  for (const sheet of Array.from(document.styleSheets)) {
    if (size >= MAX_INLINE_CSS) break;
    try {
      const css = readSheetRules(sheet, MAX_INLINE_CSS - size);
      parts.push(css);
      size += css.length;
    } catch {
      // Opaque cross-origin sheet — reserve its slot and fetch the raw text.
      const href = sheet.href;
      if (!href) continue;
      const slot = parts.length;
      parts.push('');
      pending.push(
        fetch(href, { credentials: 'include' })
          .then((res) => (res.ok ? res.text() : ''))
          .then((text) => {
            if (text && size < MAX_INLINE_CSS) {
              const css = absolutizeCss(text, href);
              parts[slot] = css;
              size += css.length;
            }
          })
          .catch(() => {
            /* CORS-blocked or network error — leave the <link> fallback */
          }),
      );
    }
  }

  if (pending.length > 0) {
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => setTimeout(resolve, CSS_FETCH_TIMEOUT_MS)),
    ]);
  }
  return parts.join('\n');
}

// Patterns that mark an input as sensitive. Must never record real values.
const SENSITIVE_NAME = /pass|secret|card|cvv|ssn/i;

function isSensitive(el: Element): boolean {
  const type = el.getAttribute('type')?.toLowerCase();
  if (type === 'password') return true;
  const name = el.getAttribute('name') ?? '';
  return SENSITIVE_NAME.test(name);
}

// Compute a simple CSS selector for an element (mirrors repro-recorder.ts).
function selectorFor(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const testId = el.getAttribute('data-testid');
  if (testId) return `[data-testid="${testId}"]`;
  const name = el.getAttribute('name');
  if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
  const cls =
    el.className && typeof el.className === 'string'
      ? `.${el.className
          .trim()
          .split(/\s+/)
          .slice(0, 2)
          .map(CSS.escape)
          .join('.')}`
      : '';
  return `${el.tagName.toLowerCase()}${cls}`;
}

// Return a sanitised body snapshot: scripts removed, sensitive inputs masked.
function snapshotBody(): string {
  const clone = document.body.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('script, noscript').forEach((n) => n.remove());
  clone.querySelectorAll('input, textarea').forEach((el) => {
    if (isSensitive(el)) {
      el.setAttribute('value', '«redacted»');
    }
  });
  return capHtml(clone.outerHTML);
}

// Build a sanitised full-document snapshot with the given CSS inlined into <head>
// so the replay renders styled (see collectInlineCss / collectInlineCssAsync).
function buildFullSnapshot(css: string): string {
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('script, noscript').forEach((n) => n.remove());
  clone.querySelectorAll('input, textarea').forEach((el) => {
    if (isSensitive(el)) {
      el.setAttribute('value', '«redacted»');
    }
  });

  if (css) {
    let head = clone.querySelector('head');
    if (!head) {
      head = document.createElement('head');
      clone.insertBefore(head, clone.firstChild);
    }
    const style = document.createElement('style');
    style.setAttribute('data-gotcha-inline', '');
    style.textContent = css;
    head.appendChild(style);
  }

  return capHtml(`<!DOCTYPE html>\n${clone.outerHTML}`, MAX_FULL_SNAPSHOT_HTML);
}

// Synchronous full snapshot (readable CSS only) — fallback path.
function snapshotFull(): string {
  return buildFullSnapshot(collectInlineCss());
}

function emit(event: ReplayEvent): void {
  post({ marker: BRIDGE_MARKER, type: 'replay', event });
}

// Simple throttle: returns a wrapper that calls fn at most once per interval.
function throttle<T extends unknown[]>(
  fn: (...args: T) => void,
  intervalMs: number,
): (...args: T) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: T | null = null;
  return (...args: T) => {
    lastArgs = args;
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (lastArgs !== null) {
        fn(...lastArgs);
        lastArgs = null;
      }
    }, intervalMs);
  };
}

// Replay is gated to explicit recording sessions (issue #1): a full-DOM
// MutationObserver running on every page from document_start is too costly to
// leave always-on. The content script sends a control message to start/stop it
// (also used by the widget's pause/resume). Console/network/steps stay
// always-on for retroactive one-click capture; replay is a recording feature.
let enabled = false;
let epoch = 0;
let mutationCount = 0;
let pendingMutation = false;
let observer: MutationObserver | null = null;
const rel = (): number => Date.now() - epoch;

function startObserver(): void {
  if (!observer) {
    observer = new MutationObserver(() => {
      pendingMutation = true;
      scheduleFlush();
    });
  }
  const opts = { childList: true, attributes: true, characterData: true, subtree: true } as const;
  if (document.body) observer.observe(document.documentElement, opts);
  else document.addEventListener('DOMContentLoaded', () => observer?.observe(document.documentElement, opts), { once: true });
}

const flushMutation = (): void => {
  pendingMutation = false;
  if (!enabled || mutationCount >= MAX_MUTATION_EVENTS) return;
  mutationCount++;
  try {
    emit({ t: rel(), kind: 'mutation', html: snapshotBody() });
  } catch {
    // Snapshot errors must not surface.
  }
};

const scheduleFlush = throttle(() => {
  if (pendingMutation) flushMutation();
}, MUTATION_THROTTLE_MS);

function enable(): void {
  if (enabled) return;
  enabled = true;
  epoch = Date.now();
  mutationCount = 0;

  // Emit an immediate snapshot with readable CSS so the frame is never lost,
  // then asynchronously enrich it with fetched cross-origin CSS and re-emit at
  // t=0. The renderer's seekTo picks the last snapshot at/before the target, so
  // the enriched one wins at playback start.
  try {
    emit({ t: 0, kind: 'snapshot', html: snapshotFull() });
  } catch {
    /* never throw */
  }

  void collectInlineCssAsync()
    .then((css) => {
      if (!enabled) return;
      const html = buildFullSnapshot(css);
      emit({ t: 0, kind: 'snapshot', html });
    })
    .catch(() => {
      /* keep the readable-only snapshot already emitted */
    });

  startObserver();
}

function disable(): void {
  enabled = false;
  observer?.disconnect();
}

export function installDomRecorder(): void {
  try {
    _install();
  } catch {
    // Must never throw into the host page.
  }
}

function _install(): void {
  // Control channel from the ISOLATED content script (start/stop a session).
  window.addEventListener('message', (event) => {
    if (event.source !== window || !isControlMessage(event.data)) return;
    if (event.data.action === 'replay-on') enable();
    else if (event.data.action === 'replay-off') disable();
  });

  // Lightweight listeners stay installed but only emit while enabled.
  window.addEventListener(
    'scroll',
    throttle(() => {
      if (enabled) emit({ t: rel(), kind: 'scroll', x: window.scrollX, y: window.scrollY });
    }, SCROLL_THROTTLE_MS),
    { passive: true, capture: true },
  );
  window.addEventListener(
    'resize',
    throttle(() => {
      if (enabled) emit({ t: rel(), kind: 'resize', w: window.innerWidth, h: window.innerHeight });
    }, RESIZE_THROTTLE_MS),
    { passive: true },
  );
  const onInput = (e: Event): void => {
    if (!enabled) return;
    const el = e.target;
    if (!(el instanceof HTMLElement)) return;
    const raw = (el as HTMLInputElement).value ?? '';
    const value = isSensitive(el) ? '«redacted»' : raw.slice(0, MAX_INPUT_VALUE);
    emit({ t: rel(), kind: 'input', selector: selectorFor(el), value });
  };
  document.addEventListener('input', onInput, { capture: true, passive: true });
  document.addEventListener('change', onInput, { capture: true, passive: true });
  document.addEventListener(
    'mousemove',
    throttle((e: MouseEvent) => {
      if (enabled) emit({ t: rel(), kind: 'mouse', x: e.clientX, y: e.clientY });
    }, MOUSE_THROTTLE_MS),
    { passive: true, capture: false },
  );
}
