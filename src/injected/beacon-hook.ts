import { BRIDGE_MARKER, post } from './bridge';
import { uid } from '@shared/uid';
import type { NetworkEntry } from '@shared/types';
import { serializeBody } from './body-serializer';

// Matches the cap used in network-hook.ts — keep in sync.
const MAX_BODY = 16_384;

function clip(text: string): string {
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}… [${text.length} bytes total]` : text;
}

function emit(entry: NetworkEntry): void {
  post({ marker: BRIDGE_MARKER, type: 'network', entry });
}

// Best-effort serialisation of the sendBeacon body data, which can be any
// BodyInit type (string, Blob, ArrayBuffer, FormData, URLSearchParams).
// Delegates to the shared serializer (same one fetch/XHR use); only the
// clipping budget lives here.
function serializeBeaconData(data?: BodyInit | null): string | undefined {
  const serialized = serializeBody(data);
  return serialized === undefined ? undefined : clip(serialized);
}

// Guard: avoid double-patching if the page re-evaluates the injected script.
let installed = false;

export function installBeaconHook(): void {
  if (installed) return;
  installed = true;

  // navigator.sendBeacon may not exist in all environments (e.g. headless).
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;

  const originalSendBeacon = navigator.sendBeacon.bind(navigator);

  navigator.sendBeacon = function (url: string, data?: BodyInit | null): boolean {
    const ts = Date.now();
    let result = true;
    let failed = false;
    try {
      result = originalSendBeacon(url, data);
      failed = result === false;
    } catch (err) {
      failed = true;
      // Re-throw so the host page's error handling is unaffected.
      try {
        const entry: NetworkEntry = {
          id: uid(),
          url: String(url),
          method: 'POST',
          status: 0,
          statusText: err instanceof Error ? err.message : 'sendBeacon threw',
          requestBody: serializeBeaconData(data),
          durationMs: Date.now() - ts,
          failed: true,
          ts,
          transport: 'beacon',
        };
        emit(entry);
      } catch {
        // emit must never throw
      }
      throw err;
    }

    try {
      const entry: NetworkEntry = {
        id: uid(),
        url: String(url),
        method: 'POST',
        // sendBeacon is fire-and-forget — there is no HTTP status code available
        // synchronously. 0 is conventional for "no response seen".
        status: 0,
        statusText: 'beacon (fire-and-forget)',
        requestBody: serializeBeaconData(data),
        // Beacons have no response body.
        durationMs: Date.now() - ts,
        failed,
        ts,
        transport: 'beacon',
      };
      emit(entry);
    } catch {
      // emit must never throw into the host page
    }

    return result;
  };
}
