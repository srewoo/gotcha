/**
 * Global test harness: a configurable `chrome.*` mock + fetch helpers.
 *
 * Installed via vitest `setupFiles`, so it's present before any module that
 * registers chrome listeners at import time (service worker, content, popup).
 */
import { beforeEach, vi } from 'vitest';

type Listener = (...args: unknown[]) => unknown;

interface ChromeEvent {
  addListener: (fn: Listener) => void;
  removeListener: (fn: Listener) => void;
  hasListener: (fn: Listener) => boolean;
  _emit: (...args: unknown[]) => unknown[];
  _listeners: Listener[];
}

function makeEvent(): ChromeEvent {
  const listeners: Listener[] = [];
  return {
    _listeners: listeners,
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    _emit: (...args) => listeners.map((l) => l(...args)),
  };
}

// In-memory chrome.storage.local / .session.
function makeStorageArea() {
  let data: Record<string, unknown> = {};
  return {
    _data: () => data,
    _reset: () => {
      data = {};
    },
    get: vi.fn((keys?: unknown) => {
      if (keys == null) return Promise.resolve({ ...data });
      const names =
        typeof keys === 'string'
          ? [keys]
          : Array.isArray(keys)
            ? (keys as string[])
            : Object.keys(keys as object);
      const out: Record<string, unknown> = {};
      for (const k of names) if (k in data) out[k] = data[k];
      // object form supplies defaults
      if (keys && typeof keys === 'object' && !Array.isArray(keys)) {
        for (const [k, v] of Object.entries(keys as object)) if (!(k in out)) out[k] = v;
      }
      return Promise.resolve(out);
    }),
    set: vi.fn((items: Record<string, unknown>) => {
      Object.assign(data, items);
      return Promise.resolve();
    }),
    remove: vi.fn((keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
      return Promise.resolve();
    }),
    clear: vi.fn(() => {
      data = {};
      return Promise.resolve();
    }),
  };
}

const local = makeStorageArea();
const session = makeStorageArea();

const chromeMock = {
  runtime: {
    onMessage: makeEvent(),
    onConnect: makeEvent(),
    sendMessage: vi.fn(() => Promise.resolve(undefined)),
    getURL: vi.fn((p: string) => `chrome-extension://test-id/${p}`),
    getManifest: vi.fn(() => ({
      content_scripts: [
        { js: ['assets/main-loader.js'], all_frames: true, world: 'MAIN' },
        { js: ['assets/content-loader.js'], all_frames: true, world: 'ISOLATED' },
      ],
    })),
    lastError: undefined as undefined | { message: string },
  },
  storage: { local, session },
  tabs: {
    query: vi.fn(() => Promise.resolve([{ id: 1, url: 'https://app.example.com', windowId: 10 }])),
    sendMessage: vi.fn(() => Promise.resolve(undefined)),
    create: vi.fn(() => Promise.resolve({ id: 2 })),
    captureVisibleTab: vi.fn(() => Promise.resolve('data:image/png;base64,AAAA')),
  },
  scripting: { executeScript: vi.fn(() => Promise.resolve([])) },
  permissions: {
    request: vi.fn(() => Promise.resolve(true)),
    remove: vi.fn(() => Promise.resolve(true)),
    contains: vi.fn(() => Promise.resolve(true)),
  },
  debugger: {
    attach: vi.fn(() => Promise.resolve()),
    detach: vi.fn(() => Promise.resolve()),
    sendCommand: vi.fn(() => Promise.resolve({})),
    onEvent: makeEvent(),
    onDetach: makeEvent(),
  },
  commands: { onCommand: makeEvent() },
  windows: { WINDOW_ID_CURRENT: -2 },
};

// Expose globally and typed-loosely for tests.
(globalThis as unknown as { chrome: typeof chromeMock }).chrome = chromeMock;

export const chromeApi = chromeMock;
export { local as storageLocal, session as storageSession };

// Helper: stub global fetch with a sequence or a responder.
export function mockFetch(
  responder: (url: string, init?: RequestInit) => { ok?: boolean; status?: number; body?: unknown; text?: string },
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const r = responder(String(url), init);
      const status = r.status ?? (r.ok === false ? 500 : 200);
      return Promise.resolve({
        ok: r.ok ?? status < 400,
        status,
        json: () => Promise.resolve(r.body ?? {}),
        text: () => Promise.resolve(r.text ?? (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? ''))),
        body: null,
      } as unknown as Response);
    }),
  );
}

beforeEach(() => {
  local._reset();
  session._reset();
  // NB: we intentionally do NOT clear the chrome event listener arrays here.
  // Modules like the service worker register their onMessage listener once at
  // import; the chrome mock is re-created per test file, so listeners start
  // empty per file and persist across the file's tests (which is what drives
  // the handler under test). vi.clearAllMocks() resets call history only.
  vi.clearAllMocks();
});
