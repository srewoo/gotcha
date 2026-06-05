import { BRIDGE_MARKER, post } from './bridge';
import { uid } from '@shared/uid';
import type { NetworkEntry, SocketFrame } from '@shared/types';

// Matches the cap used in network-hook.ts — keep in sync.
const MAX_BODY = 16_384;
// Cap the number of frames stored per socket so a chatty connection cannot
// bloat the in-memory buffer indefinitely.
const MAX_FRAMES = 50;

function clip(text: string): string {
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}… [${text.length} bytes total]` : text;
}

function emit(entry: NetworkEntry): void {
  post({ marker: BRIDGE_MARKER, type: 'network', entry });
}

// Serialise WebSocket message data (string, ArrayBuffer, Blob) into a
// displayable string, clipped to MAX_BODY.
function serializeWsData(data: unknown): string {
  try {
    if (typeof data === 'string') return clip(data);
    if (data instanceof ArrayBuffer)
      return clip(`[ArrayBuffer byteLength=${data.byteLength}]`);
    if (typeof Blob !== 'undefined' && data instanceof Blob)
      return clip(`[Blob type=${data.type} size=${data.size}]`);
    return clip(String(data));
  } catch {
    return '[unserializable]';
  }
}

// Guard against double-install (script may be re-evaluated by the page).
let installed = false;

export function installWebSocketHook(): void {
  if (installed) return;
  installed = true;

  if (typeof WebSocket === 'undefined') return;

  const NativeWebSocket = WebSocket;

  // Design decision: two-emit strategy.
  //   1. "open" entry — emitted immediately when the WebSocket handshake
  //      succeeds (status 101). Frames array is empty at this point.
  //   2. "close" entry — emitted when the connection closes, carrying the
  //      full frames snapshot. This gives the reviewer both a live indicator
  //      that a socket opened AND a complete message timeline after it ends.
  // We do NOT emit on every frame to avoid thundering-herd traffic through
  // postMessage on chatty sockets.

  class GotchaWebSocket extends NativeWebSocket {
    // Per-socket state tracked as instance fields.
    private readonly __gotchaId: string = uid();
    private readonly __gotchaFrames: SocketFrame[] = [];
    private readonly __gotchaTs: number = Date.now();

    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);

      const entryUrl = String(url);

      // --- onopen: emit the initial "handshake opened" entry ---
      this.addEventListener('open', () => {
        try {
          const entry: NetworkEntry = {
            id: this.__gotchaId,
            url: entryUrl,
            method: 'GET',
            status: 101,
            statusText: 'Switching Protocols',
            durationMs: Date.now() - this.__gotchaTs,
            failed: false,
            ts: this.__gotchaTs,
            transport: 'websocket',
            frames: [],
          };
          emit(entry);
        } catch {
          // never throw into host page
        }
      });

      // --- onmessage: collect recv frames (capped) ---
      this.addEventListener('message', (event: MessageEvent) => {
        try {
          if (this.__gotchaFrames.length < MAX_FRAMES) {
            this.__gotchaFrames.push({
              dir: 'recv',
              data: serializeWsData(event.data),
              ts: Date.now(),
            });
          }
        } catch {
          // never throw
        }
      });

      // --- onerror / onclose: emit final summary with all frames ---
      const emitClose = (failed: boolean) => {
        try {
          const entry: NetworkEntry = {
            // Reuse the socket's id so this SUPERSEDES the "open" entry rather
            // than showing as a duplicate — the packager dedupes by id, keeping
            // this final one (with the full frame timeline). (Issue #4)
            id: this.__gotchaId,
            url: entryUrl,
            method: 'GET',
            status: failed ? 0 : 1000, // 1000 = normal closure
            statusText: failed ? 'WebSocket error' : 'Connection closed',
            durationMs: Date.now() - this.__gotchaTs,
            failed,
            ts: this.__gotchaTs,
            transport: 'websocket',
            frames: [...this.__gotchaFrames],
          };
          emit(entry);
        } catch {
          // never throw
        }
      };

      this.addEventListener('error', () => {
        try {
          emitClose(true);
        } catch {
          // never throw
        }
      });

      this.addEventListener('close', (event: CloseEvent) => {
        try {
          // CloseEvent.wasClean is false when the server closed abnormally.
          emitClose(!event.wasClean);
        } catch {
          // never throw
        }
      });
    }

    // Override send() to collect outgoing frames before they leave.
    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      try {
        if (this.__gotchaFrames.length < MAX_FRAMES) {
          this.__gotchaFrames.push({
            dir: 'send',
            data: serializeWsData(data),
            ts: Date.now(),
          });
        }
      } catch {
        // never throw
      }
      super.send(data);
    }
  }

  // Preserve statics (CONNECTING/OPEN/CLOSING/CLOSED) and make instanceof work.
  Object.defineProperties(GotchaWebSocket, {
    CONNECTING: { value: NativeWebSocket.CONNECTING },
    OPEN: { value: NativeWebSocket.OPEN },
    CLOSING: { value: NativeWebSocket.CLOSING },
    CLOSED: { value: NativeWebSocket.CLOSED },
  });

  // Replace the global. Wrapping with `as unknown as typeof WebSocket` is the
  // standard pattern for extending built-ins in TypeScript.
  window.WebSocket = GotchaWebSocket as unknown as typeof WebSocket;
}
