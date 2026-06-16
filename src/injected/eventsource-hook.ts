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
  //      reconnects on transient errors; we re-emit on each error event, and
  //      since the packager dedupes by id keeping the last, the stored entry
  //      reflects the LATEST connection state (not each reconnection cycle).
  //
  // Note: EventSource has no explicit "close" method that fires an event —
  // calling es.close() is silent. We therefore only have the error event to
  // signal termination. A closed EventSource has readyState === CLOSED.

  class GotchaEventSource extends NativeEventSource {
    private readonly __gotchaId: string = uid();
    private readonly __gotchaFrames: SocketFrame[] = [];
    private readonly __gotchaTs: number = Date.now();
    // Custom event types we've already attached a recorder listener for, so a
    // page registering several listeners for one type records each event once.
    private readonly __gotchaHooked = new Set<string>();

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
        this.__gotchaRecord(event.data);
      });

      // --- onerror: emit summary with frames collected so far ---
      // EventSource fires "error" both on reconnect cycles and on permanent
      // close. We emit every time; the packager dedupes by id keeping the
      // last, so the stored entry reflects the latest connection state.
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

    // Record one recv frame (capped, sliding window). At cap, drop the OLDEST
    // frame: the most recent events sit nearest the bug, so freezing the
    // buffer at the first N would lose them. Named events carry their type as
    // a "<type>: " prefix since SocketFrame has no dedicated field for it.
    private __gotchaRecord(data: unknown, type?: string): void {
      try {
        const text = clip(typeof data === 'string' ? data : String(data));
        if (this.__gotchaFrames.length >= MAX_FRAMES) this.__gotchaFrames.shift();
        this.__gotchaFrames.push({
          dir: 'recv',
          data: type ? `${type}: ${text}` : text,
          ts: Date.now(),
        });
      } catch {
        // never throw
      }
    }

    // Servers using `event: <name>` lines deliver NAMED events that never fire
    // the plain "message" listener (most LLM/streaming APIs do this). Mirror
    // the page's own registrations: the first time it listens for a custom
    // type, attach ONE recorder listener for that type too. open/error/message
    // are already wired in the constructor.
    override addEventListener<K extends keyof EventSourceEventMap>(
      type: K,
      listener: (this: EventSource, ev: EventSourceEventMap[K]) => unknown,
      options?: boolean | AddEventListenerOptions,
    ): void;
    override addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void;
    override addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      try {
        if (
          type !== 'open' &&
          type !== 'error' &&
          type !== 'message' &&
          this.__gotchaHooked !== undefined &&
          !this.__gotchaHooked.has(type)
        ) {
          this.__gotchaHooked.add(type);
          super.addEventListener(type, ((event: MessageEvent) => {
            this.__gotchaRecord(event.data, type);
          }) as EventListener);
        }
      } catch {
        // recorder wiring must never block the page's own registration
      }
      super.addEventListener(type, listener as EventListener, options);
    }
  }

  // Replace the global. The `as unknown as typeof EventSource` cast is
  // required because TypeScript doesn't allow extending built-in classes
  // without this pattern when replacing globals.
  window.EventSource = GotchaEventSource as unknown as typeof EventSource;
}
