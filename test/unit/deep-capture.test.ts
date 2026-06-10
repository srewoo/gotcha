import { describe, it, expect, beforeEach } from 'vitest';
import { chromeApi } from '../setup/chrome-mock';
import {
  enableDeep,
  disableDeep,
  isDeep,
  collectDeep,
  collectScreencast,
  fullPageScreenshot,
} from '../../src/background/deep-capture';

const TAB = 5;
const emit = (method: string, params: object): void =>
  chromeApi.debugger.onEvent._emit({ tabId: TAB }, method, params);
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

beforeEach(async () => {
  await disableDeep(TAB); // reset attached state between tests
});

describe('deep-capture — lifecycle', () => {
  it('enableDeep attaches the debugger and enables the network domain', async () => {
    await enableDeep(TAB);
    expect(isDeep(TAB)).toBe(true);
    expect(chromeApi.debugger.attach).toHaveBeenCalledWith({ tabId: TAB }, '1.3');
    expect(chromeApi.debugger.sendCommand).toHaveBeenCalledWith({ tabId: TAB }, 'Network.enable', {});
  });

  it('disableDeep detaches and clears the flag', async () => {
    await enableDeep(TAB);
    await disableDeep(TAB);
    expect(isDeep(TAB)).toBe(false);
    expect(chromeApi.debugger.detach).toHaveBeenCalled();
  });

  it('an onDetach event clears the attached flag', async () => {
    await enableDeep(TAB);
    chromeApi.debugger.onDetach._emit({ tabId: TAB });
    expect(isDeep(TAB)).toBe(false);
  });
});

describe('deep-capture — request capture', () => {
  it('assembles a network entry across CDP events and flushes it to session storage', async () => {
    await enableDeep(TAB);
    chromeApi.debugger.sendCommand.mockResolvedValueOnce({ body: '{"ok":true}', base64Encoded: false });

    emit('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://api/x', method: 'POST', headers: { a: '1' }, postData: 'hello' },
    });
    emit('Network.responseReceived', {
      requestId: 'r1',
      response: { status: 500, statusText: 'Server Error', headers: { 'content-type': 'application/json' } },
    });
    emit('Network.loadingFinished', { requestId: 'r1' });
    await flush();

    const entries = await collectDeep(TAB);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      url: 'https://api/x',
      method: 'POST',
      status: 500,
      failed: true,
      requestBody: 'hello',
      responseBody: '{"ok":true}',
    });
    // collectDeep clears the store
    expect(await collectDeep(TAB)).toHaveLength(0);
  });

  it('marks a base64 (binary) body as omitted', async () => {
    await enableDeep(TAB);
    chromeApi.debugger.sendCommand.mockResolvedValueOnce({ body: 'AAAA', base64Encoded: true });
    emit('Network.requestWillBeSent', { requestId: 'r2', request: { url: 'https://api/img', method: 'GET', headers: {} } });
    emit('Network.responseReceived', { requestId: 'r2', response: { status: 200, statusText: 'OK', headers: {} } });
    emit('Network.loadingFinished', { requestId: 'r2' });
    await flush();
    const [entry] = await collectDeep(TAB);
    expect(entry!.responseBody).toBe('[binary body omitted]');
    expect(entry!.failed).toBe(false);
  });

  it('ignores events for tabs that are not attached', async () => {
    // TAB is not enabled here
    emit('Network.requestWillBeSent', { requestId: 'r3', request: { url: 'https://x', method: 'GET', headers: {} } });
    await flush();
    expect(await collectDeep(TAB)).toHaveLength(0);
  });
});

describe('deep-capture — screencast (true-pixel video)', () => {
  it('starts the screencast on enableDeep', async () => {
    await enableDeep(TAB);
    const cmds = chromeApi.debugger.sendCommand.mock.calls.map((c) => c[1]);
    expect(cmds).toContain('Page.startScreencast');
  });

  it('collects screencast frames as data URLs on the relative timeline and acks them', async () => {
    await enableDeep(TAB);
    emit('Page.screencastFrame', { sessionId: 1, data: 'AAAA' });
    emit('Page.screencastFrame', { sessionId: 2, data: 'BBBB' });
    await flush();
    const frames = collectScreencast(TAB);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.data).toBe('data:image/jpeg;base64,AAAA');
    expect(frames[0]!.t).toBeGreaterThanOrEqual(0);
    // each frame is acked so the stream keeps flowing
    expect(chromeApi.debugger.sendCommand.mock.calls.some((c) => c[1] === 'Page.screencastFrameAck')).toBe(true);
    // collectScreencast clears
    expect(collectScreencast(TAB)).toHaveLength(0);
  });

  it('stops the screencast on disableDeep', async () => {
    await enableDeep(TAB);
    await disableDeep(TAB);
    const cmds = chromeApi.debugger.sendCommand.mock.calls.map((c) => c[1]);
    expect(cmds).toContain('Page.stopScreencast');
  });
});

describe('deep-capture — full-page screenshot', () => {
  it('returns a data URL when attached', async () => {
    await enableDeep(TAB);
    chromeApi.debugger.sendCommand.mockResolvedValueOnce({ data: 'PNGDATA' });
    const shot = await fullPageScreenshot(TAB);
    expect(shot).toBe('data:image/png;base64,PNGDATA');
  });

  it('returns null when the tab is not attached', async () => {
    expect(await fullPageScreenshot(TAB)).toBeNull();
  });
});
