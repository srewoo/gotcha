/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { chromeApi, storageLocal } from '../setup/chrome-mock';

function onMessage(message: unknown): Promise<any> {
  return new Promise((resolve) => {
    chromeApi.runtime.onMessage._listeners[0]!(message, {}, resolve);
  });
}

beforeAll(async () => {
  // happy-dom's default location.hostname is 'localhost' — deny it so the
  // content script's per-domain opt-out (feature F7) is active.
  storageLocal.set({ captureDenyDomains: 'localhost' });
  await import('../../src/content/content');
  await new Promise((r) => setTimeout(r, 10));
});

describe('content script — deny-listed domain', () => {
  it('refuses capture:finish on an opted-out domain', async () => {
    const res = await onMessage({ type: 'capture:finish' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('disabled on this domain');
  });

  it('refuses capture:start on an opted-out domain', async () => {
    const res = await onMessage({ type: 'capture:start' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('disabled on this domain');
  });
});
