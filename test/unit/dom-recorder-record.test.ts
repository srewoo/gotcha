/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { CONTROL_MARKER, BRIDGE_MARKER } from '../../src/shared/messaging';

let posted: Array<{ marker?: string; type?: string; event?: any }> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function control(action: string): void {
  window.dispatchEvent(
    new MessageEvent('message', { data: { marker: CONTROL_MARKER, action }, source: window as unknown as Window }),
  );
}
const replayEvents = () => posted.filter((m) => m.marker === BRIDGE_MARKER && m.type === 'replay').map((m) => m.event);

beforeAll(async () => {
  vi.spyOn(window, 'postMessage').mockImplementation((msg: unknown) => {
    posted.push(msg as { marker?: string });
  });
  const { installShadowRegistry } = await import('../../src/injected/shadow-registry');
  installShadowRegistry(); // so attachShadow roots are tracked for observation
  const { installDomRecorder } = await import('../../src/injected/dom-recorder');
  installDomRecorder();
});

beforeEach(() => {
  posted = [];
  control('replay-off');
});

describe('dom-recorder — recording session', () => {
  it('emits an initial styled snapshot on replay-on', async () => {
    control('replay-on');
    await sleep(5);
    const snaps = replayEvents().filter((e) => e.kind === 'snapshot');
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    expect(snaps[0].t).toBe(0);
    expect(typeof snaps[0].html).toBe('string');
  });

  it('captures DOM mutations as mutation frames (throttled)', async () => {
    control('replay-on');
    const div = document.createElement('div');
    div.textContent = 'new content';
    document.body.appendChild(div);
    await sleep(320); // > MUTATION_THROTTLE_MS
    expect(replayEvents().some((e) => e.kind === 'mutation')).toBe(true);
  });

  it('records scroll / resize / input / mouse events while enabled', async () => {
    control('replay-on');
    const input = document.createElement('input');
    input.name = 'q';
    document.body.appendChild(input);
    input.value = 'typed';

    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 7 }));
    await sleep(260); // clear scroll/mouse throttles

    const kinds = new Set(replayEvents().map((e) => e.kind));
    expect(kinds.has('scroll')).toBe(true);
    expect(kinds.has('input')).toBe(true);
  });

  it('also records select/textarea via the change event', async () => {
    control('replay-on');
    const sel = document.createElement('select');
    sel.name = 'country';
    document.body.appendChild(sel);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(20);
    expect(replayEvents().some((e) => e.kind === 'input')).toBe(true);
  });

  it('masks sensitive input values', async () => {
    control('replay-on');
    const pw = document.createElement('input');
    pw.type = 'password';
    pw.name = 'password';
    document.body.appendChild(pw);
    pw.value = 'hunter2';
    pw.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(20);
    const inputEv = replayEvents().filter((e) => e.kind === 'input').pop();
    expect(inputEv?.value).not.toContain('hunter2');
  });

  it('stops emitting after replay-off', async () => {
    control('replay-on');
    await sleep(5);
    control('replay-off');
    posted = [];
    document.body.appendChild(document.createElement('span'));
    window.dispatchEvent(new Event('scroll'));
    await sleep(320);
    expect(replayEvents()).toHaveLength(0);
  });

  it('always-on mode also emits an initial snapshot', async () => {
    control('replay-always-on');
    await sleep(5);
    expect(replayEvents().some((e) => e.kind === 'snapshot')).toBe(true);
  });

  it('captures mutations INSIDE a shadow root attached before recording', async () => {
    const host = document.createElement('pre-existing-widget');
    document.body.appendChild(host);
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = '<p>initial</p>';

    control('replay-on');
    await sleep(5);
    posted = [];

    // Mutate inside the shadow root — a document-level observer would miss this.
    sr.querySelector('p')!.textContent = 'shadow-changed';
    await sleep(320); // > MUTATION_THROTTLE_MS
    const frame = replayEvents().find((e) => e.kind === 'mutation');
    expect(frame).toBeDefined();
    expect(frame.html).toContain('shadow-changed');
  });

  it('captures mutations inside a shadow root attached AFTER recording starts', async () => {
    control('replay-on');
    await sleep(5);
    posted = [];

    const host = document.createElement('lazy-widget');
    document.body.appendChild(host);
    const sr = host.attachShadow({ mode: 'open' }); // onShadowRoot → observed live
    sr.innerHTML = '<span>lazy</span>';
    await sleep(320);
    sr.querySelector('span')!.textContent = 'lazy-updated';
    await sleep(320);
    expect(replayEvents().some((e) => e.kind === 'mutation' && e.html?.includes('lazy-updated'))).toBe(true);
  });

  it('inlines readable same-origin CSS into the full snapshot', async () => {
    const style = document.createElement('style');
    style.textContent = '.gotcha-test-rule { color: rebeccapurple; }';
    document.head.appendChild(style);
    control('replay-on');
    await sleep(5);
    const snap = replayEvents().find((e) => e.kind === 'snapshot');
    expect(snap?.html).toContain('rebeccapurple');
    style.remove();
  });
});
