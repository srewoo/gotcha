// Session-replay recorder (gap #1). MAIN-world only — no chrome.* APIs.
//
// Strategy:
//  - Initial snapshot: clones the live DOM, strips scripts/noscript, masks
//    sensitive input values, emits a `snapshot` event with t=0.
//  - Mutations: a MutationObserver coalesces mutation records; at most once
//    every MUTATION_THROTTLE_MS it emits a fresh body snapshot. This is
//    deliberately simpler than a patch-based approach — correctness and event
//    volume matter more than byte-perfect diffs at this stage. The observer is
//    attached to the document AND to every shadow root (open + closed) so DOM
//    changes inside web components trigger snapshots and replay faithfully —
//    without this, component internals freeze at their first captured frame.
//  - Scroll / resize / mouse: throttled window listeners.
//  - Input: 'input' and 'change' events with value masking for sensitive fields.
//
// Tradeoff note: emitting a full body snapshot on mutations means events can be
// a few KB each on complex pages. The ring buffer in buffer-store.ts caps total
// events at 3000, which is sufficient for ~5 min of typical activity. A future
// v2 can switch to attribute/text diffs for lower volume.

import { BRIDGE_MARKER, post } from './bridge';
import { isControlMessage } from '@shared/messaging';
import { KEYFRAME_INTERVAL_MS } from '@shared/capture-config';
import { absolutizeCss } from '@shared/css-util';
import { closedRootFor, connectedShadowRoots, onShadowRoot } from './shadow-registry';
import type { ReplayEvent } from '@shared/types';

// Throttle intervals (ms).
const MUTATION_THROTTLE_MS = 250;
const SCROLL_THROTTLE_MS = 100;
const RESIZE_THROTTLE_MS = 200;
const MOUSE_THROTTLE_MS = 200;

// Max characters kept for input values (non-sensitive).
const MAX_INPUT_VALUE = 120;

// Cap each snapshot's HTML so a large DOM can't bloat memory / IndexedDB. A
// snapshot beyond this is truncated (replay still renders the head of it).
const MAX_SNAPSHOT_HTML = 500_000;

// The initial full snapshot also carries inlined CSS (see collectInlineCss),
// so it gets a larger budget. Only ONE per recording, so the cost is bounded.
const MAX_FULL_SNAPSHOT_HTML = 4_000_000;
const MAX_INLINE_CSS = 3_000_000;

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

// Inline a root's constructed stylesheets (document.adoptedStyleSheets or a
// shadow root's). WHY: modern frameworks (Lit, CSS-in-JS, many web components)
// attach styles via `adoptedStyleSheets`, which are NOT in `document.styleSheets`
// and are NOT serialized by cloneNode/outerHTML — so without this they vanish
// from the replay and the page renders unstyled. Constructed sheets are
// same-origin, so `cssRules` is always readable.
function adoptedCssText(root: DocumentOrShadowRoot): string {
  let css = '';
  const sheets = root.adoptedStyleSheets;
  if (!sheets) return css;
  for (const sheet of sheets) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        css += rule.cssText + '\n';
        if (css.length >= MAX_INLINE_CSS) return css;
      }
    } catch {
      // Unreadable — skip.
    }
  }
  return css;
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
  return css + adoptedCssText(document);
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
              // Slice to the remaining budget BEFORE absolutizing so a single
              // large sheet can't push `size` past MAX_INLINE_CSS (the readable
              // path and the worker both honour the budget the same way).
              const css = absolutizeCss(text.slice(0, MAX_INLINE_CSS - size), href);
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
  return parts.join('\n') + adoptedCssText(document);
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

// Strip scripts and mask sensitive input values on a cloned subtree's LIGHT DOM.
// (Shadow content is sanitised separately, as it's recursed into before wrapping.)
function sanitizeClone(clone: Element | DocumentFragment): void {
  clone.querySelectorAll('script, noscript').forEach((n) => n.remove());
  clone.querySelectorAll('input, textarea').forEach((el) => {
    if (isSensitive(el)) el.setAttribute('value', '«redacted»');
  });
}

// Deep-clone an element, sanitise it, and inline any OPEN shadow roots as
// Declarative Shadow DOM (`<template shadowrootmode="open">`) carrying the shadow
// root's own adopted + inline styles. WHY: cloneNode/outerHTML drops shadow roots
// entirely, so component-based apps (web components, micro-frontends) replay
// unstyled and structurally empty. The replay iframe's srcdoc re-hydrates DSD
// natively, so no player change is needed. Closed shadow roots are inaccessible
// (`el.shadowRoot` is null) and unavoidably lost.
function cloneWithShadow(el: Element): Element {
  const clone = el.cloneNode(true) as Element;
  // cloneNode preserves light-DOM structure, so a document-order walk of the
  // original aligns 1:1 with the clone. Include `el` itself (querySelectorAll
  // returns only descendants) so a host passed in directly — e.g. during nested
  // shadow recursion — has its own shadow root inlined too.
  const origEls = [el, ...el.querySelectorAll('*')];
  const cloneEls = [clone, ...clone.querySelectorAll('*')];
  for (let i = 0; i < origEls.length; i++) {
    // Open roots via el.shadowRoot; closed roots via the attachShadow registry.
    const sr = origEls[i]!.shadowRoot ?? closedRootFor(origEls[i]!);
    const target = cloneEls[i];
    if (!sr || !target) continue;

    const tpl = document.createElement('template');
    tpl.setAttribute('shadowrootmode', 'open');
    const css = adoptedCssText(sr);
    if (css) {
      const style = document.createElement('style');
      style.textContent = css;
      tpl.content.appendChild(style);
    }
    for (const child of Array.from(sr.childNodes)) {
      tpl.content.appendChild(
        child.nodeType === Node.ELEMENT_NODE
          ? cloneWithShadow(child as Element) // nested shadow hosts recurse
          : child.cloneNode(true),
      );
    }
    sanitizeClone(tpl.content); // sanitise shadow light DOM (querySelectorAll skips it otherwise)
    // DSD template must be the host's first child, before slottable light DOM.
    target.insertBefore(tpl, target.firstChild);
  }
  sanitizeClone(clone);
  return clone;
}

// Return a sanitised body snapshot: scripts removed, sensitive inputs masked,
// open shadow DOM inlined. Exported for unit testing.
export function snapshotBody(): string {
  return capHtml(cloneWithShadow(document.body).outerHTML);
}

// Build a sanitised full-document snapshot with the given CSS inlined into <head>
// so the replay renders styled (see collectInlineCss / collectInlineCssAsync).
function buildFullSnapshot(css: string): string {
  const clone = cloneWithShadow(document.documentElement);

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

// Synchronous full snapshot (readable CSS only) — fallback path. Exported for
// unit testing.
export function snapshotFull(): string {
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
let pendingMutation = false;
let observer: MutationObserver | null = null;
let unsubscribeShadow: (() => void) | null = null;
// When always-on (Instant Replay), a recurring timer emits styled keyframe
// snapshots so any trailing slice has a recent, seedable frame to start from.
let keyframeTimer: ReturnType<typeof setInterval> | null = null;
const rel = (): number => Date.now() - epoch;

const OBSERVE_OPTS = {
  childList: true,
  attributes: true,
  characterData: true,
  subtree: true,
} as const;

// A MutationObserver on the document does NOT see inside shadow roots, so we
// attach the SAME observer to every shadow root too — open and closed. This is
// what makes component-internal updates (the common case in web-component /
// micro-frontend apps) replay faithfully instead of freezing at the first frame.
function observeShadowRoot(root: ShadowRoot): void {
  if (!observer) return;
  try {
    observer.observe(root, OBSERVE_OPTS);
  } catch {
    // Already-observed roots or detached nodes — ignore.
  }
}

function startObserver(): void {
  if (!observer) {
    observer = new MutationObserver(() => {
      pendingMutation = true;
      scheduleFlush();
    });
  }
  const observeAll = (): void => {
    observer?.observe(document.documentElement, OBSERVE_OPTS);
    for (const root of connectedShadowRoots()) observeShadowRoot(root);
  };
  if (document.body) observeAll();
  else document.addEventListener('DOMContentLoaded', observeAll, { once: true });
  // Watch roots attached AFTER recording starts (lazily-rendered components).
  if (!unsubscribeShadow) {
    unsubscribeShadow = onShadowRoot((root) => {
      if (enabled) observeShadowRoot(root);
    });
  }
}

const flushMutation = (): void => {
  pendingMutation = false;
  if (!enabled) return;
  // No lifetime cap: the 250ms throttle bounds the emit RATE, and buffer-store's
  // ring + age-based retention bound memory. A lifetime counter here used to make
  // always-on Instant Replay silently freeze after N mutations on a busy page.
  try {
    emit({ t: rel(), kind: 'mutation', html: snapshotBody() });
  } catch {
    // Snapshot errors must not surface.
  }
};

const scheduleFlush = throttle(() => {
  if (pendingMutation) flushMutation();
}, MUTATION_THROTTLE_MS);

// Emit a full, styled snapshot at relative time `t`: readable CSS immediately so
// the frame is never lost, then the async-enriched version (cross-origin CSS) at
// the same `t`. seekTo picks the LAST snapshot at/before a target, so the
// enriched one supersedes the readable one. Used for both the initial frame
// (t=0) and recurring always-on keyframes.
function emitSnapshot(t: number): void {
  try {
    emit({ t, kind: 'snapshot', html: snapshotFull() });
  } catch {
    /* never throw */
  }
  void collectInlineCssAsync()
    .then((css) => {
      if (enabled) emit({ t, kind: 'snapshot', html: buildFullSnapshot(css) });
    })
    .catch(() => {
      /* keep the readable-only snapshot already emitted */
    });
}

function enable(_alwaysOn = false): void {
  if (enabled) return;
  enabled = true;
  epoch = Date.now();

  emitSnapshot(0);
  startObserver();

  // Refresh a styled keyframe on an interval in EVERY mode. In always-on this
  // keeps a retained slice seekable; in a manual session it means long
  // recordings stay styled and seekable after the ring rolls past early frames
  // (a recent keyframe is always available as a seed). Cheap: one full snapshot
  // per interval vs. a mutation snapshot every 250ms.
  if (keyframeTimer === null) {
    keyframeTimer = setInterval(() => {
      if (enabled) emitSnapshot(rel());
    }, KEYFRAME_INTERVAL_MS);
  }
}

function disable(): void {
  enabled = false;
  observer?.disconnect(); // drops document + all shadow-root observations at once
  unsubscribeShadow?.();
  unsubscribeShadow = null;
  if (keyframeTimer !== null) {
    clearInterval(keyframeTimer);
    keyframeTimer = null;
  }
}

export function installDomRecorder(): void {
  try {
    _install();
  } catch {
    // Must never throw into the host page.
  }
}

function _install(): void {
  // Control channel from the ISOLATED content script. A session ('replay-on')
  // and always-on Instant Replay ('replay-always-on') are mutually exclusive —
  // the content script tears one down before starting the other.
  window.addEventListener('message', (event) => {
    if (event.source !== window || !isControlMessage(event.data)) return;
    if (event.data.action === 'replay-on') enable(false);
    else if (event.data.action === 'replay-always-on') enable(true);
    else if (event.data.action === 'replay-off') disable();
  });

  // Lightweight listeners stay installed but only emit while enabled.
  // capture:true so scrolls on inner elements (which don't bubble) are seen too;
  // we record the element's selector + offset so the replay can scroll the right
  // container, not just the window. (scroll on document → window scroll.)
  window.addEventListener(
    'scroll',
    throttle((e: Event) => {
      if (!enabled) return;
      const target = e.target;
      if (target instanceof Element && target !== document.documentElement && target !== document.body) {
        emit({ t: rel(), kind: 'scroll', selector: selectorFor(target), x: target.scrollLeft, y: target.scrollTop });
      } else {
        emit({ t: rel(), kind: 'scroll', x: window.scrollX, y: window.scrollY });
      }
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
