import { describe, it, expect } from 'vitest';
import { isAppError, filterAppErrors } from '../../src/shared/console-noise';
import type { ConsoleEntry } from '../../src/shared/types';

const entry = (level: ConsoleEntry['level'], message: string): ConsoleEntry => ({
  id: message.slice(0, 6),
  level,
  message,
  ts: 1,
});

describe('console-noise — isAppError', () => {
  it('should keep an app-origin error', () => {
    expect(isAppError(entry('error', 'TypeError: Cannot read property of null'))).toBe(true);
    expect(isAppError(entry('error', 'Error: Api Fail:/maintenance-banner?cname=emagine'))).toBe(true);
    expect(isAppError(entry('error', 'WebSocket error: [object Event]'))).toBe(true);
  });

  it('should drop non-error levels', () => {
    expect(isAppError(entry('warn', 'TypeError somewhere'))).toBe(false);
    expect(isAppError(entry('log', 'Component rendered'))).toBe(false);
    expect(isAppError(entry('info', 'x'))).toBe(false);
    expect(isAppError(entry('debug', 'x'))).toBe(false);
  });

  it('should drop known vendor noise even at error level', () => {
    const noise = [
      'Snowplow: argmap.useLocalStorage is deprecated. Use argmap.stateStorageStrategy instead.',
      'Deprecation Notice: Sentry Usage is deprecated and removed from SHELL.',
      'Deprecation Notice: FullStory Usage is deprecated and removed from SHELL.',
      'Unsatisfied version 10.1.1 of shared singleton module relay-runtime (required ^10.1.3)',
      'Warning: fragment with name SnippetFragment already exists. graphql-tag enforces all fragment names',
    ];
    for (const m of noise) expect(isAppError(entry('error', m))).toBe(false);
  });
});

describe('console-noise — filterAppErrors', () => {
  it('should keep only the real app errors from a mixed, real-world console dump', () => {
    const entries: ConsoleEntry[] = [
      entry('warn', 'Snowplow: argmap.useCookies is deprecated.'),
      entry('error', 'Deprecation Notice: Sentry Usage is deprecated and removed from SHELL.'),
      entry('error', 'Unsatisfied version 2.9.0 from @mindtickle/ui-shell of shared singleton module react-intl'),
      entry('error', 'Error: Api Fail:/maintenance-banner?cname=emagine'),
      entry('error', 'WebSocket error: [object Event]'),
      entry('log', 'rendered'),
    ];
    const kept = filterAppErrors(entries).map((e) => e.message);
    expect(kept).toEqual([
      'Error: Api Fail:/maintenance-banner?cname=emagine',
      'WebSocket error: [object Event]',
    ]);
  });
});
