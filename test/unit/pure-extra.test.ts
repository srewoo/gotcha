import { describe, it, expect } from 'vitest';
import { absolutizeCss } from '../../src/shared/css-util';
import {
  isBridgeMessage,
  isControlMessage,
  isFrameForward,
  BRIDGE_MARKER,
  CONTROL_MARKER,
  FRAME_FWD_MARKER,
} from '../../src/shared/messaging';

describe('shared/css-util — absolutizeCss', () => {
  it('rewrites relative url() against the base href', () => {
    const out = absolutizeCss('.a{background:url(img/bg.png)}', 'https://cdn.example.com/css/site.css');
    expect(out).toContain('url(https://cdn.example.com/css/img/bg.png)');
  });

  it('preserves quotes around the url', () => {
    expect(absolutizeCss(".a{background:url('x.png')}", 'https://c/a/')).toContain("url('https://c/a/x.png')");
    expect(absolutizeCss('.a{background:url("x.png")}', 'https://c/a/')).toContain('url("https://c/a/x.png")');
  });

  it('leaves absolute, protocol-relative, data: and hash URLs untouched', () => {
    const css =
      '.a{background:url(https://x/y.png)} .b{background:url(//cdn/z.png)} .c{background:url(data:image/png;base64,AAA)} .d{mask:url(#frag)}';
    const out = absolutizeCss(css, 'https://base/');
    expect(out).toContain('url(https://x/y.png)');
    expect(out).toContain('url(//cdn/z.png)');
    expect(out).toContain('url(data:image/png;base64,AAA)');
    expect(out).toContain('url(#frag)');
  });

  it('returns the original match when the base href is invalid', () => {
    const out = absolutizeCss('.a{background:url(img.png)}', 'not a url');
    expect(out).toContain('url(img.png)');
  });
});

describe('shared/messaging — type guards', () => {
  it('isBridgeMessage matches only marked payloads', () => {
    expect(isBridgeMessage({ marker: BRIDGE_MARKER, type: 'console' })).toBe(true);
    expect(isBridgeMessage({ marker: 'other' })).toBe(false);
    expect(isBridgeMessage(null)).toBe(false);
    expect(isBridgeMessage('string')).toBe(false);
  });

  it('isControlMessage matches the control marker', () => {
    expect(isControlMessage({ marker: CONTROL_MARKER, action: 'replay-on' })).toBe(true);
    expect(isControlMessage({ marker: BRIDGE_MARKER })).toBe(false);
    expect(isControlMessage(undefined)).toBe(false);
  });

  it('isFrameForward matches the frame-forward marker', () => {
    expect(isFrameForward({ marker: FRAME_FWD_MARKER, payload: {} })).toBe(true);
    expect(isFrameForward({ marker: CONTROL_MARKER })).toBe(false);
    expect(isFrameForward(42)).toBe(false);
  });
});
