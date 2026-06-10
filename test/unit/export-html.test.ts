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
