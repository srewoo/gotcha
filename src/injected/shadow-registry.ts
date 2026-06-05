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
      return root;
    };
  } catch {
    // Never throw into the host page; we just lose closed-root capture.
  }
}

// Open roots are reachable via el.shadowRoot; this recovers closed ones.
export function closedRootFor(el: Element): ShadowRoot | null {
  return CLOSED_ROOTS.get(el) ?? null;
}
