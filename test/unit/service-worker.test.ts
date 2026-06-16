import { describe, it, expect, beforeEach, vi } from 'vitest';
import { chromeApi, storageLocal, mockFetch } from '../setup/chrome-mock';
import { makeBundle } from '../setup/factory';
import type { CaptureBundle } from '../../src/shared/types';

// In-memory bundle store standing in for the IndexedDB-backed db module.
const { store } = vi.hoisted(() => ({ store: new Map<string, CaptureBundle>() }));

vi.mock('../../src/content/db', () => ({
  bundleDb: {
    get: vi.fn((id: string) => Promise.resolve(store.get(id))),
    put: vi.fn((b: CaptureBundle) => {
      store.set(b.id, b);
      return Promise.resolve();
    }),
    delete: vi.fn((id: string) => {
      store.delete(id);
      return Promise.resolve();
    }),
    summaries: vi.fn(() =>
      Promise.resolve(
        [...store.values()].map((b) => ({
          id: b.id,
          title: b.title,
          createdAt: b.createdAt,
          counts: { console: 0, errors: 0, network: 0, failed: 0, steps: 0 },
          hasTest: !!b.generatedTest,
          filed: b.filed ?? null,
        })),
      ),
    ),
    allBundles: vi.fn(() => Promise.resolve([...store.values()])),
  },
}));

// Importing the worker registers its chrome.runtime.onMessage listener.
import '../../src/background/service-worker';

type Sender = { tab?: { id?: number; windowId?: number } };
function send(message: unknown, sender: Sender = { tab: { id: 1, windowId: 10 } }): Promise<any> {
  return new Promise((resolve) => {
    const listener = chromeApi.runtime.onMessage._listeners[0]!;
    listener(message, sender, resolve);
  });
}

beforeEach(() => store.clear());

describe('service-worker — bundle CRUD', () => {
  it('lists summaries sorted newest-first', async () => {
    store.set('a', makeBundle({ id: 'a', createdAt: 1 }));
    store.set('b', makeBundle({ id: 'b', createdAt: 2 }));
    const res = await send({ type: 'bundle:list' });
    expect(res.ok).toBe(true);
    expect(res.bundles.map((s: { id: string }) => s.id)).toEqual(['b', 'a']);
  });

  it('gets a bundle and reports not-found', async () => {
    store.set('a', makeBundle({ id: 'a' }));
    expect((await send({ type: 'bundle:get', id: 'a' })).bundle.id).toBe('a');
    expect(await send({ type: 'bundle:get', id: 'nope' })).toEqual({ ok: false, error: 'Bundle not found' });
  });

  it('deletes, attaches a test, sets screenshot + steps', async () => {
    store.set('a', makeBundle({ id: 'a' }));
    await send({ type: 'bundle:attachTest', id: 'a', filename: 'g.spec.ts', source: 'x' });
    expect(store.get('a')!.generatedTest).toEqual({ filename: 'g.spec.ts', source: 'x' });

    await send({ type: 'bundle:setScreenshot', id: 'a', dataUrl: 'data:img' });
    expect(store.get('a')!.screenshotDataUrl).toBe('data:img');

    await send({ type: 'bundle:setSteps', id: 'a', steps: [{ id: 's', kind: 'click', label: 'x', ts: 1 }] });
    expect(store.get('a')!.steps).toHaveLength(1);

    await send({ type: 'bundle:delete', id: 'a' });
    expect(store.has('a')).toBe(false);
  });
});

describe('service-worker — save', () => {
  it('rejects an invalid bundle shape', async () => {
    const res = await send({ type: 'bundle:save', bundle: { not: 'a bundle' } });
    expect(res).toEqual({ ok: false, error: 'Invalid bundle shape' });
  });

  it('persists a valid bundle, attaches a screenshot, opens review', async () => {
    const res = await send({ type: 'bundle:save', bundle: makeBundle({ id: 'fresh' }) });
    expect(res.ok).toBe(true);
    expect(res.reviewUrl).toContain('review.html?id=fresh');
    expect(store.get('fresh')!.screenshotDataUrl).toContain('data:image/png');
    expect(chromeApi.tabs.create).toHaveBeenCalled();
  });
});

describe('service-worker — screenshot + css fetch', () => {
  it('captures the visible tab', async () => {
    const res = await send({ type: 'screenshot:capture' });
    expect(res).toMatchObject({ type: 'screenshot', ok: true });
  });

  it('fetches cross-origin css within budget', async () => {
    mockFetch(() => ({ ok: true, text: 'body{color:red}' }));
    const res = await send({ type: 'css:fetch', sheets: [{ href: 'https://cdn/x.css' }] });
    expect(res.ok).toBe(true);
    expect(res.css['https://cdn/x.css']).toContain('color:red');
  });

  it('should inline a cross-origin font as a data uri in the fetched css', async () => {
    mockFetch((url) => {
      if (url.endsWith('.woff2')) return { ok: true, bytes: new Uint8Array([1, 2, 3, 4]) };
      return { ok: true, text: "@font-face{font-family:X;src:url('https://cdn/f.woff2')}" };
    });
    const res = await send({ type: 'css:fetch', sheets: [{ href: 'https://cdn/x.css' }] });
    expect(res.ok).toBe(true);
    const css = res.css['https://cdn/x.css']!;
    expect(css).toContain('data:font/woff2;base64,');
    expect(css).not.toContain("url('https://cdn/f.woff2')");
  });

  it('should leave the absolute font url when the font fetch fails', async () => {
    mockFetch((url) => {
      if (url.endsWith('.woff2')) return { ok: false, status: 403 };
      return { ok: true, text: '@font-face{src:url(https://cdn/f.woff2)}' };
    });
    const res = await send({ type: 'css:fetch', sheets: [{ href: 'https://cdn/x.css' }] });
    expect(res.css['https://cdn/x.css']).toContain('url(https://cdn/f.woff2)');
    expect(res.css['https://cdn/x.css']).not.toContain('data:font');
  });
});

describe('service-worker — filing', () => {
  it('should not persist filed metadata when the integration is unconfigured (simulated)', async () => {
    store.set('a', makeBundle({ id: 'a' }));
    const res = await send({ type: 'bundle:file', id: 'a', redact: true, integration: 'linear' });
    expect(res.ok).toBe(true);
    // The simulated ref still flows back to the UI…
    expect(res.filed.simulated).toBe(true);
    // …but is NOT recorded as a real filing on the bundle.
    expect(store.get('a')!.filed).toBeUndefined();
    expect(store.get('a')!.redacted).toBe(true); // redact path applied
  });

  it('should persist filed metadata when the integration files for real', async () => {
    storageLocal.set({ linearApiKey: 'key', linearTeamId: 'team' });
    store.set('a', makeBundle({ id: 'a' }));
    mockFetch(() => ({
      body: { data: { issueCreate: { success: true, issue: { identifier: 'GOT-9', url: 'https://l/9' } } } },
    }));
    const res = await send({ type: 'bundle:file', id: 'a', redact: false, integration: 'linear' });
    expect(res.ok).toBe(true);
    expect(res.filed.simulated).toBe(false);
    expect(store.get('a')!.filed).toMatchObject({ integration: 'linear', identifier: 'GOT-9' });
  });

  it('should render triage fields into the filed issue body when fields are sent', async () => {
    storageLocal.set({ linearApiKey: 'key', linearTeamId: 'team' });
    store.set('a', makeBundle({ id: 'a' }));
    let sentBody = '';
    mockFetch((_url, init) => {
      sentBody = String(init?.body);
      return {
        body: { data: { issueCreate: { success: true, issue: { identifier: 'GOT-10', url: 'https://l/10' } } } },
      };
    });
    const res = await send({
      type: 'bundle:file',
      id: 'a',
      redact: false,
      integration: 'linear',
      fields: { team: 'Web', assignee: 'ana', priority: 'P1' },
    });
    expect(res.ok).toBe(true);
    expect(sentBody).toContain('team Web');
    expect(sentBody).toContain('assignee ana');
    expect(sentBody).toContain('priority P1');
  });

  it('integration:test reports not-configured', async () => {
    expect(await send({ type: 'integration:test', id: 'github' })).toEqual({
      ok: false,
      error: 'Not configured',
    });
  });
});

describe('service-worker — AI paths', () => {
  const analysisJson = JSON.stringify({
    summary: 's',
    rootCauses: ['r'],
    debuggingSteps: ['d'],
  });

  it('ai:available reflects whether a key is configured', async () => {
    expect((await send({ type: 'ai:available' })).available).toBe(false);
    storageLocal.set({ aiApiKey: 'k' });
    expect((await send({ type: 'ai:available' })).available).toBe(true);
  });

  it('ai:analyze redacts then analyzes and caches the result', async () => {
    storageLocal.set({ aiApiKey: 'k' });
    store.set('a', makeBundle({ id: 'a' }));
    mockFetch(() => ({ body: { choices: [{ message: { content: analysisJson } }] } }));
    const res = await send({ type: 'ai:analyze', id: 'a' });
    expect(res.analysis.summary).toBe('s');
    expect(store.get('a')!.aiAnalysis?.summary).toBe('s');
  });

  it('ai:analyze errors without a key', async () => {
    store.set('a', makeBundle({ id: 'a' }));
    expect((await send({ type: 'ai:analyze', id: 'a' })).ok).toBe(false);
  });

  it('ai:generateTest uses the LLM when keyed', async () => {
    storageLocal.set({ aiApiKey: 'k' });
    store.set('a', makeBundle({ id: 'a' }));
    const spec = "import { test, expect } from '@playwright/test';\ntest('x', async () => {});";
    mockFetch(() => ({ body: { choices: [{ message: { content: spec } }] } }));
    const res = await send({ type: 'ai:generateTest', id: 'a' });
    expect(res.ok).toBe(true);
    expect(res.test.source).toContain('@playwright/test');
    expect(store.get('a')!.generatedTest?.source).toContain('@playwright/test');
  });

  it('ai:generateTest falls back to the deterministic generator without a key', async () => {
    store.set('a', makeBundle({ id: 'a', steps: [{ id: 's1', kind: 'navigate', label: 'https://x/', ts: 1 }] }));
    const res = await send({ type: 'ai:generateTest', id: 'a' });
    expect(res.ok).toBe(true);
    expect(res.test.source).toContain("@playwright/test");
    expect(res.test.source).toContain('page.goto');
  });
});

describe('service-worker — deep capture + streaming + unknown', () => {
  it('deep:enable / status / disable round-trip', async () => {
    const enabled = await send({ type: 'deep:enable', tabId: 5 });
    expect(enabled).toEqual({ ok: true, deep: true });
    expect(chromeApi.debugger.attach).toHaveBeenCalled();
    expect((await send({ type: 'deep:disable', tabId: 5 })).deep).toBe(false);
  });

  it('streaming ai:analyze port emits deltas then done (and primes redaction)', async () => {
    storageLocal.set({ aiApiKey: 'k' });
    store.set('a', makeBundle({ id: 'a' }));
    const enc = new TextEncoder();
    const json = JSON.stringify({ summary: 's', rootCauses: [], debuggingSteps: [] });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(c) {
              c.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: json } }] }) + '\n'));
              c.enqueue(enc.encode('data: [DONE]\n'));
              c.close();
            },
          }),
        } as unknown as Response),
      ),
    );
    const posted: Array<{ type: string }> = [];
    const port = {
      name: 'ai:analyze:a',
      postMessage: (m: { type: string }) => posted.push(m),
      disconnect: vi.fn(),
      onDisconnect: { addListener: vi.fn() },
    };
    chromeApi.runtime.onConnect._emit(port);
    await new Promise((r) => setTimeout(r, 30));
    expect(posted.some((m) => m.type === 'done')).toBe(true);
    expect(store.get('a')!.aiAnalysis?.summary).toBe('s');
  });

  it('responds with an error for an unknown message type', async () => {
    const res = await send({ type: 'totally:unknown' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Unhandled message');
  });

  it('deep:enable surfaces an attach failure', async () => {
    (chromeApi.debugger.attach as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Cannot access chrome:// URL'),
    );
    const res = await send({ type: 'deep:enable', tabId: 9 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Cannot access');
  });

  it('deep:status reports current attachment for the active tab', async () => {
    const res = await send({ type: 'deep:status' });
    expect(res).toHaveProperty('deep');
  });
});

describe('service-worker — AI test + duplicates + keyboard command', () => {
  it('ai:test validates the key with a tiny round-trip', async () => {
    storageLocal.set({ aiApiKey: 'k' });
    mockFetch(() => ({ body: { choices: [{ message: { content: 'OK' } }] } }));
    expect((await send({ type: 'ai:test' })).ok).toBe(true);
  });

  it('ai:test fails without a key', async () => {
    expect((await send({ type: 'ai:test' })).ok).toBe(false);
  });

  it('ai:duplicates returns matches', async () => {
    storageLocal.set({ aiApiKey: 'k' });
    store.set('cur', makeBundle({ id: 'cur', title: 'Save fails' }));
    store.set('r1', makeBundle({ id: 'r1', title: 'Saving broken' }));
    mockFetch(() => ({
      body: { choices: [{ message: { content: JSON.stringify({ duplicates: [{ id: 'r1', reason: 'same' }] }) } }] },
    }));
    const res = await send({ type: 'ai:duplicates', id: 'cur' });
    expect(res.ok).toBe(true);
    expect(res.duplicates[0]).toMatchObject({ id: 'r1' });
  });

  it('files without redaction (redact=false leaves redacted flag false)', async () => {
    store.set('a', makeBundle({ id: 'a', redacted: false }));
    const res = await send({ type: 'bundle:file', id: 'a', redact: false, integration: 'jira' });
    expect(res.ok).toBe(true);
    expect(store.get('a')!.redacted).toBe(false);
  });

  it('runs the capture-bug keyboard command against the active tab', async () => {
    const listener = chromeApi.commands.onCommand._listeners[0];
    expect(listener).toBeTypeOf('function');
    listener!('capture-bug');
    await new Promise((r) => setTimeout(r, 5));
    expect(chromeApi.tabs.sendMessage).toHaveBeenCalled();
  });

  it('merges deep-capture entries and a full-page screenshot on save', async () => {
    await send({ type: 'deep:enable', tabId: 1 });
    // Seed a deep entry in session storage for tab 1 (collectDeep reads it).
    await chromeApi.storage.session.set({
      'deep:1': [{ id: 'd1', url: 'https://api/deep', method: 'GET', status: 200, durationMs: 1, failed: false, ts: 5 }],
    });
    chromeApi.debugger.sendCommand.mockResolvedValueOnce({ data: 'FULLPAGE' }); // Page.captureScreenshot
    const res = await send({ type: 'bundle:save', bundle: makeBundle({ id: 'merged' }) });
    expect(res.ok).toBe(true);
    const saved = store.get('merged')!;
    expect(saved.network.some((n) => n.url === 'https://api/deep')).toBe(true);
    expect(saved.screenshotDataUrl).toContain('FULLPAGE');
  });

  it('merges CDP screencast frames into the saved bundle', async () => {
    await send({ type: 'deep:enable', tabId: 1 });
    // Drive two screencast frames through the real deep-capture handler.
    chromeApi.debugger.onEvent._emit({ tabId: 1 }, 'Page.screencastFrame', { sessionId: 1, data: 'AAAA' });
    chromeApi.debugger.onEvent._emit({ tabId: 1 }, 'Page.screencastFrame', { sessionId: 2, data: 'BBBB' });
    await new Promise((r) => setTimeout(r, 10));
    const res = await send({ type: 'bundle:save', bundle: makeBundle({ id: 'vid' }) });
    expect(res.ok).toBe(true);
    expect(store.get('vid')!.screencast?.length).toBe(2);
    expect(store.get('vid')!.screencast?.[0]?.data).toContain('data:image/jpeg');
  });

  it('streaming ai:analyze port errors cleanly without a key', async () => {
    store.set('a', makeBundle({ id: 'a' }));
    const posted: Array<{ type: string; error?: string }> = [];
    const port = {
      name: 'ai:analyze:a',
      postMessage: (m: any) => posted.push(m),
      disconnect: () => {},
      onDisconnect: { addListener: () => {} },
    };
    chromeApi.runtime.onConnect._emit(port);
    await new Promise((r) => setTimeout(r, 20));
    expect(posted.some((m) => m.type === 'error')).toBe(true);
  });

  it('ignores ports that are not ai:analyze:', () => {
    const port = { name: 'something-else', postMessage: () => {}, disconnect: () => {} };
    expect(() => chromeApi.runtime.onConnect._emit(port)).not.toThrow();
  });

  it('should still persist the analysis when the port disconnects mid-stream', async () => {
    storageLocal.set({ aiApiKey: 'k' });
    store.set('a', makeBundle({ id: 'a' }));
    const enc = new TextEncoder();
    const json = JSON.stringify({ summary: 'persisted', rootCauses: [], debuggingSteps: [] });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(c) {
              c.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: json } }] }) + '\n'));
              c.enqueue(enc.encode('data: [DONE]\n'));
              c.close();
            },
          }),
        } as unknown as Response),
      ),
    );
    let onDisconnect: (() => void) | undefined;
    const port = {
      name: 'ai:analyze:a',
      // A closed review tab makes every postMessage throw — the handler must
      // swallow this, finish the stream, and persist the billed analysis.
      postMessage: () => {
        throw new Error('Attempting to use a disconnected port object');
      },
      disconnect: () => {
        throw new Error('Attempting to use a disconnected port object');
      },
      onDisconnect: { addListener: (fn: () => void) => (onDisconnect = fn) },
    };
    chromeApi.runtime.onConnect._emit(port);
    onDisconnect?.(); // review tab closes immediately after connecting
    await new Promise((r) => setTimeout(r, 30));
    expect(store.get('a')!.aiAnalysis?.summary).toBe('persisted');
  });

  it('should persist an edited title when bundle:setSteps carries one', async () => {
    store.set('a', makeBundle({ id: 'a', title: 'Old title' }));
    await send({
      type: 'bundle:setSteps',
      id: 'a',
      steps: [{ id: 's', kind: 'click', label: 'x', ts: 1 }],
      title: 'Edited title',
    });
    expect(store.get('a')!.title).toBe('Edited title');
    expect(store.get('a')!.steps).toHaveLength(1);
  });

  it('should keep the existing title when bundle:setSteps has no title', async () => {
    store.set('a', makeBundle({ id: 'a', title: 'Old title' }));
    await send({ type: 'bundle:setSteps', id: 'a', steps: [] });
    expect(store.get('a')!.title).toBe('Old title');
  });

  it('should relay frame:event to the sender tab top frame when a sub-frame sends it', async () => {
    const message = { type: 'frame:event', payload: { kind: 'console' } };
    const res = await send(message, { tab: { id: 7 } });
    expect(res).toEqual({ ok: true });
    expect(chromeApi.tabs.sendMessage).toHaveBeenCalledWith(7, message, { frameId: 0 });
  });

  it('should ack frame:event without relaying when the sender has no tab', async () => {
    const res = await send({ type: 'frame:event', payload: {} }, {});
    expect(res).toEqual({ ok: true });
    expect(chromeApi.tabs.sendMessage).not.toHaveBeenCalled();
  });
});
