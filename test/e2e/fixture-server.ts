import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// A tiny local "app under test" that emits a console error and a failed
// request on load, so a capture has real signal (steps/console/network) —
// no internet required.
const PAGE = `<!doctype html>
<html><head><title>Buggy App</title>
<style>.box{color:rebeccapurple}</style></head>
<body>
  <h1 class="box">Buggy App</h1>
  <button id="go" data-testid="go-btn">Do the thing</button>
  <input id="email" name="email" placeholder="email" />
  <script>
    console.error('TypeError: cannot read property of null in render()');
    fetch('/api/save', { method: 'POST', body: 'x' }).catch(() => {});
    document.getElementById('go').addEventListener('click', () => {
      console.error('Save failed after click');
    });
  </script>
</body></html>`;

export async function startFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/api/save')) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"boom"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
