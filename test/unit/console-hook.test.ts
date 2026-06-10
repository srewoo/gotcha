/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import { serializeArg, installConsoleHook } from '../../src/injected/console-hook';
import { BRIDGE_MARKER } from '../../src/shared/messaging';

describe('console-hook — serializeArg', () => {
  it('should pass strings through and format Errors', () => {
    expect(serializeArg('hello')).toBe('hello');
    expect(serializeArg(new TypeError('boom'))).toBe('TypeError: boom');
  });

  it('should serialize a plain object as JSON', () => {
    expect(serializeArg({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
  });

  it('should serialize DOM Events with their diagnostic fields, not "[object Event]"', () => {
    // The exact symptom from the captured Cloudflare log: an Event logged as an
    // argument used to collapse to "[object Event]" / "{}".
    const err = serializeArg(new Event('error'));
    expect(err).toContain('type=error');
    expect(err).not.toContain('[object Event]');

    const close = serializeArg(new CloseEvent('close', { code: 1006, reason: 'abnormal' }));
    expect(close).toContain('type=close');
    expect(close).toContain('code=1006');
    expect(close).toContain('reason=abnormal');
  });

  it('should not throw or lose data on circular references', () => {
    const obj: Record<string, unknown> = { name: 'root' };
    obj.self = obj;
    const out = serializeArg(obj);
    expect(out).toContain('root');
    expect(out).toContain('[Circular]');
  });

  it('should describe functions and undefined readably', () => {
    expect(serializeArg(undefined)).toBe('undefined');
    expect(serializeArg(function named() {})).toContain('Function: named');
  });
});

describe('console-hook — installConsoleHook', () => {
  it('forwards console.* calls to the bridge while preserving the original', () => {
    const posted: Array<{ marker?: string; type?: string; entry?: any }> = [];
    const spy = vi.spyOn(window, 'postMessage').mockImplementation((m: unknown) => {
      posted.push(m as { marker?: string });
    });
    const origError = vi.spyOn(console, 'error').mockImplementation(() => {});

    installConsoleHook();
    // eslint-disable-next-line no-console
    console.error('rendered', { a: 1 });

    const bridged = posted.filter((m) => m.marker === BRIDGE_MARKER && m.type === 'console');
    expect(bridged.length).toBeGreaterThanOrEqual(1);
    expect(bridged[bridged.length - 1]!.entry.level).toBe('error');
    expect(bridged[bridged.length - 1]!.entry.message).toContain('rendered');
    expect(origError).toHaveBeenCalled(); // original console still invoked

    spy.mockRestore();
    origError.mockRestore();
  });
});
