import { describe, it, expect } from 'vitest';
import {
  absolutizeCss,
  findFontUrls,
  fontMimeFor,
  inlineFontUrls,
} from '../../src/shared/css-util';

const BASE = 'https://cdn.example.com/assets/app.css';

describe('absolutizeCss', () => {
  it('should resolve a relative url() against the stylesheet href', () => {
    const out = absolutizeCss('.a{background:url(img/x.png)}', BASE);
    expect(out).toContain('url(https://cdn.example.com/assets/img/x.png)');
  });

  it('should resolve a root-relative url() against the href origin', () => {
    const out = absolutizeCss('.a{background:url(/img/x.png)}', BASE);
    expect(out).toContain('url(https://cdn.example.com/img/x.png)');
  });

  it('should preserve the original quote style', () => {
    expect(absolutizeCss(".a{src:url('f.woff')}", BASE)).toContain(
      "url('https://cdn.example.com/assets/f.woff')",
    );
    expect(absolutizeCss('.a{src:url("f.woff")}', BASE)).toContain(
      'url("https://cdn.example.com/assets/f.woff")',
    );
  });

  it('should leave absolute, protocol-relative, data and hash URLs untouched', () => {
    const css =
      '.a{background:url(https://other.com/x.png)}' +
      '.b{background:url(//cdn.net/y.png)}' +
      '.c{background:url(data:image/png;base64,AAAA)}' +
      '.d{clip-path:url(#mask)}';
    expect(absolutizeCss(css, BASE)).toBe(css);
  });

  it('should not throw on malformed url() and return it unchanged', () => {
    const css = '.a{background:url(   )}';
    expect(() => absolutizeCss(css, BASE)).not.toThrow();
  });
});

describe('findFontUrls', () => {
  it('should return absolute http(s) font urls referenced by url()', () => {
    const css =
      "@font-face{src:url('https://cdn.example.com/f.woff2') format('woff2')}" +
      '@font-face{src:url(https://cdn.example.com/g.ttf)}';
    expect(findFontUrls(css).sort()).toEqual([
      'https://cdn.example.com/f.woff2',
      'https://cdn.example.com/g.ttf',
    ]);
  });

  it('should ignore non-font and non-absolute urls', () => {
    const css =
      '.a{background:url(https://cdn.example.com/pic.png)}' + // image, not a font
      '@font-face{src:url(/rel/f.woff2)}'; // relative — not yet absolutized
    expect(findFontUrls(css)).toEqual([]);
  });

  it('should match font urls carrying a query string and dedupe repeats', () => {
    const css =
      '@font-face{src:url(https://cdn.example.com/f.woff2?v=2)}' +
      '@font-face{src:url(https://cdn.example.com/f.woff2?v=2)}';
    expect(findFontUrls(css)).toEqual(['https://cdn.example.com/f.woff2?v=2']);
  });
});

describe('fontMimeFor', () => {
  it('should map known font extensions to their mime type', () => {
    expect(fontMimeFor('https://x/a.woff2')).toBe('font/woff2');
    expect(fontMimeFor('https://x/a.woff?v=1')).toBe('font/woff');
    expect(fontMimeFor('https://x/a.ttf')).toBe('font/ttf');
    expect(fontMimeFor('https://x/a.otf')).toBe('font/otf');
    expect(fontMimeFor('https://x/a.eot')).toBe('application/vnd.ms-fontobject');
  });

  it('should fall back to octet-stream for an unknown extension', () => {
    expect(fontMimeFor('https://x/a.bin')).toBe('application/octet-stream');
  });
});

describe('inlineFontUrls', () => {
  it('should replace mapped font urls with their data uri, preserving quotes', () => {
    const css = "@font-face{src:url('https://x/f.woff2') format('woff2')}";
    const out = inlineFontUrls(
      css,
      new Map([['https://x/f.woff2', 'data:font/woff2;base64,AAAA']]),
    );
    expect(out).toContain("url('data:font/woff2;base64,AAAA')");
  });

  it('should leave unmapped urls untouched', () => {
    const css = '@font-face{src:url(https://x/f.woff2)}.a{background:url(https://x/p.png)}';
    const out = inlineFontUrls(css, new Map([['https://x/other.woff2', 'data:font/woff2;base64,Z']]));
    expect(out).toBe(css);
  });

  it('should return the css unchanged for an empty map', () => {
    const css = '@font-face{src:url(https://x/f.woff2)}';
    expect(inlineFontUrls(css, new Map())).toBe(css);
  });
});
