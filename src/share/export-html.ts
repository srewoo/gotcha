import type { CaptureBundle, ReplayEvent } from '@shared/types';
import { redactBundle } from '@shared/redact';

export interface ExportOptions {
  redact: boolean;
}

export interface ExportedReport {
  filename: string;
  html: string;
}

// ─── Escaping ────────────────────────────────────────────────────────────────
// All bundle-derived strings pass through esc() before being placed into the
// HTML document so the report cannot become an injection vector.
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return c;
    }
  });
}

// ─── Sections ────────────────────────────────────────────────────────────────

function buildEnvironmentSection(b: CaptureBundle): string {
  const env = b.environment;
  const captured = new Date(env.capturedAt).toISOString();
  return `
  <section id="environment">
    <h2>Environment</h2>
    <table class="env-table">
      <tbody>
        <tr><td>URL</td><td><a href="${esc(env.url)}">${esc(env.url)}</a></td></tr>
        <tr><td>Browser</td><td>${esc(env.browser)}</td></tr>
        <tr><td>OS</td><td>${esc(env.os)}</td></tr>
        <tr><td>Viewport</td><td>${esc(String(env.viewport.width))}×${esc(String(env.viewport.height))} · DPR ${esc(String(env.dpr))}</td></tr>
        <tr><td>Locale</td><td>${esc(env.locale)}</td></tr>
        <tr><td>User-Agent</td><td class="mono">${esc(env.userAgent)}</td></tr>
        <tr><td>Captured at</td><td>${esc(captured)}</td></tr>
        <tr><td>Redacted</td><td>${b.redacted ? '<span class="badge badge-warn">yes</span>' : '<span class="badge badge-ok">no</span>'}</td></tr>
      </tbody>
    </table>
  </section>`;
}

function buildScreenshotSection(b: CaptureBundle): string {
  if (!b.screenshotDataUrl) return '';
  return `
  <section id="screenshot">
    <h2>Screenshot</h2>
    <img class="screenshot" src="${b.screenshotDataUrl}" alt="Screenshot at time of bug capture" />
  </section>`;
}

function buildStepsSection(b: CaptureBundle): string {
  if (b.steps.length === 0) {
    return `
  <section id="steps">
    <h2>Reproduction steps</h2>
    <p class="empty">No steps recorded.</p>
  </section>`;
  }
  const items = b.steps
    .map((s) => {
      const selector = s.selector ? ` <code>${esc(s.selector)}</code>` : '';
      const value = s.value ? ` → <em>${esc(s.value)}</em>` : '';
      return `<li><span class="step-kind">${esc(s.kind)}</span> ${esc(s.label)}${selector}${value}</li>`;
    })
    .join('\n        ');
  return `
  <section id="steps">
    <h2>Reproduction steps</h2>
    <ol class="steps-list">
        ${items}
    </ol>
  </section>`;
}

function buildConsoleSection(b: CaptureBundle): string {
  const errors = b.console.filter((c) => c.level === 'error');
  if (errors.length === 0) {
    return `
  <section id="console">
    <h2>Console errors</h2>
    <p class="empty">No console errors.</p>
  </section>`;
  }
  const rows = errors
    .map(
      (c) =>
        `<tr class="console-error"><td class="mono">${esc(new Date(c.ts).toISOString())}</td><td class="mono">${esc(c.message)}</td></tr>`,
    )
    .join('\n        ');
  return `
  <section id="console">
    <h2>Console errors (${esc(String(errors.length))})</h2>
    <table class="data-table">
      <thead><tr><th>Timestamp</th><th>Message</th></tr></thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </section>`;
}

function buildNetworkSection(b: CaptureBundle): string {
  if (b.network.length === 0) {
    return `
  <section id="network">
    <h2>Network requests</h2>
    <p class="empty">No network requests recorded.</p>
  </section>`;
  }
  const rows = b.network
    .map((n) => {
      const failClass = n.failed || n.status >= 400 ? ' class="net-failed"' : '';
      const status = n.status ? esc(String(n.status)) : 'ERR';
      return `<tr${failClass}><td>${status}</td><td>${esc(n.method)}</td><td class="mono url-cell">${esc(n.url)}</td><td>${esc(String(n.durationMs))}ms</td><td>${esc(n.transport ?? 'fetch')}</td></tr>`;
    })
    .join('\n        ');
  return `
  <section id="network">
    <h2>Network requests (${esc(String(b.network.length))})</h2>
    <table class="data-table">
      <thead><tr><th>Status</th><th>Method</th><th>URL</th><th>Duration</th><th>Transport</th></tr></thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </section>`;
}

function buildTestSection(b: CaptureBundle): string {
  if (!b.generatedTest) return '';
  return `
  <section id="test">
    <h2>Generated Playwright test</h2>
    <p class="filename">File: <code>${esc(b.generatedTest.filename)}</code></p>
    <pre class="code-block"><code>${esc(b.generatedTest.source.trim())}</code></pre>
  </section>`;
}

// ─── Inline replay viewer ─────────────────────────────────────────────────────
// Renders the initial `snapshot` event in a sandboxed iframe so the recipient
// sees the page state at capture time without any network requests.
// A minimal timeline scrubber shows the total event count and lets readers
// step through events. Keeping it dependency-free and < ~100 lines of inlined JS.
function buildReplaySection(events: ReplayEvent[]): string {
  if (events.length === 0) return '';

  // Embed the raw event array as JSON inside the script. JSON.stringify
  // produces valid JS — the only injection risk is the literal </script> sequence,
  // which we neutralise with a split+join below.
  // Split </script> so the literal string cannot close the inline script block.
  const eventsJson = JSON.stringify(events).replace(/<\/script>/gi, '<\\/script>');

  return `
  <section id="replay">
    <h2>Session replay</h2>
    <p class="replay-note">
      Showing initial page snapshot. Use the scrubber below to step through
      ${esc(String(events.length))} captured events. Full interactive replay is
      available inside the Gotcha extension.
    </p>
    <p class="replay-note replay-note-fidelity">
      Reconstructed from the captured DOM — not a pixel video. Canvas/WebGL,
      &lt;video&gt;, nested iframes, and CORS-restricted CSS may not render.
    </p>
    <div class="replay-container">
      <iframe
        id="replay-frame"
        class="replay-iframe"
        sandbox="allow-same-origin"
        title="Page snapshot at time of capture"
      ></iframe>
      <div class="replay-controls">
        <button id="replay-prev" aria-label="Previous event">&#9664;</button>
        <span id="replay-counter">Event <span id="replay-idx">0</span> / ${esc(String(events.length - 1))}</span>
        <button id="replay-next" aria-label="Next event">&#9654;</button>
        <span id="replay-kind" class="replay-kind-badge"></span>
      </div>
      <div id="replay-detail" class="replay-detail"></div>
    </div>
    <script>
    (function () {
      var EVENTS = ${eventsJson};
      var idx = 0;
      var frame = document.getElementById('replay-frame');
      var counter = document.getElementById('replay-idx');
      var kindBadge = document.getElementById('replay-kind');
      var detail = document.getElementById('replay-detail');

      function render(i) {
        var ev = EVENTS[i];
        if (!ev) return;
        counter.textContent = String(i);
        kindBadge.textContent = ev.kind;

        if (ev.kind === 'snapshot' && ev.html) {
          // Write the snapshot HTML into the sandboxed iframe.
          var doc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
          if (doc) { doc.open(); doc.write(ev.html); doc.close(); }
          detail.textContent = '';
        } else if (ev.kind === 'mutation' && ev.html) {
          detail.textContent = 'Mutation on ' + (ev.selector || '(no selector)') + ': ' + ev.html.slice(0, 200);
        } else if (ev.kind === 'input') {
          detail.textContent = 'Input on ' + (ev.selector || '(no selector)') + ': ' + (ev.value || '');
        } else if (ev.kind === 'scroll') {
          detail.textContent = 'Scroll to (' + (ev.x ?? 0) + ', ' + (ev.y ?? 0) + ')';
        } else if (ev.kind === 'mouse') {
          detail.textContent = 'Mouse at (' + (ev.x ?? 0) + ', ' + (ev.y ?? 0) + ')';
        } else if (ev.kind === 'resize') {
          detail.textContent = 'Resize to ' + (ev.w ?? 0) + '\\u00d7' + (ev.h ?? 0);
        } else {
          detail.textContent = '';
        }
      }

      document.getElementById('replay-prev').addEventListener('click', function () {
        if (idx > 0) { idx--; render(idx); }
      });
      document.getElementById('replay-next').addEventListener('click', function () {
        if (idx < EVENTS.length - 1) { idx++; render(idx); }
      });

      // Render the initial snapshot immediately on load.
      render(idx);
    })();
    <\/script>
  </section>`;
}

// ─── Inline CSS ───────────────────────────────────────────────────────────────
function inlineStyles(): string {
  return `
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #f8f9fa;
      --surface: #ffffff;
      --border: #dee2e6;
      --text: #212529;
      --text-muted: #6c757d;
      --accent: #e63946;
      --accent-2: #457b9d;
      --ok: #2a9d8f;
      --warn: #e9c46a;
      --fail-bg: #fff3f3;
      --fail-text: #c0392b;
      --code-bg: #f1f3f5;
      --radius: 6px;
      --shadow: 0 1px 3px rgba(0,0,0,.1);
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 0 0 3rem;
    }
    header.gotcha-header {
      background: var(--accent);
      color: #fff;
      padding: 1.25rem 2rem;
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    header.gotcha-header .logo { font-weight: 800; font-size: 1.4rem; letter-spacing: -0.02em; }
    header.gotcha-header .logo span { opacity: .75; font-weight: 400; font-size: 0.9rem; margin-left: .5rem; }
    header.gotcha-header h1 { font-size: 1.15rem; font-weight: 600; opacity: .95; }
    nav.toc {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: .5rem 2rem;
      display: flex;
      gap: 1.25rem;
      flex-wrap: wrap;
    }
    nav.toc a { color: var(--accent-2); text-decoration: none; font-size: .875rem; }
    nav.toc a:hover { text-decoration: underline; }
    main { max-width: 1100px; margin: 2rem auto; padding: 0 1.5rem; display: flex; flex-direction: column; gap: 2rem; }
    section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 1.5rem;
    }
    h2 {
      font-size: 1rem;
      font-weight: 700;
      color: var(--accent-2);
      border-bottom: 1px solid var(--border);
      padding-bottom: .5rem;
      margin-bottom: 1rem;
      text-transform: uppercase;
      letter-spacing: .05em;
    }
    p.empty { color: var(--text-muted); font-style: italic; }
    /* Environment table */
    table.env-table { width: 100%; border-collapse: collapse; font-size: .9rem; }
    table.env-table td { padding: .4rem .6rem; vertical-align: top; border-bottom: 1px solid var(--border); }
    table.env-table td:first-child { font-weight: 600; white-space: nowrap; width: 140px; }
    /* Data tables */
    table.data-table { width: 100%; border-collapse: collapse; font-size: .85rem; }
    table.data-table th {
      background: var(--code-bg);
      text-align: left;
      padding: .4rem .6rem;
      border-bottom: 2px solid var(--border);
      font-weight: 600;
    }
    table.data-table td { padding: .35rem .6rem; border-bottom: 1px solid var(--border); vertical-align: top; }
    tr.net-failed td { background: var(--fail-bg); color: var(--fail-text); }
    tr.net-failed td:first-child { font-weight: 700; }
    tr.console-error td { background: var(--fail-bg); }
    .url-cell { word-break: break-all; max-width: 400px; }
    /* Steps */
    ol.steps-list { padding-left: 1.5rem; }
    ol.steps-list li { padding: .3rem 0; font-size: .92rem; }
    .step-kind {
      display: inline-block;
      background: var(--accent-2);
      color: #fff;
      border-radius: 3px;
      padding: .05rem .35rem;
      font-size: .75rem;
      font-weight: 700;
      text-transform: uppercase;
      margin-right: .25rem;
      vertical-align: middle;
    }
    /* Screenshot */
    img.screenshot {
      max-width: 100%;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      display: block;
    }
    /* Code */
    pre.code-block {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1rem;
      overflow-x: auto;
      font-size: .82rem;
      line-height: 1.55;
    }
    code { font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, 'Courier New', monospace; font-size: .88em; }
    .mono { font-family: 'JetBrains Mono', Consolas, monospace; font-size: .82em; }
    p.filename { font-size: .85rem; color: var(--text-muted); margin-bottom: .5rem; }
    /* Badges */
    .badge { display: inline-block; padding: .1rem .45rem; border-radius: 3px; font-size: .78rem; font-weight: 600; }
    .badge-ok { background: #d4edda; color: #155724; }
    .badge-warn { background: #fff3cd; color: #856404; }
    /* Replay */
    .replay-note { font-size: .88rem; color: var(--text-muted); margin-bottom: 1rem; }
    .replay-container { display: flex; flex-direction: column; gap: .75rem; }
    .replay-iframe {
      width: 100%;
      height: 480px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: #fff;
    }
    .replay-controls {
      display: flex;
      align-items: center;
      gap: .75rem;
      font-size: .88rem;
    }
    .replay-controls button {
      padding: .3rem .75rem;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--surface);
      cursor: pointer;
      font-size: 1rem;
    }
    .replay-controls button:hover { background: var(--code-bg); }
    .replay-kind-badge {
      background: var(--accent-2);
      color: #fff;
      border-radius: 3px;
      padding: .1rem .4rem;
      font-size: .75rem;
      font-weight: 700;
      text-transform: uppercase;
      min-width: 60px;
      text-align: center;
    }
    .replay-detail {
      font-size: .82rem;
      color: var(--text-muted);
      font-family: monospace;
      min-height: 1.4em;
      word-break: break-all;
    }
    footer {
      text-align: center;
      margin-top: 3rem;
      font-size: .8rem;
      color: var(--text-muted);
    }
    a { color: var(--accent-2); }
  </style>`;
}

// ─── Nav ──────────────────────────────────────────────────────────────────────
function buildNav(b: CaptureBundle): string {
  const links: Array<[string, string]> = [
    ['#environment', 'Environment'],
  ];
  if (b.screenshotDataUrl) links.push(['#screenshot', 'Screenshot']);
  links.push(['#steps', 'Steps']);
  links.push(['#console', 'Console']);
  links.push(['#network', 'Network']);
  if (b.generatedTest) links.push(['#test', 'Playwright test']);
  if (b.replay && b.replay.length > 0) links.push(['#replay', 'Replay']);
  return `
  <nav class="toc" aria-label="Report sections">
    ${links.map(([href, label]) => `<a href="${esc(href)}">${esc(label)}</a>`).join('')}
  </nav>`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function exportBundleHtml(bundle: CaptureBundle, opts: ExportOptions): ExportedReport {
  // Apply redaction first so every downstream helper works on the cleaned copy.
  const b = opts.redact ? redactBundle(bundle) : bundle;

  const captured = new Date(b.environment.capturedAt).toISOString();
  const slugTitle = b.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const filename = `gotcha-${b.id.slice(0, 6)}-${slugTitle}.html`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(b.title)} — Gotcha bug report</title>
  ${inlineStyles()}
</head>
<body>
  <header class="gotcha-header">
    <div class="logo">Gotcha<span>bug capture</span></div>
    <h1>${esc(b.title)}</h1>
  </header>
  ${buildNav(b)}
  <main>
    <p style="font-size:.85rem;color:#6c757d">Captured ${esc(captured)} · Bundle ID <code>${esc(b.id)}</code></p>
    ${buildEnvironmentSection(b)}
    ${buildScreenshotSection(b)}
    ${buildStepsSection(b)}
    ${buildConsoleSection(b)}
    ${buildNetworkSection(b)}
    ${buildTestSection(b)}
    ${b.replay && b.replay.length > 0 ? buildReplaySection(b.replay) : ''}
  </main>
  <footer>
    <p>Generated by <strong>Gotcha</strong> Chrome extension &mdash; self-contained report, no external dependencies.</p>
  </footer>
</body>
</html>`;

  return { filename, html };
}
