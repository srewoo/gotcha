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

// Exported for unit testing.
export function serializeArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (arg === undefined) return 'undefined';
  if (typeof arg === 'function') return `[Function: ${arg.name || 'anonymous'}]`;
  if (typeof arg === 'bigint' || typeof arg === 'symbol') return String(arg);
  // DOM Events (incl. WebSocket error/close, ErrorEvent) stringify to a useless
  // "[object Event]" or "{}". Pull the diagnostic fields out instead — this is
  // why captured logs like "WebSocket error: [object Event]" carried no detail.
  if (typeof Event !== 'undefined' && arg instanceof Event) {
    const e = arg as Event & { message?: unknown; code?: unknown; reason?: unknown };
    const bits = [`type=${e.type}`];
    if (typeof e.message === 'string' && e.message) bits.push(`message=${e.message}`);
    if (typeof e.code === 'number') bits.push(`code=${e.code}`);
    if (typeof e.reason === 'string' && e.reason) bits.push(`reason=${e.reason}`);
    return `[${arg.constructor?.name ?? 'Event'} ${bits.join(' ')}]`;
  }
  try {
    // Circular-safe stringify: a plain JSON.stringify throws on cycles, which
    // previously collapsed the whole arg to "[object Object]" and lost the log.
    const seen = new WeakSet<object>();
    const json = JSON.stringify(arg, (_k, v: unknown) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      if (typeof v === 'bigint') return String(v);
      if (typeof v === 'function') return `[Function: ${(v as { name?: string }).name || 'anonymous'}]`;
      return v;
    });
    return json ?? String(arg);
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
