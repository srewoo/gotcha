// selector.ts — ranked, stable selector generation for Playwright test-gen.
//
// WHY this module exists: the old inline `selectorFor` fell back to
// `tag.class` using the first two class names, which is catastrophically flaky
// on Tailwind utilities (`hover:bg-blue-500`), CSS-module hashes (`_abc1f2`),
// and React auto-generated ids (`:r12:`). This module produces a prioritised
// list of candidate selectors, best-first, so the test-gen can emit the most
// stable locator and list the others as a fallback comment.
//
// Design constraints
// • Pure DOM — no chrome.* API, no network. Can be unit-tested via jsdom.
// • Never throws: every path returns a non-empty array.
// • Deterministic: same element ⇒ same ordered list.

// ─── Stability heuristics ───────────────────────────────────────────────────

/**
 * Returns true when a token looks like a human-authored stable identifier.
 * Rejects:
 *   - React fiber ids  `:r123:`, `:rA:`
 *   - Long hex hashes  `a3f8c12d9e…` (≥6 consecutive hex chars)
 *   - CSS-module hashes  `_abc123`, trailing `-[0-9a-f]{5,}`
 *   - Mostly-numeric ids  `123`, `item_0042`
 *   - Anything shorter than 2 characters
 *
 * WHY: auto-generated ids change every build/hydration. A selector that relies
 * on them will be green once and never again.
 */
export function looksStable(token: string): boolean {
  if (!token || token.length < 2) return false;

  // React floating ids like ":r12:" or ":rA:"
  if (/^:r[A-Za-z0-9]+:$/.test(token)) return false;

  // Pure hex strings of 6+ chars (very likely a hash)
  if (/^[0-9a-f]{6,}$/i.test(token)) return false;

  // CSS-module hash pattern: starts with underscore + alphanumeric suffix
  if (/^_[A-Za-z0-9]{4,}$/.test(token)) return false;

  // Trailing hash segment: `ButtonRoot-abc12` or `button--xyz9f`
  if (/-[0-9a-f]{5,}$/.test(token)) return false;

  // Mostly numeric (≥ half chars are digits) — e.g. `item_0042`, `345`
  const digits = (token.match(/\d/g) ?? []).length;
  if (digits / token.length >= 0.5) return false;

  return true;
}

/**
 * Returns true for a CSS class that should be filtered out when building a
 * scoped CSS path, because it's either a Tailwind utility or a hashed token.
 *
 * WHY: Tailwind classes encode *current* styling, not element identity.
 * A refactor that changes `bg-blue-500` to `bg-blue-600` shouldn't break a
 * regression test.
 */
function isUnstableClass(cls: string): boolean {
  // Tailwind responsive/state prefixes: `sm:`, `md:`, `hover:`, arbitrary
  // values `text-[14px]`, `w-[calc(…)]`. A match means the class encodes
  // styling, not identity → unstable.
  if (/^(?:sm:|md:|lg:|xl:|2xl:|hover:|focus:|active:|disabled:|dark:|group-|peer-|[a-z]+-\[)/.test(cls)) return true;
  // Re-use the same token heuristic for class names
  return !looksStable(cls);
}

// ─── Semantic candidate builders ────────────────────────────────────────────

/** Emit a `data-testid` / `data-test` / `data-cy` selector. These are the
 *  gold standard: teams add them specifically for automation stability. */
function testIdCandidate(el: Element): string | null {
  for (const attr of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
    const v = el.getAttribute(attr);
    if (v) return `[${attr}=${JSON.stringify(v)}]`;
  }
  return null;
}

/** Suggest a Playwright `getByRole` form when we can determine the ARIA role
 *  and accessible name. The string is annotated with a `// getByRole` prefix
 *  so the playwright.ts generator can detect and emit the semantic API call. */
function ariaCandidate(el: Element): string | null {
  // Explicit role overrides the implicit one
  const explicitRole = el.getAttribute('role');
  const tag = el.tagName.toLowerCase();

  // Map implicit ARIA roles for common elements
  const implicitRole: Record<string, string> = {
    button: 'button',
    a: 'link',
    input: '', // depends on type
    select: 'combobox',
    textarea: 'textbox',
    h1: 'heading', h2: 'heading', h3: 'heading',
    h4: 'heading', h5: 'heading', h6: 'heading',
    nav: 'navigation',
    main: 'main',
    form: 'form',
    dialog: 'dialog',
    table: 'table',
    checkbox: 'checkbox',
    radio: 'radio',
    img: 'img',
  };

  let role = explicitRole ?? implicitRole[tag] ?? '';

  // For <input>, the type governs the role
  if (tag === 'input' && !explicitRole) {
    const type = (el as HTMLInputElement).type?.toLowerCase();
    const inputRoles: Record<string, string> = {
      button: 'button', submit: 'button', reset: 'button',
      checkbox: 'checkbox', radio: 'radio',
      text: 'textbox', email: 'textbox', search: 'searchbox',
      tel: 'textbox', url: 'textbox', password: 'textbox',
      number: 'spinbutton', range: 'slider',
    };
    role = inputRoles[type] ?? '';
  }

  if (!role) return null;

  // Determine accessible name from aria-label, aria-labelledby text, or placeholder
  const ariaLabel = el.getAttribute('aria-label');
  const labelledById = el.getAttribute('aria-labelledby');
  let name = '';

  if (ariaLabel) {
    name = ariaLabel;
  } else if (labelledById) {
    // We're in main-world DOM so we can query
    const labelEl = el.ownerDocument?.getElementById(labelledById);
    if (labelEl) name = (labelEl.textContent ?? '').trim().replace(/\s+/g, ' ');
  } else if (tag === 'button' || tag === 'a') {
    name = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  } else {
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) name = placeholder;
  }

  if (!name) return null;

  // Encode as a comment-annotated selector so playwright.ts can detect it
  // Format: `// getByRole:role:name` — the generator strips the prefix
  return `//aria:${role}:${name}`;
}

/** `id` selector — only when the id looks stable (see `looksStable`). */
function idCandidate(el: Element): string | null {
  if (!el.id || !looksStable(el.id)) return null;
  return `#${CSS.escape(el.id)}`;
}

/** `name` attribute — reliable for form controls, stable across most builds. */
function nameCandidate(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  const formTags = new Set(['input', 'select', 'textarea', 'button']);
  if (!formTags.has(tag)) return null;
  const name = el.getAttribute('name');
  if (!name || !looksStable(name)) return null;
  return `${tag}[name=${JSON.stringify(name)}]`;
}

/** Visible text via `getByText` — good for buttons and links that have stable
 *  user-visible labels. Annotated so the generator emits the semantic call. */
function textCandidate(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  if (tag !== 'button' && tag !== 'a' && el.getAttribute('role') !== 'button') return null;
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
  if (!text || text.length > 80) return null;
  return `//text:${text}`;
}

// ─── Scoped CSS path (last resort) ──────────────────────────────────────────

/**
 * Build a scoped CSS selector walking up the DOM tree until we hit a stable
 * ancestor or `<body>`.
 *
 * WHY: Even when the element itself has only utility/hashed classes, an ancestor
 * might have a semantic class or id we can anchor to, making the path short and
 * resilient.
 *
 * Strategy:
 * 1. For the target element, collect non-unstable classes. If any remain,
 *    use `tag.cls1.cls2`. Otherwise use `tag:nth-of-type(n)`.
 * 2. Walk up until a stable anchor (id or semantic class on an ancestor) or body.
 * 3. Stop building once we have a path unique enough (≤3 segments).
 */
function cssPathCandidate(el: Element): string {
  const segments: string[] = [];

  let current: Element | null = el;
  let depth = 0;
  const MAX_DEPTH = 4;

  while (current && current !== document.body && depth < MAX_DEPTH) {
    const tag = current.tagName.toLowerCase();

    // Try stable id first — if found, anchor here and stop walking
    if (current.id && looksStable(current.id)) {
      segments.unshift(`#${CSS.escape(current.id)}`);
      break;
    }

    // Gather semantic (non-utility, non-hashed) classes
    const rawClasses =
      typeof current.className === 'string'
        ? current.className.trim().split(/\s+/).filter(Boolean)
        : [];
    const stableClasses = rawClasses.filter((c) => !isUnstableClass(c) && looksStable(c));

    if (stableClasses.length > 0) {
      // Use at most 2 stable class names to keep the selector short
      const clsPart = stableClasses.slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('');
      segments.unshift(`${tag}${clsPart}`);
    } else {
      // No stable classes — disambiguate with :nth-of-type
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === current!.tagName,
        );
        const index = siblings.indexOf(current) + 1; // 1-based
        segments.unshift(`${tag}:nth-of-type(${index})`);
      } else {
        segments.unshift(tag);
      }
    }

    // If the segment just added looks like a stable anchor, stop
    const head = segments[0];
    if (head?.startsWith('#') || (stableClasses.length > 0 && depth < 2)) {
      // Only stop early when we're 1+ levels deep and have a semantic class
      if (depth > 0) break;
    }

    current = current.parentElement;
    depth++;
  }

  return segments.join(' > ') || el.tagName.toLowerCase();
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns an ordered list of candidate selectors for `el`, best-first.
 *
 * Priority:
 *  1. data-testid / data-test / data-cy / data-qa  (most stable)
 *  2. ARIA role + accessible name (annotated `//aria:…` for the generator)
 *  3. Stable `id`
 *  4. `name` attribute (form controls)
 *  5. Visible text for buttons/links (annotated `//text:…`)
 *  6. Scoped CSS path (last resort)
 *
 * The list always has at least one entry (the CSS path fallback).
 */
export function rankedSelectors(el: Element): string[] {
  const candidates: string[] = [];

  const testId = testIdCandidate(el);
  if (testId) candidates.push(testId);

  const aria = ariaCandidate(el);
  if (aria) candidates.push(aria);

  const id = idCandidate(el);
  if (id) candidates.push(id);

  const name = nameCandidate(el);
  if (name) candidates.push(name);

  const text = textCandidate(el);
  if (text) candidates.push(text);

  // Always add the CSS path as the final fallback
  candidates.push(cssPathCandidate(el));

  return candidates;
}

/**
 * Returns the single best selector for `el` — the first entry from
 * `rankedSelectors`. Undefined only if `el` is null/undefined (never in
 * practice since we guard the call site).
 */
export function bestSelector(el: Element): string | undefined {
  return rankedSelectors(el)[0];
}
