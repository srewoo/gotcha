/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest';
import { looksStable, rankedSelectors, bestSelector } from '../../src/testgen/selector';

// ─── looksStable ─────────────────────────────────────────────────────────────

describe('looksStable', () => {
  it('should return true for a plain human-authored id', () => {
    expect(looksStable('submit-button')).toBe(true);
    expect(looksStable('login-form')).toBe(true);
    expect(looksStable('navbar')).toBe(true);
  });

  it('should return false for a React floating id like :r12:', () => {
    expect(looksStable(':r12:')).toBe(false);
    expect(looksStable(':rA:')).toBe(false);
    expect(looksStable(':r0:')).toBe(false);
  });

  it('should return false for pure hex hashes of 6+ chars', () => {
    expect(looksStable('a3f8c1')).toBe(false);
    expect(looksStable('deadbeef')).toBe(false);
    expect(looksStable('ABC123')).toBe(false);
  });

  it('should return true for a short hex string under 6 chars', () => {
    expect(looksStable('ab12e')).toBe(true); // only 5 hex chars
  });

  it('should return false for CSS-module hash pattern starting with underscore', () => {
    expect(looksStable('_abc123')).toBe(false);
    expect(looksStable('_XyZA9f')).toBe(false);
  });

  it('should return false for tokens with trailing hash segments like ButtonRoot-abc12', () => {
    // ButtonRoot-abc12 ends with "-abc12" which is 5+ hex chars — rejected as hash
    expect(looksStable('ButtonRoot-abc12')).toBe(false);
    // button--xyz9f: "xyz9f" contains x,y,z which are not hex — pattern requires [0-9a-f]{5,}
    // so this does NOT match the trailing-hash rule; looksStable returns true for it
    expect(looksStable('button--xyz9f')).toBe(true);
  });

  it('should return false for purely-numeric tokens', () => {
    expect(looksStable('345')).toBe(false);
    // item_0042: 4 digits out of 9 chars = 44% < 50%; does NOT trigger mostly-numeric rule
    expect(looksStable('item_0042')).toBe(true);
  });

  it('should return false for tokens shorter than 2 chars', () => {
    expect(looksStable('')).toBe(false);
    expect(looksStable('a')).toBe(false);
  });
});

// ─── rankedSelectors — data-testid wins ──────────────────────────────────────

describe('rankedSelectors — data-testid priority', () => {
  it('should put data-testid selector first when present', () => {
    const el = document.createElement('button');
    el.setAttribute('data-testid', 'submit-btn');
    el.textContent = 'Submit';
    document.body.appendChild(el);

    const candidates = rankedSelectors(el);
    expect(candidates[0]).toBe('[data-testid="submit-btn"]');

    document.body.removeChild(el);
  });

  it('should put data-cy selector first when present', () => {
    const el = document.createElement('input');
    el.setAttribute('data-cy', 'email-input');
    document.body.appendChild(el);

    const candidates = rankedSelectors(el);
    expect(candidates[0]).toBe('[data-cy="email-input"]');

    document.body.removeChild(el);
  });

  it('should put data-test selector first when present', () => {
    const el = document.createElement('div');
    el.setAttribute('data-test', 'card-component');
    document.body.appendChild(el);

    const candidates = rankedSelectors(el);
    expect(candidates[0]).toBe('[data-test="card-component"]');

    document.body.removeChild(el);
  });
});

// ─── rankedSelectors — hashed/React ids rejected ─────────────────────────────

describe('rankedSelectors — hashed and React ids are rejected', () => {
  it('should not include a React floating id like :r12: in candidates', () => {
    const el = document.createElement('button');
    el.id = ':r12:';
    el.textContent = 'Click me';
    document.body.appendChild(el);

    const candidates = rankedSelectors(el);
    expect(candidates.some((c) => c === '#\\:r12\\:')).toBe(false);
    // Must still return at least one candidate (the CSS fallback)
    expect(candidates.length).toBeGreaterThan(0);

    document.body.removeChild(el);
  });

  it('should not include a pure hex hash id in candidates', () => {
    const el = document.createElement('div');
    el.id = 'a3f8c1d9';
    document.body.appendChild(el);

    const candidates = rankedSelectors(el);
    // The id should be excluded because it looks like a hash
    expect(candidates.some((c) => c.startsWith('#a3f8c1d9'))).toBe(false);

    document.body.removeChild(el);
  });

  it('should use a stable id like "main-nav" in candidates', () => {
    const el = document.createElement('nav');
    el.id = 'main-nav';
    document.body.appendChild(el);

    const candidates = rankedSelectors(el);
    expect(candidates).toContain('#main-nav');

    document.body.removeChild(el);
  });
});

// ─── rankedSelectors — Tailwind/utility classes filtered from CSS fallback ───

describe('rankedSelectors — Tailwind classes filtered out of CSS fallback', () => {
  it('should not include hover: or responsive prefixed Tailwind classes in the CSS path', () => {
    // isUnstableClass must treat Tailwind responsive/state utilities as
    // unstable so they never leak into the generated selector — a refactor
    // from bg-blue-500 → bg-blue-600 must not break a regression test.
    const el = document.createElement('div');
    el.className = 'hover:bg-blue-500 md:text-lg focus:ring-2';
    document.body.appendChild(el);

    const candidates = rankedSelectors(el);
    const cssPath = candidates[candidates.length - 1]!;
    expect(cssPath).not.toContain('hover');
    expect(cssPath).not.toContain('md:');
    expect(cssPath).not.toContain('focus:');

    document.body.removeChild(el);
  });

  it('should use a semantic class when present alongside utility classes', () => {
    const el = document.createElement('div');
    el.className = 'user-card p-4 rounded-lg shadow-md';
    document.body.appendChild(el);

    const candidates = rankedSelectors(el);
    // "user-card" is a stable class; it should appear in the CSS path
    expect(candidates.some((c) => c.includes('user-card'))).toBe(true);

    document.body.removeChild(el);
  });
});

// ─── rankedSelectors — ranking order best-first ───────────────────────────────

describe('rankedSelectors — ranking order', () => {
  it('should return testid > aria > id > CSS path order for a button with all', () => {
    const el = document.createElement('button');
    el.setAttribute('data-testid', 'my-btn');
    el.id = 'stable-btn';
    el.setAttribute('aria-label', 'Save document');
    el.textContent = 'Save';
    document.body.appendChild(el);

    const candidates = rankedSelectors(el);
    const testIdIndex = candidates.findIndex((c) => c.startsWith('[data-testid'));
    const ariaIndex = candidates.findIndex((c) => c.startsWith('//aria:'));
    const idIndex = candidates.findIndex((c) => c.startsWith('#'));

    expect(testIdIndex).toBe(0); // testid is first
    expect(ariaIndex).toBeGreaterThan(testIdIndex); // aria comes after testid
    expect(idIndex).toBeGreaterThan(ariaIndex); // id comes after aria

    document.body.removeChild(el);
  });

  it('should always include at least one candidate (CSS path fallback) even for bare div', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);

    const candidates = rankedSelectors(el);
    expect(candidates.length).toBeGreaterThan(0);
    expect(typeof candidates[candidates.length - 1]).toBe('string');
    expect((candidates[candidates.length - 1] as string).length).toBeGreaterThan(0);

    document.body.removeChild(el);
  });

  it('should produce //aria: annotation for button with aria-label', () => {
    const el = document.createElement('button');
    el.setAttribute('aria-label', 'Close dialog');
    document.body.appendChild(el);

    const candidates = rankedSelectors(el);
    expect(candidates.some((c) => c === '//aria:button:Close dialog')).toBe(true);

    document.body.removeChild(el);
  });

  it('should produce //text: annotation for a button with text content', () => {
    const el = document.createElement('button');
    el.textContent = 'Add to cart';
    document.body.appendChild(el);

    const candidates = rankedSelectors(el);
    expect(candidates.some((c) => c === '//text:Add to cart')).toBe(true);

    document.body.removeChild(el);
  });

  it('should produce name attribute selector for a form input', () => {
    const el = document.createElement('input');
    el.setAttribute('name', 'username');
    document.body.appendChild(el);

    const candidates = rankedSelectors(el);
    expect(candidates.some((c) => c === 'input["username"]' || c === 'input[name="username"]')).toBe(true);

    document.body.removeChild(el);
  });
});

// ─── bestSelector ─────────────────────────────────────────────────────────────

describe('bestSelector', () => {
  it('should return the first candidate from rankedSelectors', () => {
    const el = document.createElement('button');
    el.setAttribute('data-testid', 'save-btn');
    document.body.appendChild(el);

    expect(bestSelector(el)).toBe('[data-testid="save-btn"]');

    document.body.removeChild(el);
  });

  it('should always return a non-empty string for any element', () => {
    const el = document.createElement('span');
    document.body.appendChild(el);

    const sel = bestSelector(el);
    expect(typeof sel).toBe('string');
    expect(sel!.length).toBeGreaterThan(0);

    document.body.removeChild(el);
  });
});
