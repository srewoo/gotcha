/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest';
import { serializeBody } from '../../src/injected/body-serializer';

describe('body-serializer — serializeBody', () => {
  it('should return the string unchanged when given a string', () => {
    expect(serializeBody('a=1&b=2')).toBe('a=1&b=2');
  });

  it('should return undefined when the body is null or undefined', () => {
    expect(serializeBody(null)).toBeUndefined();
    expect(serializeBody(undefined)).toBeUndefined();
  });

  it('should serialize URLSearchParams via toString when given URLSearchParams', () => {
    expect(serializeBody(new URLSearchParams({ q: 'x', page: '2' }))).toBe('q=x&page=2');
  });

  it('should render FormData as key=value lines when values are strings', () => {
    const fd = new FormData();
    fd.append('user', 'amy');
    fd.append('role', 'admin');
    expect(serializeBody(fd)).toBe('user=amy\nrole=admin');
  });

  it('should render a File placeholder with name and size when FormData contains a File', () => {
    const fd = new FormData();
    fd.append('doc', new File(['abc'], 'a.txt', { type: 'text/plain' }));
    expect(serializeBody(fd)).toBe('doc=[File a.txt, 3 bytes]');
  });

  it('should render a Blob placeholder without reading it when given a Blob', () => {
    expect(serializeBody(new Blob(['xy'], { type: 'text/plain' }))).toBe(
      '[Blob text/plain, 2 bytes]',
    );
  });

  it('should render binary placeholders when given an ArrayBuffer or TypedArray', () => {
    expect(serializeBody(new ArrayBuffer(8))).toBe('[binary 8 bytes]');
    expect(serializeBody(new Uint8Array(4))).toBe('[binary 4 bytes]');
  });

  it('should render a Document placeholder when given a Document', () => {
    expect(serializeBody(document)).toBe('[Document]');
  });
});
