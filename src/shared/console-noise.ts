import type { ConsoleEntry } from './types';

// Third-party / framework console noise that must never become a regression
// guard or be fed to the LLM as a "bug" signal. These are vendor deprecations,
// Module-Federation singleton version-skew warnings, and library lint warnings
// — none are app errors tied to a filed bug, and guarding them produces flaky
// tests that fail on unrelated dependency churn.
const NOISE: readonly RegExp[] = [
  /^snowplow:/i, // analytics tracker deprecation chatter
  /^deprecation notice:/i, // shell vendor removals (Sentry / FullStory / …)
  /unsatisfied version/i, // webpack Module Federation shared-singleton skew
  /graphql-tag enforces|fragment with name .+ already exists/i, // duplicate GraphQL fragment lint
  /\bfullstory\b/i,
];

function isNoise(message: string): boolean {
  return NOISE.some((re) => re.test(message));
}

// Keep only app-origin ERRORS worth turning into a regression signal: drop
// warn/log/info/debug (overwhelmingly framework chatter) and drop known vendor
// noise even when it's logged at error level.
export function isAppError(entry: ConsoleEntry): boolean {
  return entry.level === 'error' && !isNoise(entry.message);
}

export function filterAppErrors(entries: readonly ConsoleEntry[]): ConsoleEntry[] {
  return entries.filter(isAppError);
}
