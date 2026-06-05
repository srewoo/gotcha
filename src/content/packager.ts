import type { CaptureBundle, NetworkEntry } from '@shared/types';
import { uid } from '@shared/uid';
import type { BufferStore } from './buffer-store';
import { captureEnvironment } from './environment';
import { captureDomSnapshot } from './dom-snapshot';

// Derive a sensible default title from the loudest signal we captured: the
// first failed request, else the first console error, else the URL.
function deriveTitle(buffers: BufferStore): string {
  const failed = buffers.network.all().find((n) => n.failed);
  if (failed) {
    const path = (() => {
      try {
        return new URL(failed.url).pathname;
      } catch {
        return failed.url;
      }
    })();
    return `${failed.status || 'Failed'} on ${failed.method} ${path}`;
  }
  const error = buffers.console.all().find((c) => c.level === 'error');
  if (error) return error.message.slice(0, 80);
  return `Issue on ${location.pathname}`;
}

// Assemble the bundle from buffers + a fresh DOM/env snapshot. Screenshot is
// attached later by the worker (it owns chrome.tabs.captureVisibleTab).
// Dedupe network entries by id, keeping the LAST occurrence — long-lived
// connections (WebSocket/EventSource) emit an "open" entry and later a "close"
// entry under the same id; the close one carries the full frame timeline and
// supersedes the open. (Issue #4)
function dedupeNetwork(entries: readonly NetworkEntry[]): NetworkEntry[] {
  const byId = new Map<string, NetworkEntry>();
  for (const e of entries) byId.set(e.id, e);
  return [...byId.values()];
}

export function packageBundle(buffers: BufferStore): CaptureBundle {
  return {
    id: uid(),
    title: deriveTitle(buffers),
    console: [...buffers.console.all()],
    network: dedupeNetwork(buffers.network.all()),
    steps: [...buffers.steps.all()],
    replay: [...buffers.replay.all()],
    domSnapshot: captureDomSnapshot(),
    environment: captureEnvironment(),
    redacted: false,
    createdAt: Date.now(),
  };
}
