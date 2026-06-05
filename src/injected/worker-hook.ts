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
// Rewrite worker source: fetch original text, prepend shim, return blob URL.
// Returns null if rewriting is not possible (cross-origin, fetch error, etc.).
// ---------------------------------------------------------------------------
async function buildShimmedBlobUrl(originalUrl: string): Promise<string | null> {
  try {
    // Only attempt for same-origin URLs. If parsing fails, bail out.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(originalUrl, location.href);
    } catch {
      return null;
    }
    // Cross-origin: cannot fetch and rewrite safely.
    if (parsedUrl.origin !== location.origin) return null;

    const res = await fetch(originalUrl, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const originalSource = await res.text();
    const shimmedSource = WORKER_SHIM + '\n' + originalSource;
    const blob = new Blob([shimmedSource], { type: 'application/javascript' });
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

// Rewrite a blob: URL worker by reading the blob content and prepending shim.
async function buildShimmedBlobFromBlob(blobUrl: string): Promise<string | null> {
  try {
    const res = await fetch(blobUrl);
    if (!res.ok) return null;
    const originalSource = await res.text();
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

  // DISABLED BY DEFAULT (safety). The shadow-worker strategy below re-runs the
  // worker script in a second worker, which DOUBLE-FIRES any network calls or
  // other top-level side-effects the worker performs — a real change to the
  // host app's behaviour, not just our view of it. Worker requests are captured
  // correctly and without double-execution by deep-capture (CDP) mode, so we
  // leave this off rather than risk duplicate writes/analytics on a live app.
  // The implementation is retained below for a future opt-in reimplementation.
  return;

  if (typeof Worker === 'undefined') return;

  const NativeWorker = Worker;

  // We wrap the Worker constructor using a function (not a class extension)
  // so we can intercept the scriptURL before the native constructor runs,
  // rewrite it asynchronously, then create the real worker. Because Worker
  // creation is synchronous from the page's perspective but shimming requires
  // an async fetch, we use the following strategy:
  //
  //   1. Create the worker immediately with the ORIGINAL URL (unmodified).
  //      This ensures the page's worker is always live and never broken.
  //   2. Asynchronously attempt to build a shimmed blob URL.
  //   3. If shimming succeeds, create a SECOND worker from the blob URL,
  //      wire its messages back through emit, then terminate it after the
  //      host terminates the original. The second worker is used solely for
  //      capturing network calls; it is isolated and never interacts with
  //      the page's application logic.
  //
  // Trade-off: this means the shimmed capture worker runs the script twice
  // (once for real, once for capture). For pure-computation workers that
  // don't have network side-effects this is harmless. For workers with
  // side-effects (rare for fetch), it could cause double-requests. To
  // mitigate: the capture worker has no message port to the page app, so
  // any `postMessage` it fires lands in our own relay listener and is
  // discarded (we only forward entries that carry the shim marker).
  //
  // A cleaner approach (not implemented here to avoid breaking worker
  // creation) would be to intercept the URL synchronously before the
  // constructor runs. That requires Worker.prototype tricks that are
  // fragile across browsers. This is the safest correct design.

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
    // Always create the real worker first so the page is never blocked.
    const realWorker = new NativeWorker(scriptURL, options);

    const urlString = String(scriptURL);
    const isBlobUrl = urlString.startsWith('blob:');
    const isSameOriginUrl = (() => {
      try {
        return new URL(urlString, location.href).origin === location.origin;
      } catch {
        return false;
      }
    })();

    // Only attempt shimming for same-origin or blob URLs.
    if (isSameOriginUrl || isBlobUrl) {
      const buildUrl = isBlobUrl
        ? buildShimmedBlobFromBlob(urlString)
        : buildShimmedBlobUrl(urlString);

      buildUrl
        .then((shimmedUrl) => {
          if (!shimmedUrl) return;
          try {
            const captureWorker = new NativeWorker(shimmedUrl, options);
            listenToWorker(captureWorker);
            // Clean up the blob URL once the worker starts.
            captureWorker.addEventListener('message', () => {
              // No-op: relay happens in listenToWorker's listener.
            });
            // Terminate the capture worker when the real one is terminated.
            // We proxy terminate() on the real worker to also terminate ours.
            const originalTerminate = realWorker.terminate.bind(realWorker);
            realWorker.terminate = function () {
              try { captureWorker.terminate(); } catch { /* ignore */ }
              try { URL.revokeObjectURL(shimmedUrl); } catch { /* ignore */ }
              originalTerminate();
            };
          } catch {
            // Never break the page's worker on shimming failure.
          }
        })
        .catch(() => {
          // Shimming failed — silently degrade. The real worker still runs.
        });
    }
    // Cross-origin workers: no shimming attempted. Silently degrade.

    return realWorker;
  } as unknown as typeof Worker;

  // Preserve the prototype chain and statics so instanceof checks still work.
  (window.Worker as unknown as { prototype: Worker }).prototype = NativeWorker.prototype;
}
