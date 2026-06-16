import type { CaptureBundle, ReproStep, NetworkEntry, ConsoleEntry } from '@shared/types';
import { filterAppErrors } from '@shared/console-noise';

// ─── Playwright test generator ───────────────────────────────────────────────
//
// Repro bundle → a regression spec draft.
//
// The generated file is runnable as written: it drives the recorded steps and
// asserts concrete, capture-derived post-conditions — failed requests must now
// succeed, the exact console errors must not recur, the session must end on the
// captured URL, and the elements the user interacted with must still be present.
// Selectors are still best-effort (alternatives are emitted as comments for
// flaky cases), and a freshly-captured bug will fail until it's fixed — that's
// the point of a regression test.
//
// Deterministic: same capture ⇒ same spec source.

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Escape a string for single-quote JS literal use.
 *
 * WHY the line-break escapes: console messages, fill values and titles can
 * carry raw newlines (and the Unicode LS/PS separators, which are line
 * terminators in JS source). Left unescaped they split the literal across
 * lines and the generated spec fails to parse — "Unterminated string literal".
 */
const q = (s: string): string =>
  `'${s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')}'`;

// Collapse any whitespace run (incl. newlines) to a single space. Every
// bundle-derived string interpolated into a `//` comment must pass through
// this — a raw newline would end the comment and dump the rest of the string
// into code position, breaking the spec.
const inline = (s: string): string => s.replace(/\s+/g, ' ');

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return ''; }
}

// Pathname only — used for the waitForResponse glob so we (a) don't leak query
// tokens into the committed test and (b) match the endpoint regardless of
// volatile query params. (Issue #3)
function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

function slugTitle(title: string): string {
  // Collapse newlines too — the title lands inside a single-quoted literal AND
  // is human-read in the test name; a multi-line title makes sense as neither.
  return inline(title).replace(/'/g, '').slice(0, 80);
}

// ─── Selector → Playwright locator expression ────────────────────────────────

/**
 * Convert a candidate selector (possibly an annotated `//aria:…` or
 * `//text:…` string from selector.ts) into a Playwright locator call.
 *
 * WHY: the annotation scheme lets us emit semantic Playwright APIs
 * (getByRole, getByText, getByTestId) for the best candidate, which are far
 * more resilient than raw CSS `page.locator('…')`.
 */
function locatorExpr(selector: string): string {
  // ARIA annotation: //aria:<role>:<name>
  if (selector.startsWith('//aria:')) {
    const rest = selector.slice('//aria:'.length);
    const colon = rest.indexOf(':');
    if (colon !== -1) {
      const role = rest.slice(0, colon);
      const name = rest.slice(colon + 1);
      return `page.getByRole(${q(role)}, { name: ${q(name)} })`;
    }
  }
  // Text annotation: //text:<visible text>
  if (selector.startsWith('//text:')) {
    const text = selector.slice('//text:'.length);
    return `page.getByText(${q(text)}, { exact: false })`;
  }
  // Test-id attribute selector: [data-testid="…"], [data-cy="…"], etc.
  const testIdMatch = selector.match(/^\[(?:data-testid|data-test|data-cy|data-qa)=(.+)\]$/);
  if (testIdMatch) {
    // Strip surrounding JSON quotes from the captured value
    try {
      const raw = JSON.parse(testIdMatch[1]);
      return `page.getByTestId(${q(String(raw))})`;
    } catch {
      // fallthrough to raw locator
    }
  }
  // Plain CSS selector
  return `page.locator(${q(selector)})`;
}

/**
 * Emit a comment listing alternative selectors so a dev can swap if the primary
 * is flaky. We only emit the comment when there are alternatives beyond the
 * primary (index 0).
 *
 * WHY: the developer should know other options exist without having to re-run
 * the capture. The comment is placed on the line immediately before the action.
 */
function altSelectorsComment(candidates: string[] | undefined): string {
  if (!candidates || candidates.length <= 1) return '';
  const alts = candidates.slice(1).map((c) => `//     ${inline(c)}`).join('\n');
  return `  // Alternative selectors (swap if primary is flaky):\n${alts}\n`;
}

// ─── Step → Playwright statements ────────────────────────────────────────────

function stepToCode(step: ReproStep, isFirstNav: boolean): string | null {
  switch (step.kind) {
    case 'navigate':
      // The very first navigation seeds page.goto; later SPA navigations are
      // asserted rather than re-driven, since clicks already cause them.
      return isFirstNav
        ? `  await page.goto(${q(step.label)});`
        : `  // navigated to ${inline(step.label)}`;

    case 'click': {
      const altComment = altSelectorsComment(step.selectorCandidates);
      const expr = step.selector
        ? locatorExpr(step.selector)
        : `page.getByText(${q(step.label)}, { exact: false })`;
      return `${altComment}  await ${expr}.click();`;
    }

    case 'input': {
      if (!step.selector) return `  // input "${inline(step.label)}" — no stable selector captured`;
      const value = step.value && step.value !== '«hidden»' ? step.value : 'TODO_value';
      const altComment = altSelectorsComment(step.selectorCandidates);
      return `${altComment}  await ${locatorExpr(step.selector)}.fill(${q(value)});`;
    }

    case 'submit': {
      if (!step.selector) return `  // submit ${inline(step.label)}`;
      const altComment = altSelectorsComment(step.selectorCandidates);
      return `${altComment}  await ${locatorExpr(step.selector)}.press('Enter');`;
    }

    case 'keypress':
      return step.value
        ? `  await page.keyboard.press(${q(step.value)});`
        : `  // TODO: keypress recorded with no key — add the expected key manually.`;

    default:
      // Exhaustive over ReproStepKind today; if the enum grows, surface the
      // unhandled step as a visible TODO rather than silently dropping it.
      return `  // TODO: unsupported step kind '${(step as ReproStep).kind}' — drive this interaction manually.`;
  }
}

// ─── Assertion builders ──────────────────────────────────────────────────────

/**
 * 1. Failing-request guard: every request that failed must now succeed.
 *
 * WHY: this catches network regressions — the same endpoint returning a 4xx/5xx
 * again. We guard ALL distinct failed endpoints (capped), not just the first,
 * since a bug often shows up as several related requests failing together.
 */

// Cap how many failed endpoints we guard, so a cascade of failures (e.g. 18
// chunk 404s after one root failure) doesn't bloat the spec.
const MAX_FAILED_GUARDS = 5;

// Distinct failed endpoints, keyed by method + pathname (query/host stripped so
// volatile tokens don't fragment the set). Order-preserving + deterministic.
function distinctFailed(network: readonly NetworkEntry[]): NetworkEntry[] {
  const seen = new Map<string, NetworkEntry>();
  for (const n of network) {
    if (!n.failed) continue;
    const key = `${n.method} ${pathnameOf(n.url)}`;
    if (!seen.has(key)) seen.set(key, n);
  }
  return [...seen.values()].slice(0, MAX_FAILED_GUARDS);
}

function networkAssertions(failed: NetworkEntry[]): { setup: string; check: string } {
  if (failed.length === 0) return { setup: '', check: '' };
  const setups: string[] = [];
  const checks: string[] = [];
  failed.forEach((entry, i) => {
    const pattern = `**${pathnameOf(entry.url)}`;
    const v = `_failedResponse${i}`;
    const r = `_res${i}`;
    setups.push(`  const ${v} = page.waitForResponse(${q(pattern)});`);
    checks.push(
      [
        `  const ${r} = await ${v};`,
        `  // Regression guard — ${inline(`${entry.method} ${pathnameOf(entry.url)}`)} returned ${entry.status} when the bug was filed; it must now return < 400.`,
        `  expect(${r}.status(), \`\${${r}.request().method()} \${${r}.url()}\`).toBeLessThan(400);`,
      ].join('\n'),
    );
  });
  return { setup: setups.join('\n'), check: checks.join('\n\n') };
}

/**
 * 2. Console-error guard: the exact JS errors and pageerror messages captured
 *    in the bundle must not reappear.
 *
 * WHY: a network assertion alone cannot catch "the TypeError that crashed the
 * component" or "the unhandled promise rejection that silently broke the flow".
 * By asserting that the *specific* error strings don't recur, we turn the
 * filed bug's console noise into a permanent regression signal.
 *
 * Setup: `page.on('console')` + `page.on('pageerror')` collectors at the top
 * of the test, before any navigation.
 *
 * Check: after all actions, assert none of the recorded messages appear.
 */
function consoleErrorAssertion(consoleEntries: ConsoleEntry[]): {
  setup: string;
  check: string;
} {
  // Only app-origin errors — third-party deprecation / version-skew noise would
  // produce flaky guards that fail on unrelated dependency churn.
  const errors = filterAppErrors(consoleEntries);
  if (errors.length === 0) return { setup: '', check: '' };

  // Deduplicate by message prefix (first 120 chars) to avoid overly specific
  // assertions on messages with dynamic ids/timestamps embedded.
  const unique = Array.from(
    new Map(errors.map((e) => [e.message.slice(0, 120), e])).values(),
  );

  const setup = [
    '  // Collect console errors and page crashes during the run.',
    '  const _consoleErrors: string[] = [];',
    "  page.on('console', (msg) => {",
    "    if (msg.type() === 'error' || msg.type() === 'warning') {",
    '      _consoleErrors.push(msg.text());',
    '    }',
    '  });',
    "  page.on('pageerror', (err) => _consoleErrors.push(err.message));",
  ].join('\n');

  const checks = unique.map((e) => {
    // Raw slice into q() — q() now performs ALL escaping (backslash, quote,
    // newline). Pre-escaping here would double-escape and the runtime
    // includes() would then look for a string the page never logs.
    const snippet = e.message.slice(0, 120);
    return [
      `  // Console ${e.level} captured when the bug was filed:`,
      `  //   ${inline(snippet)}`,
      `  expect(_consoleErrors.some((m) => m.includes(${q(snippet)}))).toBe(false);`,
    ].join('\n');
  });

  return { setup, check: checks.join('\n') };
}

/**
 * 3. End-state assertions: concrete, capture-derived post-conditions — not TODO
 *    stubs. Every assertion here is grounded in something we actually observed
 *    at capture time, so the generated spec is runnable as written:
 *
 *      a. Final URL — the URL the session ended on, matched by pathname so
 *         volatile query/hash tokens don't make the assertion flaky.
 *      b. Interacted elements — the element behind the last click/input/submit
 *         was present and operable when captured, so it must still be visible
 *         after the fix. This catches "the button vanished / the form broke".
 *      c. Echoed input — when a non-sensitive value was typed into a field, the
 *         field should still hold that value at the end (catches inputs that
 *         silently reset).
 *
 * These run in ADDITION to the network + console guards. An AI-supplied
 * end-state assertion (enhancement.endStateAssertion) augments rather than
 * replaces them.
 */

// Build a RegExp literal matching a URL's pathname, anchored, regex-escaped.
// WHY a regex (not a string): toHaveURL with a string demands an exact, full
// match including query string — captured query tokens (?token=…, cache-busters)
// would make the assertion fail on every run. Matching the pathname is the
// stable, accurate signal for "the user ended up here".
function urlPathRegexLiteral(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split('?')[0] ?? url;
  }
  const escaped = path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return `/${escaped}/`;
}

// The last step that targeted a concrete element (click/input/submit with a
// selector). Its element was operable at capture, so it's a sound visibility
// assertion target after the fix.
function lastInteractedStep(steps: readonly ReproStep[]): ReproStep | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    if ((s.kind === 'click' || s.kind === 'input' || s.kind === 'submit') && s.selector) {
      return s;
    }
  }
  return undefined;
}

function endStateAssertion(steps: readonly ReproStep[], envUrl: string): string {
  const lines: string[] = [];

  // a. Final URL (path-matched). Prefer the last recorded navigation target;
  // fall back to the environment URL the capture ended on.
  const lastNav = [...steps].reverse().find((s) => s.kind === 'navigate');
  const finalUrl = lastNav?.label ?? envUrl;
  if (finalUrl) {
    lines.push('  // The session ended on this URL (matched by path, ignoring volatile query params).');
    lines.push(`  await expect(page).toHaveURL(${urlPathRegexLiteral(finalUrl)});`);
  }

  // b. The last element the user interacted with must still be visible.
  const interacted = lastInteractedStep(steps);
  if (interacted?.selector) {
    lines.push(`  // The element you last interacted with (${inline(interacted.label)}) must still be present.`);
    lines.push(`  await expect(${locatorExpr(interacted.selector)}).toBeVisible();`);
  }

  // c. Echoed input value — non-sensitive typed values should persist.
  const lastInput = [...steps]
    .reverse()
    .find((s) => s.kind === 'input' && s.selector && s.value && s.value !== '«hidden»');
  if (lastInput?.selector && lastInput.value) {
    lines.push('  // The value typed during the repro should still be present in the field.');
    lines.push(`  await expect(${locatorExpr(lastInput.selector)}).toHaveValue(${q(lastInput.value)});`);
  }

  return lines.join('\n');
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface GeneratedTest {
  filename: string;
  source: string;
}

/**
 * Optional AI enhancement (gap #3, BYO-key). Shape mirrors AiAnalysis.testHints
 * so the review screen can pass `bundle.aiAnalysis?.testHints` straight through.
 * When omitted, generation is the deterministic baseline (the no-key fallback).
 */
export interface TestEnhancement {
  endStateAssertion?: string | undefined;
  selectors?: ReadonlyArray<{ stepId: string; selector: string }> | undefined;
}

export function generatePlaywrightTest(
  bundle: CaptureBundle,
  enhancement?: TestEnhancement,
): GeneratedTest {
  const baseURL = originOf(bundle.environment.url);
  const failedList = distinctFailed(bundle.network);
  const failed = failedList[0];

  const netAssertion = networkAssertions(failedList);
  const consoleAssertion = consoleErrorAssertion(bundle.console);

  // AI-chosen selector per step (best from the candidates we recorded). Resolve
  // it into a concrete steps array up front so BOTH the actions and the
  // end-state assertions reference the chosen selector consistently.
  const override = new Map((enhancement?.selectors ?? []).map((s) => [s.stepId, s.selector]));
  const resolvedSteps: ReproStep[] = bundle.steps.map((step) => {
    const chosen = override.get(step.id);
    return chosen ? { ...step, selector: chosen } : step;
  });

  // Always emit the deterministic, capture-derived end-state assertions; when an
  // AI hint is present, append it as an extra (clearly labelled) assertion rather
  // than replacing the grounded ones.
  const deterministicEnd = endStateAssertion(resolvedSteps, bundle.environment.url);
  const endAssertion = enhancement?.endStateAssertion
    ? [
        deterministicEnd,
        '  // AI-suggested end-state assertion — review before trusting.',
        `  ${enhancement.endStateAssertion.trim()}`,
      ]
        .filter((l) => l !== '')
        .join('\n')
    : deterministicEnd;

  // Resolve step actions
  let seenNav = false;
  const actions: string[] = [];
  for (const effective of resolvedSteps) {
    const isFirstNav = effective.kind === 'navigate' && !seenNav;
    if (effective.kind === 'navigate' && !seenNav) seenNav = true;
    const code = stepToCode(effective, isFirstNav);
    if (code) actions.push(code);
  }

  // Assemble test body
  // Order: console collectors → network response waiter → actions → assertions
  const bodyParts: string[] = [];

  if (consoleAssertion.setup) {
    bodyParts.push(consoleAssertion.setup);
    bodyParts.push('');
  }
  if (netAssertion.setup) {
    bodyParts.push(netAssertion.setup);
  }
  bodyParts.push(...actions);
  bodyParts.push('');

  const hasAnyAssertion =
    netAssertion.check || consoleAssertion.check || endAssertion;

  if (hasAnyAssertion) {
    bodyParts.push('  // ── Regression assertions ──────────────────────────────────────────────');
  }
  if (netAssertion.check) bodyParts.push(netAssertion.check);
  if (consoleAssertion.check) bodyParts.push(consoleAssertion.check);
  if (endAssertion) bodyParts.push(endAssertion);

  const body = bodyParts.filter((l) => l !== undefined).join('\n');

  const slug = (failed ? `${failed.status}` : 'regression') + '-' + bundle.id.slice(0, 6);

  const source = `import { test, expect } from '@playwright/test';

// ┌─────────────────────────────────────────────────────────────────────────┐
// │  GENERATED DRAFT — Gotcha regression test                               │
// │  Report: ${inline(bundle.id)}
// │  Captured: ${new Date(bundle.createdAt).toISOString()}
// │  Browser: ${inline(`${bundle.environment.browser} · ${bundle.environment.os}`)}
// │                                                                         │
// │  This spec is runnable as written. Notes:                              │
// │     1. Selectors marked with "Alternative selectors" comments may need  │
// │        confirmation against your live app — annotate elements with      │
// │        data-testid for lasting stability.                               │
// │     2. Assertions are derived from the capture; a freshly-filed bug     │
// │        will fail until it is fixed (that is the regression signal).     │
// │     3. Console-error guards check for the EXACT messages captured;     │
// │        update them if the wording changes after the fix.               │
// └─────────────────────────────────────────────────────────────────────────┘
// Viewport matches the capture, so layout-dependent repros (responsive
// breakpoints, off-screen elements) behave the same as when the bug was filed.
test.use({ baseURL: ${q(baseURL)}, viewport: { width: ${bundle.environment.viewport.width}, height: ${bundle.environment.viewport.height} } });

test(${q(slugTitle(bundle.title))}, async ({ page }) => {
${body}
});
`;

  return { filename: `gotcha-${slug}.spec.ts`, source };
}
