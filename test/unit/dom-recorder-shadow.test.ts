/**
 * @vitest-environment happy-dom
 *
 * Verifies the replay snapshot serializer captures styles that cloneNode/outerHTML
 * drop on component-based apps — constructed `adoptedStyleSheets` and open shadow
 * DOM — which is what made auth-SPA replays render unstyled. The serializer emits
 * shadow roots as Declarative Shadow DOM (`<template shadowrootmode="open">`); we
 * separately confirmed in a real browser that the replay iframe's srcdoc
 * re-hydrates that natively, so here we assert the captured STRING is correct.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { snapshotFull, snapshotBody } from '../../src/injected/dom-recorder';
import { installShadowRegistry } from '../../src/injected/shadow-registry';

function makeSheet(cssText: string): CSSStyleSheet {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(cssText);
  return sheet;
}

describe('dom-recorder serializer — shadow DOM & adopted stylesheets', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    document.adoptedStyleSheets = [];
  });

  it("should inline document.adoptedStyleSheets that cloneNode can't see", () => {
    document.adoptedStyleSheets = [makeSheet('.doc-adopted{color:hotpink}')];
    document.body.innerHTML = '<div class="doc-adopted">x</div>';
    const html = snapshotFull();
    expect(html).toContain('.doc-adopted');
    expect(html).toContain('hotpink');
  });

  it('should serialize an open shadow root as Declarative Shadow DOM with its styles', () => {
    const host = document.createElement('my-widget');
    document.body.appendChild(host);
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = '<style>.s{color:rgb(9,8,7)}</style><p class="s">hi</p>';
    sr.adoptedStyleSheets = [makeSheet('.s{font-size:33px}')];

    const html = snapshotBody();

    // The host is re-emitted with a hydratable DSD template…
    expect(html).toContain('shadowrootmode="open"');
    // …carrying both the shadow's inline <style> (verbatim) and its adopted styles…
    expect(html).toContain('rgb(9,8,7)');
    expect(html).toContain('font-size: 33px');
    // …and the shadow content itself.
    expect(html).toContain('class="s"');
  });

  it('should mask sensitive inputs INSIDE shadow DOM', () => {
    const host = document.createElement('login-box');
    document.body.appendChild(host);
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = '<input type="password" value="hunter2" />';

    const html = snapshotBody();
    expect(html).not.toContain('hunter2');
    expect(html).toContain('«redacted»');
  });

  it('should recurse into nested shadow roots', () => {
    const outer = document.createElement('outer-el');
    document.body.appendChild(outer);
    const outerRoot = outer.attachShadow({ mode: 'open' });
    const inner = document.createElement('inner-el');
    outerRoot.appendChild(inner);
    const innerRoot = inner.attachShadow({ mode: 'open' });
    innerRoot.innerHTML = '<style>.deep{display:grid}</style><span class="deep">z</span>';

    const html = snapshotBody();
    // Two nested DSD templates and the deep style survive.
    expect(html.match(/shadowrootmode="open"/g)?.length).toBe(2);
    expect(html).toContain('.deep');
  });

  it('should capture closed shadow roots once the attachShadow registry is installed', () => {
    installShadowRegistry(); // patches attachShadow (idempotent)
    const host = document.createElement('closed-el');
    document.body.appendChild(host);
    const sr = host.attachShadow({ mode: 'closed' });
    sr.innerHTML = '<style>.x{color:rgb(1,2,3)}</style><span class="x">secret-ui</span>';

    // The page still sees it as closed (non-intrusive)…
    expect(host.shadowRoot).toBeNull();
    // …but the serializer recovers it via the registry.
    const html = snapshotBody();
    expect(html).toContain('shadowrootmode="open"'); // re-emitted as hydratable DSD
    expect(html).toContain('secret-ui');
    expect(html).toContain('rgb(1,2,3)');
  });

  it('should not throw when an element has no shadow root', () => {
    document.body.innerHTML = '<div>plain</div>';
    expect(() => snapshotBody()).not.toThrow();
    expect(snapshotBody()).toContain('plain');
  });

  it('should still strip scripts in the light DOM', () => {
    document.body.innerHTML = '<div>keep</div><script>evil()</script>';
    const html = snapshotBody();
    expect(html).toContain('keep');
    expect(html).not.toContain('evil()');
  });
});
