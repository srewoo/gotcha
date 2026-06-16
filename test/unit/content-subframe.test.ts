/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { chromeApi } from '../setup/chrome-mock';
import { BRIDGE_MARKER } from '../../src/shared/messaging';

// A stand-in top window: if the old window.postMessage relay regressed, this
// spy would light up.
const fakeTop = { postMessage: vi.fn() };

beforeAll(async () => {
  // Make this frame a SUB-frame (window !== window.top) BEFORE the content
  // script imports and snapshots `isTop`.
  Object.defineProperty(window, 'top', {
    configurable: true,
    get: () => fakeTop as unknown as Window,
  });
  await import('../../src/content/content');
  await new Promise((r) => setTimeout(r, 10)); // let the settings load resolve
});

function fireBridge(payload: unknown): void {
  window.dispatchEvent(
    new MessageEvent('message', { data: payload, source: window as unknown as Window }),
  );
}

describe('content script — sub-frame relay (frame:event)', () => {
  it('should relay a bridge event to the worker via chrome.runtime when not the top frame', async () => {
    const data = {
      marker: BRIDGE_MARKER,
      type: 'console',
      entry: { id: 'c1', level: 'error', message: 'sub-frame boom', ts: 1 },
    };
    fireBridge(data);
    await new Promise((r) => setTimeout(r, 5));
    expect(chromeApi.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'frame:event',
      payload: data,
    });
    // The window.postMessage('*') relay is gone — nothing reaches the host page.
    expect(fakeTop.postMessage).not.toHaveBeenCalled();
  });

  it('should not register a runtime onMessage listener when not the top frame', () => {
    // Sub-frames must never respond to popup/worker messages (responder race).
    expect(chromeApi.runtime.onMessage._listeners).toHaveLength(0);
  });

  it('should not relay non-bridge page traffic', async () => {
    fireBridge({ hello: 'world' });
    await new Promise((r) => setTimeout(r, 5));
    expect(chromeApi.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'frame:event', payload: { hello: 'world' } }),
    );
  });

  it('should not throw into the page when the extension context is invalidated', async () => {
    (chromeApi.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        throw new Error('Extension context invalidated.');
      },
    );
    expect(() =>
      fireBridge({
        marker: BRIDGE_MARKER,
        type: 'step',
        step: { id: 's1', kind: 'click', label: 'Go', ts: 2 },
      }),
    ).not.toThrow();

    // Async rejection path must be swallowed too.
    (chromeApi.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => Promise.reject(new Error('Extension context invalidated.')),
    );
    expect(() =>
      fireBridge({
        marker: BRIDGE_MARKER,
        type: 'console',
        entry: { id: 'c2', level: 'log', message: 'late', ts: 3 },
      }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
  });
});
