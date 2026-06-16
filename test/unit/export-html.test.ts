import { describe, it, expect } from 'vitest';
import { exportBundleHtml } from '../../src/share/export-html';
import { makeBundle } from '../setup/factory';

describe('share/export-html — exportBundleHtml', () => {
  it('produces a self-contained HTML doc with all sections', () => {
    const { filename, html } = exportBundleHtml(
      makeBundle({
        id: 'report99',
        screenshotDataUrl: 'data:image/png;base64,AAAA',
        steps: [{ id: 's1', kind: 'click', selector: '#go', label: 'Go', value: 'v', ts: 1 }],
        console: [{ id: 'c1', level: 'error', message: 'boom', ts: 1 }],
        network: [{ id: 'n1', url: 'https://a/x', method: 'GET', status: 500, durationMs: 3, failed: true, ts: 1 }],
        generatedTest: { filename: 'g.spec.ts', source: "test('x', () => {});" },
      }),
      { redact: false },
    );
    expect(filename).toMatch(/^gotcha-report.*\.html$/);
    expect(html.startsWith('<!DOCTYPE html>') || html.includes('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('Environment');
    expect(html).toContain('Screenshot');
    expect(html).toContain('Reproduction steps');
    expect(html).toContain('boom');
    expect(html).toContain('https://a/x');
    expect(html).toContain('g.spec.ts');
    expect(html).toContain('<style'); // inlined styles
  });

  it('renders empty-state messaging when nothing was captured', () => {
    const { html } = exportBundleHtml(makeBundle(), { redact: false });
    expect(html).toContain('No steps recorded');
  });

  it('escapes HTML in bundle-derived strings (no injection)', () => {
    const { html } = exportBundleHtml(
      makeBundle({
        title: '<img src=x onerror=alert(1)>',
        console: [{ id: 'c1', level: 'error', message: '</script><script>evil()</script>', ts: 1 }],
      }),
      { redact: false },
    );
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x');
    expect(html).not.toContain('<script>evil()</script>');
  });

  it('redacts when asked', () => {
    const { html } = exportBundleHtml(
      makeBundle({
        network: [
          {
            id: 'n1',
            url: 'https://a/x',
            method: 'POST',
            status: 200,
            durationMs: 1,
            failed: false,
            ts: 1,
            requestHeaders: { authorization: 'Bearer supersecret-token-value' },
          },
        ],
      }),
      { redact: true },
    );
    expect(html).not.toContain('supersecret-token-value');
  });

  it('escapes every < in the embedded replay JSON when snapshot HTML carries script-breaking sequences', () => {
    const { html } = exportBundleHtml(
      makeBundle({
        replay: [
          // `<!--` + `<script` inside script text flips the HTML parser into the
          // double-escaped state; a literal </script> closes the block early.
          { t: 0, kind: 'snapshot', html: '<html><body><!--<script>x</script>--></body></html>' },
          { t: 5, kind: 'input', selector: '#a', value: '</script><script>evil()</script>' },
        ],
      }),
      { redact: false },
    );
    const m = html.match(/var EVENTS = (.*);/);
    expect(m).toBeTruthy();
    // No raw `<` may survive inside the inline JSON — < only.
    expect(m![1]).not.toContain('<');
    expect(m![1]).toContain('\\u003c');
  });

  it('escapes the screenshot data URL when it carries attribute-breaking characters', () => {
    const { html } = exportBundleHtml(
      makeBundle({
        screenshotDataUrl: 'data:image/png;base64,AAAA" onerror="alert(1)',
      }),
      { redact: false },
    );
    expect(html).not.toContain('" onerror="alert(1)');
    expect(html).toContain('src="data:image/png;base64,AAAA&quot; onerror=&quot;alert(1)"');
  });

  it('renders mutation frames in the inline viewer when the initial snapshot rolled out of the ring', () => {
    const mutationHtml = '<body><main>frame-after-rollout</main></body>';
    const { html } = exportBundleHtml(
      makeBundle({
        // No snapshot event at all — only deltas + a mutation body-frame, the
        // shape of a long recording whose initial snapshot left the ring.
        replay: [
          { t: 100, kind: 'scroll', x: 0, y: 250 },
          { t: 200, kind: 'mutation', selector: 'body', html: mutationHtml },
        ],
      }),
      { redact: false },
    );
    // Execute the inline viewer script against stubbed DOM elements and assert
    // the mutation frame is written into the iframe like a snapshot.
    const script = html.match(/<script>\s*\(function \(\) \{([\s\S]*?)\}\)\(\);\s*<\/script>/);
    expect(script).toBeTruthy();
    const writes: string[] = [];
    const stubEl = (): Record<string, unknown> => ({ textContent: '', addEventListener: () => {} });
    const frame = {
      contentDocument: { open: () => {}, write: (h: string) => writes.push(h), close: () => {} },
    };
    const fakeDoc = {
      getElementById: (id: string) => (id === 'replay-frame' ? frame : stubEl()),
    };
    new Function('document', `(function () {${script![1]}})();`)(fakeDoc);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('frame-after-rollout');
  });

  it('embeds a replay payload when replay events exist', () => {
    const { html } = exportBundleHtml(
      makeBundle({
        replay: [{ t: 0, kind: 'snapshot', html: '<html><body>hi</body></html>' }],
      }),
      { redact: false },
    );
    expect(html.toLowerCase()).toContain('replay');
  });

  it('states the replay fidelity limits honestly (not a pixel video)', () => {
    const { html } = exportBundleHtml(
      makeBundle({ replay: [{ t: 0, kind: 'snapshot', html: '<html><body>hi</body></html>' }] }),
      { redact: false },
    );
    expect(html).toContain('not a pixel video');
    expect(html).toMatch(/Canvas\/WebGL/);
  });
});
