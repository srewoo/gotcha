// Closed-shadow-root capture (MAIN world, document_start).
//
// `element.attachShadow({mode:'closed'})` hides the root — `element.shadowRoot`
// returns null — so our serializer can't reach it and the replay loses that
// subtree entirely. Because this module runs BEFORE the page's own scripts
// (document_start, MAIN world), we can wrap `attachShadow` and keep a private
// reference to every closed root, WITHOUT forcing it open: the page still sees
// `shadowRoot === null` and behaves identically, so this is non-intrusive.
//
// Limitation: closed roots created by the HTML parser from a declarative
// `<template shadowrootmode="closed">` in the initial markup never call
// attachShadow, so they can't be intercepted (rare).

const CLOSED_ROOTS = new WeakMap<Element, ShadowRoot>();

// Every shadow root we observe being attached (open AND closed), so the replay
// recorder can attach a MutationObserver to each. WHY: a MutationObserver on the
// document with `subtree:true` does NOT cross shadow boundaries, so DOM changes
// INSIDE web components never trigger a new replay snapshot — the component
// renders frozen at its first-frame state for the rest of the replay. Tracking
// every root lets the recorder watch inside them too, so component-internal
// updates (the common case in micro-frontends / design-system apps) replay
// faithfully. Held weakly so detached components can be GC'd.
const ALL_ROOTS = new WeakSet<ShadowRoot>();
// Strong list of currently-known roots for enumeration at record-start. Entries
// for disconnected hosts are skipped at use time (root.host.isConnected).
let liveRoots: ShadowRoot[] = [];
const subscribers = new Set<(root: ShadowRoot) => void>();

let installed = false;

export function installShadowRegistry(): void {
  if (installed) return;
  installed = true;
  try {
    const proto = Element.prototype;
    const original = proto.attachShadow;
    if (typeof original !== 'function') return;
    proto.attachShadow = function (
      this: Element,
      init: ShadowRootInit,
    ): ShadowRoot {
      const root = original.call(this, init);
      if (init && init.mode === 'closed') CLOSED_ROOTS.set(this, root);
      register(root);
      return root;
    };
  } catch {
    // Never throw into the host page; we just lose closed-root capture.
  }
}

function register(root: ShadowRoot): void {
  if (ALL_ROOTS.has(root)) return;
  ALL_ROOTS.add(root);
  liveRoots.push(root);
  for (const cb of subscribers) {
    try {
      cb(root);
    } catch {
      // A subscriber must never break attachShadow.
    }
  }
}

// Open roots are reachable via el.shadowRoot; this recovers closed ones.
export function closedRootFor(el: Element): ShadowRoot | null {
  return CLOSED_ROOTS.get(el) ?? null;
}

// All shadow roots whose host is still connected to the document.
export function connectedShadowRoots(): ShadowRoot[] {
  liveRoots = liveRoots.filter((r) => r.host?.isConnected);
  return liveRoots.slice();
}

// Subscribe to future shadow-root attachments. Returns an unsubscribe fn.
export function onShadowRoot(cb: (root: ShadowRoot) => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}
