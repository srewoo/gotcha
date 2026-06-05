import { describe, it, expect } from 'vitest';
import { uid } from '../../src/shared/uid';

describe('uid', () => {
  it('should return a non-empty string', () => {
    expect(typeof uid()).toBe('string');
    expect(uid().length).toBeGreaterThan(0);
  });

  it('should return unique values on successive calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => uid()));
    expect(ids.size).toBe(100);
  });

  it('should match UUID format (crypto.randomUUID is available in jsdom)', () => {
    // In a modern jsdom/node environment, crypto.randomUUID is available,
    // so uid() should return a standard UUID v4 string.
    const id = uid();
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(id).toMatch(uuidPattern);
  });

  it('should produce IDs of consistent length when using randomUUID', () => {
    const ids = Array.from({ length: 10 }, () => uid());
    const lengths = new Set(ids.map((id) => id.length));
    // All UUIDs are 36 chars
    expect(lengths.size).toBe(1);
    expect([...lengths][0]).toBe(36);
  });
});
