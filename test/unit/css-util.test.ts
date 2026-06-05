import { describe, it, expect } from 'vitest';
import { absolutizeCss } from '../../src/shared/css-util';

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
