import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Fixture {
  url: string; // the "app under test" origin
  cdnUrl: string; // a SEPARATE origin (different port) — exercises cross-origin paths
  close: () => Promise<void>;
}

// The app-under-test page. It:
//  - links a cross-origin stylesheet from the CDN origin (no CORS headers), so
//    the page can't read its rules — forcing the worker's css:fetch + font
//    data-URI inlining path (replay-CSS fix).
//  - embeds a cross-origin iframe that logs an error, exercising the all_frames
//    capture → chrome.runtime frame:event relay (cross-frame-relay fix).
//  - starts a same-origin endless streaming fetch and records whether the
//    promise RESOLVED — with the old inline `await clone.text()` it never would
//    (streaming-hang fix).
const PAGE = (cdn: string): string => `<!doctype html>
<html><head><title>Buggy App</title>
<link rel="stylesheet" href="${cdn}/styles.css">
<style>.box{color:rebeccapurple}</style></head>
<body>
  <h1 class="box">Buggy App</h1>
  <button id="go" data-testid="go-btn">Do the thing</button>
  <input id="email" name="email" placeholder="email" />
  <iframe id="frame" src="${cdn}/frame.html" style="width:200px;height:80px"></iframe>
  <script>
    console.error('TypeError: cannot read property of null in render()');
    fetch('/api/save', { method: 'POST', body: 'x' }).catch(() => {});
    // Endless same-origin stream: headers arrive immediately, body never ends.
    // The fetch hook must return the Response without draining the body.
    window.__fetchReturned = false;
    fetch('/stream').then(() => { window.__fetchReturned = true; }).catch(() => {});
    document.getElementById('go').addEventListener('click', () => {
      console.error('Save failed after click');
    });
  </script>
</body></html>`;

const FRAME = `<!doctype html>
<html><head><title>Embedded widget</title></head>
<body>
  <p>embedded</p>
  <script>
    console.error('subframe boom: widget failed to init');
    fetch('/widget/data').catch(() => {});
  </script>
</body></html>`;

const STYLES = `@font-face{font-family:GotchaFont;src:url(font.woff2) format('woff2')}
h1{font-family:GotchaFont, sans-serif}`;

// A few bytes standing in for a woff2 binary — the worker base64-inlines whatever
// it fetches; the test asserts the data: URI lands in the snapshot, not glyphs.
const FONT_BYTES = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x02, 0x03]);

export async function startFixtureServer(): Promise<Fixture> {
  const openStreams = new Set<ServerResponse>();

  // CDN origin — deliberately sends NO Access-Control-Allow-Origin header, so
  // the page context cannot read these resources; only the worker can.
  const cdn: Server = createServer((req, res) => {
    if (req.url?.startsWith('/styles.css')) {
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end(STYLES);
    } else if (req.url?.startsWith('/font.woff2')) {
      res.writeHead(200, { 'content-type': 'font/woff2' });
      res.end(FONT_BYTES);
    } else if (req.url?.startsWith('/frame.html')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(FRAME);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => cdn.listen(0, '127.0.0.1', r));
  const cdnUrl = `http://127.0.0.1:${(cdn.address() as AddressInfo).port}`;

  const app: Server = createServer((req, res) => {
    if (req.url?.startsWith('/api/save')) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"boom"}');
    } else if (req.url?.startsWith('/stream')) {
      // Headers now, body never completes — kept alive until server close.
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.write('chunk-0\n');
      openStreams.add(res);
      const iv = setInterval(() => {
        try {
          res.write('tick\n');
        } catch {
          /* socket gone */
        }
      }, 200);
      res.on('close', () => {
        clearInterval(iv);
        openStreams.delete(res);
      });
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE(cdnUrl));
    }
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}/`;

  return {
    url,
    cdnUrl,
    close: async () => {
      for (const s of openStreams) s.destroy();
      await new Promise<void>((r) => app.close(() => r()));
      await new Promise<void>((r) => cdn.close(() => r()));
    },
  };
}
