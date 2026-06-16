import { describe, it, expect, vi } from 'vitest';
import { chromeApi } from '../setup/chrome-mock';

// MV3 eviction recovery: the worker dies, the in-memory `attached` Set with it,
// but the debugger stays attached to the tab. A revived worker must rehydrate
// the Set from chrome.storage.session or it drops every CDP event for the rest
// of the session. Each test imports a FRESH module instance (vi.resetModules +
// dynamic import) over pre-seeded session storage, simulating exactly that.
// NB: no static import of deep-capture here — a long-lived instance would also
// receive the emitted events and pollute the per-test state. Distinct tab ids
// per test keep instances from earlier tests inert.

type DeepCapture = typeof import('../../src/background/deep-capture');

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

async function freshModule(attachedTabs: number[]): Promise<DeepCapture> {
  await chromeApi.storage.session.set({ 'deep:attachedTabs': attachedTabs });
  vi.resetModules();
  const mod = await import('../../src/background/deep-capture');
  await flush(); // let the module's void rehydrate() settle
  return mod;
}

describe('deep-capture — eviction rehydration', () => {
  it('should route CDP events for a persisted tab when a revived worker rehydrates', async () => {
    const TAB = 71;
    const mod = await freshModule([TAB]);
    chromeApi.debugger.sendCommand.mockResolvedValueOnce({ body: '{"ok":1}', base64Encoded: false });
    chromeApi.debugger.onEvent._emit({ tabId: TAB }, 'Network.requestWillBeSent', {
      requestId: 'rh1',
      request: { url: 'https://api/revived', method: 'GET', headers: {} },
    });
    chromeApi.debugger.onEvent._emit({ tabId: TAB }, 'Network.responseReceived', {
      requestId: 'rh1',
      response: { status: 200, statusText: 'OK', headers: {} },
    });
    chromeApi.debugger.onEvent._emit({ tabId: TAB }, 'Network.loadingFinished', { requestId: 'rh1' });
    await flush();
    const entries = await mod.collectDeep(TAB);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ url: 'https://api/revived', status: 200 });
  });

  it('should report deep:status on for a rehydrated tab', async () => {
    const TAB = 72;
    const mod = await freshModule([TAB]);
    expect(mod.isDeep(TAB)).toBe(true);
  });

  it('should resume screencast frame acking for a rehydrated tab', async () => {
    const TAB = 73;
    const mod = await freshModule([TAB]);
    chromeApi.debugger.onEvent._emit({ tabId: TAB }, 'Page.screencastFrame', {
      sessionId: 9,
      data: 'AAAA',
    });
    await flush();
    // The frame is stored (maps rebuilt) AND acked so the stream keeps flowing.
    expect(mod.collectScreencast(TAB)).toHaveLength(1);
    expect(
      chromeApi.debugger.sendCommand.mock.calls.some(
        (c) => c[1] === 'Page.screencastFrameAck' && (c[2] as { sessionId: number }).sessionId === 9,
      ),
    ).toBe(true);
  });

  it('should recover from "already attached" when re-enabling a persisted tab', async () => {
    const TAB = 74;
    const mod = await freshModule([TAB]);
    chromeApi.debugger.attach.mockRejectedValueOnce(
      new Error('Another debugger is already attached to the tab with id: 74.'),
    );
    await expect(mod.enableDeep(TAB)).resolves.toBeUndefined();
    expect(mod.isDeep(TAB)).toBe(true);
    // The domains are re-armed so capture actually resumes.
    expect(chromeApi.debugger.sendCommand).toHaveBeenCalledWith({ tabId: TAB }, 'Network.enable', {});
  });

  it('should still throw "already attached" when the tab is not in the persisted set', async () => {
    const TAB = 75;
    const mod = await freshModule([]); // nothing persisted — someone else's debugger
    chromeApi.debugger.attach.mockRejectedValueOnce(
      new Error('Another debugger is already attached to the tab with id: 75.'),
    );
    await expect(mod.enableDeep(TAB)).rejects.toThrow(/already attached/i);
    expect(mod.isDeep(TAB)).toBe(false);
  });
});
