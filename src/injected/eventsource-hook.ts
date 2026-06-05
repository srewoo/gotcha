import { BRIDGE_MARKER, post } from './bridge';
import { uid } from '@shared/uid';
import type { NetworkEntry, SocketFrame } from '@shared/types';

// Matches the cap used in network-hook.ts — keep in sync.
const MAX_BODY = 16_384;
// Cap recv frames so a high-frequency SSE stream can't bloat the buffer.
const MAX_FRAMES = 50;

function clip(text: string): string {
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}… [${text.length} bytes total]` : text;
}

function emit(entry: NetworkEntry): void {
  post({ marker: BRIDGE_MARKER, type: 'network', entry });
}

// Guard against double-install.
let installed = false;

export function installEventSourceHook(): void {
  if (installed) return;
  installed = true;

  if (typeof EventSource === 'undefined') return;

  const NativeEventSource = EventSource;

  // Design decision: same two-emit strategy as the WebSocket hook.
  //   1. "open" entry — emitted when the SSE connection is established
  //      (readyState transitions to OPEN). Frames array is empty.
  //   2. "close/error" entry — emitted when the connection ends (error event),
  //      carrying all accumulated recv frames. EventSource automatically
  //      reconnects on transient errors; we emit on each error event so the
  //      reviewer can see reconnection cycles.
  //
  // Note: EventSource has no explicit "close" method that fires an event —
  // calling es.close() is silent. We therefore only have the error event to
  // signal termination. A closed EventSource has readyState === CLOSED.

  class GotchaEventSource extends NativeEventSource {
    private readonly __gotchaId: string = uid();
    private readonly __gotchaFrames: SocketFrame[] = [];
    private readonly __gotchaTs: number = Date.now();

    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);

      const entryUrl = String(url);

      // --- onopen: emit initial connection entry ---
      this.addEventListener('open', () => {
        try {
          const entry: NetworkEntry = {
            id: this.__gotchaId,
            url: entryUrl,
            // EventSource always uses GET.
            method: 'GET',
            status: 200,
            statusText: 'SSE stream opened',
            durationMs: Date.now() - this.__gotchaTs,
            failed: false,
            ts: this.__gotchaTs,
            transport: 'eventsource',
            frames: [],
          };
          emit(entry);
        } catch {
          // never throw into host page
        }
      });

      // --- onmessage: collect recv frames (unnamed "message" events) ---
      this.addEventListener('message', (event: MessageEvent) => {
        try {
          if (this.__gotchaFrames.length < MAX_FRAMES) {
            this.__gotchaFrames.push({
              dir: 'recv',
              data: clip(typeof event.data === 'string' ? event.data : String(event.data)),
              ts: Date.now(),
            });
          }
        } catch {
          // never throw
        }
      });

      // --- onerror: emit summary with frames collected so far ---
      // EventSource fires "error" both on reconnect cycles and on permanent
      // close. We emit every time so the reviewer sees the state transitions.
      this.addEventListener('error', () => {
        try {
          const closed = this.readyState === NativeEventSource.CLOSED;
          const entry: NetworkEntry = {
            // Reuse the connection id so this supersedes the "open" entry
            // instead of duplicating it (packager dedupes by id). (Issue #4)
            id: this.__gotchaId,
            url: entryUrl,
            method: 'GET',
            status: closed ? 0 : 200,
            statusText: closed ? 'SSE stream closed' : 'SSE reconnecting',
            durationMs: Date.now() - this.__gotchaTs,
            failed: closed,
            ts: this.__gotchaTs,
            transport: 'eventsource',
            frames: [...this.__gotchaFrames],
          };
          emit(entry);
        } catch {
          // never throw
        }
      });
    }
  }

  // Replace the global. The `as unknown as typeof EventSource` cast is
  // required because TypeScript doesn't allow extending built-in classes
  // without this pattern when replacing globals.
  window.EventSource = GotchaEventSource as unknown as typeof EventSource;
}
