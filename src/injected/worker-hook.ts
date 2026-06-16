import { BRIDGE_MARKER, post } from './bridge';
import type { NetworkEntry } from '@shared/types';

// NOTE: uid() and clip() are not imported here because the worker shim
// (WORKER_SHIM string below) must be fully self-contained — it runs inside
// the Worker's isolated global scope where it cannot import from @shared/*.
// The shim inlines its own equivalent implementations.

function emit(entry: NetworkEntry): void {
  post({ marker: BRIDGE_MARKER, type: 'network', entry });
}

// ---------------------------------------------------------------------------
// Architecture notes
// ---------------------------------------------------------------------------
// The MAIN world injection cannot reach a Worker's global scope directly:
// workers run in a separate execution context and there is no synchronous
// way to eval code inside them from outside. Three approaches exist:
//
//   A. Wrap the Worker constructor and, for same-origin blob/string URLs,
//      rewrite the worker source to prepend a fetch-shim inline.
//   B. Use a ServiceWorker to intercept the fetch. (Requires registration;
//      out of scope here.)
//   C. Accept partial coverage and document the limitation.
//
// We implement approach A for the cases we can handle:
//   - Same-origin string URLs: we fetch the worker script text, prepend the
//     shim, and create a Blob URL to pass to the native constructor instead.
//   - Blob URLs (data:blob:…): same treatment — re-read the blob, prepend.
//   - Cross-origin URLs (CDN workers, importScripts from a different origin):
//     we CANNOT rewrite the source. We fall through to the native constructor
//     unchanged. Worker creation is NEVER broken for these cases.
//
// The injected shim (WORKER_SHIM) patches fetch inside the worker and relays
// timings back to the main thread via postMessage. The main thread picks
// these up and re-emits them as `transport: 'worker'` NetworkEntry events.
//
// Limitations:
//   - XHR inside workers is NOT captured (rare; most modern workers use fetch).
//   - Cross-origin worker scripts cannot be shimmed.
//   - Module workers (`{type: 'module'}`) that use top-level await may have
//     subtle ordering differences; the shim is inserted before any import.
//   - The shim adds a 'message' listener on self inside the worker. If the
//     host page sends messages to the worker before the shim processes them
//     they will still be delivered; the shim only intercepts messages it
//     sent itself (discriminated by a private marker).
// ---------------------------------------------------------------------------

// A marker used to distinguish shim relay messages from the worker's own
// messages. Must not collide with the host app's own message schemas.
const WORKER_SHIM_MARKER = '__gotcha_worker_net__';

// The fetch shim injected at the top of every reachable worker script.
// It is a self-contained IIFE so it cannot leak names into the worker scope.
// Stringified here so the build system doesn't need to bundle a separate file.
const WORKER_SHIM = `
(function(){
  var _MAX = 16384;
  function _clip(s){ return s.length > _MAX ? s.slice(0, _MAX) + '… [' + s.length + ' bytes total]' : s; }
  function _str(b){
    if(b == null) return undefined;
    if(typeof b === 'string') return _clip(b);
    if(typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return _clip(b.toString());
    if(typeof FormData !== 'undefined' && b instanceof FormData){
      var p=[];
      b.forEach(function(v,k){ p.push(k+'='+(typeof v==='string'?v:'[File]')); });
      return _clip(p.join('&'));
    }
    if(typeof Blob !== 'undefined' && b instanceof Blob) return '[Blob size='+b.size+']';
    if(typeof ArrayBuffer !== 'undefined' && b instanceof ArrayBuffer) return '[ArrayBuffer byteLength='+b.byteLength+']';
    try{ return _clip(String(b)); }catch(e){ return undefined; }
  }
  var _id = (typeof crypto!=='undefined'&&'randomUUID' in crypto)
    ? function(){ return crypto.randomUUID(); }
    : function(){ return Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10); };
  var _orig = self.fetch.bind(self);
  self.fetch = function(input, init){
    var ts = Date.now();
    var url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
    var method = (init && init.method) ? init.method.toUpperCase() : (input instanceof Request ? input.method : 'GET');
    var reqBody = _str(init && init.body);
    return _orig(input, init).then(function(res){
      var clone = res.clone();
      var dur = Date.now() - ts;
      clone.text().then(function(text){
        self.postMessage({
          __marker: '${WORKER_SHIM_MARKER}',
          entry: {
            id: _id(),
            url: url,
            method: method,
            status: res.status,
            statusText: res.statusText,
            requestBody: reqBody,
            responseBody: _clip(text),
            durationMs: dur,
            failed: !res.ok,
            ts: ts,
            transport: 'worker'
          }
        });
      }).catch(function(){
        self.postMessage({
          __marker: '${WORKER_SHIM_MARKER}',
          entry: {
            id: _id(),
            url: url,
            method: method,
            status: res.status,
            statusText: res.statusText,
            requestBody: reqBody,
            durationMs: dur,
            failed: !res.ok,
            ts: ts,
            transport: 'worker'
          }
        });
      });
      return res;
    }, function(err){
      var dur = Date.now() - ts;
      self.postMessage({
        __marker: '${WORKER_SHIM_MARKER}',
        entry: {
          id: _id(),
          url: url,
          method: method,
          status: 0,
          statusText: err && err.message ? err.message : 'Network error',
          requestBody: reqBody,
          durationMs: dur,
          failed: true,
          ts: ts,
          transport: 'worker'
        }
      });
      throw err;
    });
  };
})();
`;

// ---------------------------------------------------------------------------
// Rewrite worker source SYNCHRONOUSLY: read the original text, prepend the shim,
// and return a blob URL the page's worker is created from. Synchronous (blocking
// XHR) is deliberate — Worker construction is synchronous from the page's view,
// so we must produce the instrumented source before returning. This lets us hand
// the page a SINGLE instrumented worker (no second capture worker, no
// double-firing of the worker's own network side-effects). Returns null if
// rewriting isn't possible (cross-origin, read error) — the caller then falls
// back to the unmodified native worker so creation never breaks.
//
// Worker scripts are same-origin/blob and typically small + HTTP-cached, so the
// blocking read is cheap. We use the captured native XHR (grabbed at install,
// before any wrapping) so this internal read is never itself recorded as a
// captured network request.
// ---------------------------------------------------------------------------
let NativeXHR: typeof XMLHttpRequest | undefined;

function readSourceSync(url: string): string | null {
  try {
    const XHR = NativeXHR ?? XMLHttpRequest;
    const xhr = new XHR();
    xhr.open('GET', url, false); // synchronous
    xhr.send();
    if (xhr.status !== 0 && (xhr.status < 200 || xhr.status >= 300)) return null;
    return typeof xhr.responseText === 'string' ? xhr.responseText : null;
  } catch {
    return null;
  }
}

function buildShimmedBlobUrlSync(originalUrl: string, isBlobUrl: boolean): string | null {
  try {
    if (!isBlobUrl) {
      // Only attempt for same-origin http(s) URLs.
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(originalUrl, location.href);
      } catch {
        return null;
      }
      if (parsedUrl.origin !== location.origin) return null;
    }
    const originalSource = readSourceSync(originalUrl);
    if (originalSource == null) return null;
    const shimmedSource = WORKER_SHIM + '\n' + originalSource;
    const blob = new Blob([shimmedSource], { type: 'application/javascript' });
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

// Install a message listener on the given worker to relay shim timings to
// the main thread's emit pipeline.
function listenToWorker(worker: Worker): void {
  worker.addEventListener('message', (event: MessageEvent) => {
    try {
      const msg = event.data as { __marker?: string; entry?: NetworkEntry };
      if (msg && msg.__marker === WORKER_SHIM_MARKER && msg.entry) {
        emit(msg.entry);
      }
    } catch {
      // never throw
    }
  });
}

// Guard against double-install.
let installed = false;

export function installWorkerHook(): void {
  if (installed) return;
  installed = true;

  // ENABLED BY DEFAULT. The shim only relays fetch TIMINGS back to the main
  // thread; it does not re-run the worker for its own sake. We rewrite the
  // worker's OWN source (prepending the shim) and hand that single rewritten
  // worker to the page, so there is no second execution and therefore no
  // double-firing of the worker's network side-effects — the page runs exactly
  // one worker, just an instrumented one. Cross-origin workers we cannot rewrite
  // fall through to the native constructor unchanged (capture silently skipped).
  // Deep-capture (CDP) remains the highest-fidelity path; this gives baseline
  // worker network visibility without it.
  if (typeof Worker === 'undefined') return;

  const NativeWorker = Worker;
  // Grab the native XHR before any other hook can wrap it, so our internal
  // synchronous source read is never recorded as a captured network request.
  if (typeof XMLHttpRequest !== 'undefined') NativeXHR = XMLHttpRequest;

  // We wrap the Worker constructor using a function (not a class extension) so
  // we can intercept the scriptURL before the native constructor runs and
  // synchronously rewrite it. Strategy:
  //
  //   1. For a shimmable URL (same-origin http(s) or blob:), synchronously read
  //      the worker source, prepend the fetch shim, and create the worker from
  //      the instrumented blob URL. The page gets exactly ONE worker — the
  //      instrumented one — so the worker's own network side-effects fire
  //      exactly once. No second capture worker, no double-firing.
  //   2. If reading/rewriting fails (or the URL is cross-origin), create the
  //      worker from the ORIGINAL URL unchanged. Worker creation is NEVER broken;
  //      we simply lose capture for that worker.
  //
  // The shimmed worker relays fetch timings back via postMessage carrying
  // WORKER_SHIM_MARKER; listenToWorker forwards only those into emit and ignores
  // the worker's application messages.

  // Replace the global Worker constructor with a transparent wrapper.
  // Cast required because a plain function cannot satisfy the full Worker
  // interface (which includes EventTarget methods). The returned instance is
  // a real Worker, so runtime behaviour is identical.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).Worker = function GotchaWorker(
    this: Worker,
    scriptURL: string | URL,
    options?: WorkerOptions,
  ): Worker {
    const urlString = String(scriptURL);
    const isBlobUrl = urlString.startsWith('blob:');
    const isSameOriginUrl = (() => {
      try {
        return new URL(urlString, location.href).origin === location.origin;
      } catch {
        return false;
      }
    })();

    // Try to build a single instrumented worker for shimmable URLs.
    if (isSameOriginUrl || isBlobUrl) {
      const shimmedUrl = buildShimmedBlobUrlSync(urlString, isBlobUrl);
      if (shimmedUrl) {
        try {
          const worker = new NativeWorker(shimmedUrl, options);
          listenToWorker(worker);
          // Revoke the blob URL once the worker has loaded its source.
          const originalTerminate = worker.terminate.bind(worker);
          worker.terminate = function () {
            try { URL.revokeObjectURL(shimmedUrl); } catch { /* ignore */ }
            originalTerminate();
          };
          return worker;
        } catch {
          try { URL.revokeObjectURL(shimmedUrl); } catch { /* ignore */ }
          // Fall through to the unmodified native worker below.
        }
      }
    }

    // Cross-origin or rewrite failed: create the worker unchanged. Never break it.
    return new NativeWorker(scriptURL, options);
  } as unknown as typeof Worker;

  // Preserve the prototype chain and statics so instanceof checks still work.
  (window.Worker as unknown as { prototype: Worker }).prototype = NativeWorker.prototype;
}
