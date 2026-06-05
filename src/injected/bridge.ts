import { BRIDGE_MARKER, type BridgeMessage } from '@shared/messaging';

// MAIN world cannot use chrome.* — it speaks to the ISOLATED content script
// purely through window.postMessage. The content script filters by marker.
export function post(message: BridgeMessage): void {
  try {
    window.postMessage(message, window.location.origin);
  } catch {
    // Posting must never throw into the host page's call stack.
  }
}

export { BRIDGE_MARKER };
