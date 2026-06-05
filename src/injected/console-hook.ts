import { BRIDGE_MARKER, post } from './bridge';
import { uid } from '@shared/uid';
import type { ConsoleLevel } from '@shared/types';

// KNOWN TRADEOFF (issue #5): wrapping console.* means DevTools attributes every
// log to this wrapper's source line instead of the original caller. That's
// inherent to monkey-patching the console and is the price of capturing logs
// without a banner. Deep-capture (CDP) mode reads console events via the
// DevTools protocol instead, so it preserves original source locations — prefer
// it when accurate log provenance matters.

const LEVELS: ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug'];

function serializeArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

// Wrap console.* without breaking the page's own logging. We forward a copy
// to the bridge, then call the original so devtools behaves normally.
export function installConsoleHook(): void {
  for (const level of LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      post({
        marker: BRIDGE_MARKER,
        type: 'console',
        entry: {
          id: uid(),
          level,
          message: args.map(serializeArg).join(' '),
          ts: Date.now(),
        },
      });
      original(...args);
    };
  }
}
