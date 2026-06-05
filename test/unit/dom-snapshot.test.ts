/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { captureDomSnapshot } from '../../src/content/dom-snapshot';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setDocumentBody(html: string): void {
  document.body.innerHTML = html;
}

// ─── Script removal ───────────────────────────────────────────────────────────

describe('captureDomSnapshot — script removal', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  it('should strip <script> tags from the snapshot', () => {
    setDocumentBody('<div>Hello</div><script>alert("xss")</script>');
    const snapshot = captureDomSnapshot();
    expect(snapshot).not.toContain('<script>');
    expect(snapshot).not.toContain('alert("xss")');
    expect(snapshot).toContain('Hello');
  });

  it('should strip <noscript> tags from the snapshot', () => {
    setDocumentBody('<div>Content</div><noscript>Please enable JS</noscript>');
    const snapshot = captureDomSnapshot();
    expect(snapshot).not.toContain('<noscript>');
    expect(snapshot).not.toContain('Please enable JS');
  });

  it('should strip inline scripts in head', () => {
    document.head.innerHTML = '<script>window.__config={};</script><title>Test</title>';
    const snapshot = captureDomSnapshot();
    expect(snapshot).not.toContain('window.__config');
  });
});

// ─── Password / secret input masking ─────────────────────────────────────────

describe('captureDomSnapshot — sensitive input masking', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  it('should mask password input values with «redacted»', () => {
    setDocumentBody('<form><input type="password" name="pwd" value="super-secret" /></form>');
    const snapshot = captureDomSnapshot();
    expect(snapshot).not.toContain('super-secret');
    expect(snapshot).toContain('«redacted»');
  });

  it('should mask inputs named with "pass" pattern', () => {
    setDocumentBody('<input name="user_pass" value="mysecret123" />');
    const snapshot = captureDomSnapshot();
    expect(snapshot).not.toContain('mysecret123');
    expect(snapshot).toContain('«redacted»');
  });

  it('should mask inputs named with "secret" pattern', () => {
    setDocumentBody('<input name="api_secret" value="topsecret" />');
    const snapshot = captureDomSnapshot();
    expect(snapshot).not.toContain('topsecret');
    expect(snapshot).toContain('«redacted»');
  });

  it('should mask inputs named with "card" pattern', () => {
    setDocumentBody('<input name="card_number" value="4111111111111111" />');
    const snapshot = captureDomSnapshot();
    expect(snapshot).not.toContain('4111111111111111');
    expect(snapshot).toContain('«redacted»');
  });

  it('should mask inputs named with "cvv" pattern', () => {
    setDocumentBody('<input name="cvv" value="123" />');
    const snapshot = captureDomSnapshot();
    expect(snapshot).not.toContain('value="123"');
    expect(snapshot).toContain('«redacted»');
  });

  it('should mask inputs named with "ssn" pattern', () => {
    setDocumentBody('<input name="ssn" value="123-45-6789" />');
    const snapshot = captureDomSnapshot();
    expect(snapshot).not.toContain('123-45-6789');
    expect(snapshot).toContain('«redacted»');
  });

  it('should preserve non-sensitive input values', () => {
    setDocumentBody('<input name="username" value="john_doe" type="text" />');
    const snapshot = captureDomSnapshot();
    // The username input should NOT be masked
    expect(snapshot).not.toContain('«redacted»');
  });
});

// ─── Size cap ─────────────────────────────────────────────────────────────────

describe('captureDomSnapshot — size cap', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  it('should return a snapshot no longer than 500_000 chars', () => {
    // Fill body with a lot of content
    const bigContent = 'x'.repeat(600_000);
    setDocumentBody(`<div>${bigContent}</div>`);
    const snapshot = captureDomSnapshot();
    expect(snapshot.length).toBeLessThanOrEqual(500_000);
  });

  it('should return the full snapshot when content is below the cap', () => {
    setDocumentBody('<p>Hello world</p>');
    const snapshot = captureDomSnapshot();
    expect(snapshot.length).toBeLessThan(500_000);
    expect(snapshot).toContain('Hello world');
  });
});

// ─── DOCTYPE prefix ───────────────────────────────────────────────────────────

describe('captureDomSnapshot — output format', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  it('should start with <!DOCTYPE html>', () => {
    setDocumentBody('<p>Test content</p>');
    const snapshot = captureDomSnapshot();
    expect(snapshot.startsWith('<!DOCTYPE html>')).toBe(true);
  });
});
