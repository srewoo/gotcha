import { describe, it, expect } from 'vitest';
import { generatePlaywrightTest } from '../../src/testgen/playwright';
import type { CaptureBundle } from '../../src/shared/types';

// ─── Fixture factory ──────────────────────────────────────────────────────────

function makeBundle(overrides: Partial<CaptureBundle> = {}): CaptureBundle {
  return {
    id: 'abc123def456',
    title: 'Login flow regression',
    console: [],
    network: [],
    steps: [],
    replay: [],
    environment: {
      url: 'https://app.example.com/login',
      userAgent: 'Mozilla/5.0',
      browser: 'Chrome',
      os: 'macOS',
      viewport: { width: 1280, height: 720 },
      dpr: 1,
      locale: 'en-US',
      capturedAt: 1700000000000,
    },
    redacted: true,
    createdAt: 1700000000000,
    ...overrides,
  };
}

// ─── Determinism ─────────────────────────────────────────────────────────────

describe('generatePlaywrightTest — determinism', () => {
  it('should produce byte-identical source when called twice with the same bundle', () => {
    const bundle = makeBundle({
      steps: [
        { id: 's1', kind: 'navigate', label: 'https://app.example.com/login', ts: 1700000000001 },
        { id: 's2', kind: 'click', selector: '[data-testid="submit-btn"]', label: 'Submit', ts: 1700000000002 },
      ],
    });
    const a = generatePlaywrightTest(bundle);
    const b = generatePlaywrightTest(bundle);
    expect(a.source).toBe(b.source);
    expect(a.filename).toBe(b.filename);
  });
});

// ─── Navigate step ───────────────────────────────────────────────────────────

describe('generatePlaywrightTest — navigate step', () => {
  it('should emit page.goto for the first navigate step', () => {
    const bundle = makeBundle({
      steps: [
        { id: 's1', kind: 'navigate', label: 'https://app.example.com/login', ts: 1700000000001 },
      ],
    });
    const { source } = generatePlaywrightTest(bundle);
    expect(source).toContain("page.goto('https://app.example.com/login')");
  });

  it('should emit a comment (not page.goto) for a second navigate step', () => {
    const bundle = makeBundle({
      steps: [
        { id: 's1', kind: 'navigate', label: 'https://app.example.com/login', ts: 1700000000001 },
        { id: 's2', kind: 'navigate', label: 'https://app.example.com/dashboard', ts: 1700000000005 },
      ],
    });
    const { source } = generatePlaywrightTest(bundle);
    // Second navigate must not call goto again
    const gotos = (source.match(/page\.goto/g) ?? []).length;
    expect(gotos).toBe(1);
    expect(source).toContain('// navigated to https://app.example.com/dashboard');
  });
});

// ─── Failed network entry ────────────────────────────────────────────────────

describe('generatePlaywrightTest — failed network entry', () => {
  it('should emit a status-guard assertion when a failed network entry exists', () => {
    const bundle = makeBundle({
      steps: [
        { id: 's1', kind: 'navigate', label: 'https://app.example.com/', ts: 1700000000001 },
      ],
      network: [
        {
          id: 'n1',
          url: 'https://api.example.com/api/v1/user',
          method: 'GET',
          status: 500,
          durationMs: 120,
          failed: true,
          ts: 1700000000002,
        },
      ],
    });
    const { source } = generatePlaywrightTest(bundle);
    expect(source).toContain('waitForResponse');
    expect(source).toContain('toBeLessThan(400)');
    expect(source).toContain('/api/v1/user');
  });

  it('should embed the actual failed status in the comment', () => {
    const bundle = makeBundle({
      network: [
        {
          id: 'n1',
          url: 'https://api.example.com/auth',
          method: 'POST',
          status: 403,
          durationMs: 80,
          failed: true,
          ts: 1700000000002,
        },
      ],
    });
    const { source } = generatePlaywrightTest(bundle);
    expect(source).toContain('403');
  });
});

// ─── Console errors ──────────────────────────────────────────────────────────

describe('generatePlaywrightTest — console error guard', () => {
  it('should emit console collectors and guards when error entries exist', () => {
    const bundle = makeBundle({
      console: [
        { id: 'c1', level: 'error', message: 'TypeError: Cannot read property of null', ts: 1700000000002 },
      ],
    });
    const { source } = generatePlaywrightTest(bundle);
    expect(source).toContain("page.on('console'");
    expect(source).toContain("page.on('pageerror'");
    expect(source).toContain('_consoleErrors');
    expect(source).toContain('TypeError: Cannot read property of null');
  });

  it('should NOT guard warn-level entries (kept out of regression signal)', () => {
    const bundle = makeBundle({
      console: [
        { id: 'c1', level: 'warn', message: 'Deprecated API call detected', ts: 1700000000002 },
      ],
    });
    const { source } = generatePlaywrightTest(bundle);
    // warn alone is not an app error → no console collector emitted at all.
    expect(source).not.toContain("page.on('console'");
  });

  it('should NOT guard third-party noise even at error level', () => {
    const bundle = makeBundle({
      console: [
        { id: 'c1', level: 'error', message: 'Snowplow: argmap.useCookies is deprecated.', ts: 1 },
        { id: 'c2', level: 'error', message: 'Unsatisfied version 10.1.1 of shared singleton module relay-runtime', ts: 2 },
        { id: 'c3', level: 'error', message: 'Deprecation Notice: Sentry Usage is deprecated and removed from SHELL.', ts: 3 },
      ],
    });
    const { source } = generatePlaywrightTest(bundle);
    expect(source).not.toContain("page.on('console'");
  });

  it('should guard only the real app error when mixed with vendor noise', () => {
    const bundle = makeBundle({
      console: [
        { id: 'c1', level: 'error', message: 'Snowplow: argmap.useCookies is deprecated.', ts: 1 },
        { id: 'c2', level: 'error', message: 'Error: Api Fail:/maintenance-banner?cname=emagine', ts: 2 },
        { id: 'c3', level: 'warn', message: 'Unsatisfied version 2.9.0 of shared singleton module react-intl', ts: 3 },
      ],
    });
    const { source } = generatePlaywrightTest(bundle);
    expect(source).toContain('Api Fail:/maintenance-banner');
    expect(source).not.toContain('Snowplow');
    expect(source).not.toContain('Unsatisfied version');
  });

  it('should not emit console collectors when there are no app errors', () => {
    const bundle = makeBundle({
      console: [
        { id: 'c1', level: 'log', message: 'Component rendered', ts: 1700000000002 },
      ],
    });
    const { source } = generatePlaywrightTest(bundle);
    expect(source).not.toContain("page.on('console'");
  });
});

// ─── String escaping ─────────────────────────────────────────────────────────

describe('generatePlaywrightTest — string escaping', () => {
  it('should handle single quotes in the bundle title without breaking the string literal', () => {
    // slugTitle() strips single quotes from the title rather than escaping them.
    // This means "It's a user's login bug" becomes "Its a users login bug".
    // The test() call must still produce a syntactically valid single-quoted string.
    const bundle = makeBundle({ title: "It's a user's login bug" });
    const { source } = generatePlaywrightTest(bundle);
    const testLine = source.split('\n').find((l) => l.startsWith('test('));
    expect(testLine).toBeDefined();
    // Quotes are stripped, not escaped — the output must not contain the raw apostrophes
    // that would break the surrounding single-quote literal.
    expect(testLine).not.toMatch(/test\('[^']*'[^']*'\)/);
    // And the title content appears (without apostrophes)
    expect(testLine).toContain('Its a users login bug');
  });

  it('should escape backslashes in selectors', () => {
    const bundle = makeBundle({
      steps: [
        {
          id: 's1',
          kind: 'click',
          selector: 'button[name="say \\"hello\\""]',
          label: 'Hello button',
          ts: 1700000000001,
        },
      ],
    });
    const { source } = generatePlaywrightTest(bundle);
    // Backslashes in the selector string must be double-escaped in the output
    expect(source).toContain('\\\\');
  });

  it('should escape single quotes in navigate labels', () => {
    const bundle = makeBundle({
      steps: [
        { id: 's1', kind: 'navigate', label: "https://example.com/user's-page", ts: 1700000000001 },
      ],
    });
    const { source } = generatePlaywrightTest(bundle);
    // Must not produce a broken string literal
    expect(source).toContain("\\'");
    // parse: the goto call must be syntactically valid (no raw unescaped ')
    const gotoLine = source.split('\n').find((l) => l.includes('page.goto'));
    expect(gotoLine).toBeDefined();
    // Check the string argument is properly quoted
    expect(gotoLine).toMatch(/page\.goto\('.*'\)/);
  });
});

// ─── Filename shape ──────────────────────────────────────────────────────────

describe('generatePlaywrightTest — filename', () => {
  it('should produce a .spec.ts filename starting with gotcha-', () => {
    const bundle = makeBundle();
    const { filename } = generatePlaywrightTest(bundle);
    expect(filename).toMatch(/^gotcha-.+\.spec\.ts$/);
  });

  it('should include "regression" in filename when there is no failed request', () => {
    const bundle = makeBundle({ network: [] });
    const { filename } = generatePlaywrightTest(bundle);
    expect(filename).toContain('regression');
  });

  it('should include the HTTP status code in filename when there is a failed request', () => {
    const bundle = makeBundle({
      network: [
        {
          id: 'n1',
          url: 'https://api.example.com/data',
          method: 'GET',
          status: 404,
          durationMs: 50,
          failed: true,
          ts: 1700000000002,
        },
      ],
    });
    const { filename } = generatePlaywrightTest(bundle);
    expect(filename).toContain('404');
  });

  it('should embed a slice of the bundle id in the filename', () => {
    const bundle = makeBundle({ id: 'abc123def456' });
    const { filename } = generatePlaywrightTest(bundle);
    // First 6 chars of id: "abc123"
    expect(filename).toContain('abc123');
  });
});

// ─── baseURL ─────────────────────────────────────────────────────────────────

describe('generatePlaywrightTest — baseURL', () => {
  it('should set test.use({ baseURL }) to the origin of the captured URL', () => {
    const bundle = makeBundle({
      environment: {
        url: 'https://staging.myapp.io/feature/checkout',
        userAgent: 'Mozilla/5.0',
        browser: 'Firefox',
        os: 'Linux',
        viewport: { width: 1280, height: 720 },
        dpr: 1,
        locale: 'en-US',
        capturedAt: 1700000000000,
      },
    });
    const { source } = generatePlaywrightTest(bundle);
    expect(source).toContain("baseURL: 'https://staging.myapp.io'");
  });

  it('should set the viewport from the captured environment', () => {
    const bundle = makeBundle({
      environment: {
        url: 'https://app.example.com/x',
        userAgent: 'Mozilla/5.0',
        browser: 'Chrome',
        os: 'macOS',
        viewport: { width: 1728, height: 958 },
        dpr: 2,
        locale: 'en-US',
        capturedAt: 1700000000000,
      },
    });
    const { source } = generatePlaywrightTest(bundle);
    expect(source).toContain('viewport: { width: 1728, height: 958 }');
  });
});

// ─── Multiple failed endpoints ────────────────────────────────────────────────

describe('generatePlaywrightTest — multiple failed endpoints', () => {
  const net = (id: string, path: string, status: number) => ({
    id,
    url: `https://api.example.com${path}`,
    method: 'GET',
    status,
    durationMs: 50,
    failed: true,
    ts: 1700000000000,
  });

  it('should emit a distinct regression guard for each distinct failed endpoint', () => {
    const bundle = makeBundle({
      network: [net('n1', '/a.css', 404), net('n2', '/b.css', 404), net('n3', '/c.css', 500)],
    });
    const { source } = generatePlaywrightTest(bundle);
    expect(source).toContain('/a.css');
    expect(source).toContain('/b.css');
    expect(source).toContain('/c.css');
    // Three guards → three indexed waiters, no variable collisions.
    expect((source.match(/page\.waitForResponse/g) ?? []).length).toBe(3);
    expect(source).toContain('_failedResponse0');
    expect(source).toContain('_failedResponse2');
  });

  it('should dedupe identical method+path failures', () => {
    const bundle = makeBundle({
      network: [net('n1', '/dupe', 500), net('n2', '/dupe', 500), net('n3', '/dupe', 500)],
    });
    const { source } = generatePlaywrightTest(bundle);
    expect((source.match(/page\.waitForResponse/g) ?? []).length).toBe(1);
  });

  it('should cap the number of guards at 5', () => {
    const bundle = makeBundle({
      network: Array.from({ length: 9 }, (_, i) => net(`n${i}`, `/chunk-${i}.css`, 404)),
    });
    const { source } = generatePlaywrightTest(bundle);
    expect((source.match(/page\.waitForResponse/g) ?? []).length).toBe(5);
  });
});

// ─── Locator conversions ─────────────────────────────────────────────────────

describe('generatePlaywrightTest — locator expression conversion', () => {
  it('should convert //aria: annotation to page.getByRole', () => {
    const bundle = makeBundle({
      steps: [
        {
          id: 's1',
          kind: 'click',
          selector: '//aria:button:Save document',
          label: 'Save',
          ts: 1700000000001,
        },
      ],
    });
    const { source } = generatePlaywrightTest(bundle);
    expect(source).toContain("page.getByRole('button', { name: 'Save document' })");
  });

  it('should convert //text: annotation to page.getByText', () => {
    const bundle = makeBundle({
      steps: [
        {
          id: 's1',
          kind: 'click',
          selector: '//text:Add to cart',
          label: 'Add to cart',
          ts: 1700000000001,
        },
      ],
    });
    const { source } = generatePlaywrightTest(bundle);
    expect(source).toContain("page.getByText('Add to cart', { exact: false })");
  });

  it('should convert [data-testid="…"] to page.getByTestId', () => {
    const bundle = makeBundle({
      steps: [
        {
          id: 's1',
          kind: 'click',
          selector: '[data-testid="submit-btn"]',
          label: 'Submit',
          ts: 1700000000001,
        },
      ],
    });
    const { source } = generatePlaywrightTest(bundle);
    expect(source).toContain("page.getByTestId('submit-btn')");
  });

  it('should use page.locator for plain CSS selectors', () => {
    const bundle = makeBundle({
      steps: [
        {
          id: 's1',
          kind: 'click',
          selector: '.modal > button.close',
          label: 'Close',
          ts: 1700000000001,
        },
      ],
    });
    const { source } = generatePlaywrightTest(bundle);
    expect(source).toContain("page.locator('.modal > button.close')");
  });
});

// ─── AI enhancement (gap #3, BYO-key) ─────────────────────────────────────────

describe('generatePlaywrightTest — AI enhancement', () => {
  it('should override the step selector with the AI-chosen one when provided', () => {
    const bundle = makeBundle({
      steps: [
        { id: 's1', kind: 'navigate', label: 'https://app.example.com/login', ts: 1 },
        { id: 's2', kind: 'click', selector: '.btn.btn-primary', label: 'Submit', ts: 2 },
      ],
    });
    const { source } = generatePlaywrightTest(bundle, {
      selectors: [{ stepId: 's2', selector: '[data-testid="submit"]' }],
    });
    expect(source).toContain('getByTestId');
    expect(source).not.toContain('.btn.btn-primary');
  });

  it('should append the AI-suggested end-state assertion verbatim', () => {
    const bundle = makeBundle({
      steps: [{ id: 's1', kind: 'navigate', label: 'https://app.example.com/home', ts: 1 }],
    });
    const { source } = generatePlaywrightTest(bundle, {
      endStateAssertion: "await expect(page.getByRole('heading')).toBeVisible();",
    });
    expect(source).toContain('AI-suggested end-state assertion');
    expect(source).toContain("await expect(page.getByRole('heading')).toBeVisible();");
  });

  it('should be identical to the baseline when no enhancement is passed (deterministic fallback)', () => {
    const bundle = makeBundle({
      steps: [{ id: 's1', kind: 'click', selector: '#go', label: 'Go', ts: 1 }],
    });
    expect(generatePlaywrightTest(bundle).source).toBe(
      generatePlaywrightTest(bundle, undefined).source,
    );
  });

  it('should emit a visible TODO (not silently drop) for a keypress step with no key', () => {
    const bundle = makeBundle({
      steps: [{ id: 's1', kind: 'keypress', label: 'pressed a key', ts: 1 }],
    });
    const { source } = generatePlaywrightTest(bundle);
    expect(source).toContain('TODO: keypress recorded with no key');
  });
});

describe('generatePlaywrightTest — step kinds', () => {
  it('emits fill() for an input step and press(key) for a keypress step', () => {
    const { source } = generatePlaywrightTest(
      makeBundle({
        steps: [
          { id: 's1', kind: 'input', selector: '#email', label: 'Email', value: 'a@b.com', ts: 1 },
          { id: 's2', kind: 'keypress', label: 'Enter', value: 'Enter', ts: 2 },
        ],
      }),
    );
    expect(source).toContain(".fill('a@b.com')");
    expect(source).toContain("page.keyboard.press('Enter')");
  });

  it('uses TODO_value for a hidden/absent input value', () => {
    const { source } = generatePlaywrightTest(
      makeBundle({ steps: [{ id: 's1', kind: 'input', selector: '#x', label: 'X', value: '«hidden»', ts: 1 }] }),
    );
    expect(source).toContain("fill('TODO_value')");
  });

  it('comments an input step with no stable selector', () => {
    const { source } = generatePlaywrightTest(
      makeBundle({ steps: [{ id: 's1', kind: 'input', label: 'Mystery field', ts: 1 }] }),
    );
    expect(source).toContain('no stable selector captured');
  });

  it('emits press(Enter) for a submit step and a comment when it has no selector', () => {
    const withSel = generatePlaywrightTest(
      makeBundle({ steps: [{ id: 's1', kind: 'submit', selector: '#form', label: 'Submit', ts: 1 }] }),
    ).source;
    expect(withSel).toContain(".press('Enter')");
    const noSel = generatePlaywrightTest(
      makeBundle({ steps: [{ id: 's1', kind: 'submit', label: 'Submit', ts: 1 }] }),
    ).source;
    expect(noSel).toContain('// submit Submit');
  });

  it('emits an alternative-selectors comment when candidates exist', () => {
    const { source } = generatePlaywrightTest(
      makeBundle({
        steps: [
          {
            id: 's1',
            kind: 'click',
            selector: '#go',
            selectorCandidates: ['#go', '.btn-primary', 'button'],
            label: 'Go',
            ts: 1,
          },
        ],
      }),
    );
    expect(source).toContain('Alternative selectors');
    expect(source).toContain('.btn-primary');
  });

  it('falls back to getByText when a click step has no selector', () => {
    const { source } = generatePlaywrightTest(
      makeBundle({ steps: [{ id: 's1', kind: 'click', label: 'Save changes', ts: 1 }] }),
    );
    expect(source).toContain("getByText('Save changes'");
  });

  it('emits a URL end-state assertion when the last step is a navigate and nothing failed', () => {
    const { source } = generatePlaywrightTest(
      makeBundle({ steps: [{ id: 's1', kind: 'navigate', label: 'https://app.example.com/home', ts: 1 }] }),
    );
    expect(source).toContain('toHaveURL');
    expect(source).toContain('confirm this is the correct expected URL');
  });
});
