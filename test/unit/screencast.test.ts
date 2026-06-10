/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest';
import { mountScreencast } from '../../src/review/screencast';
import { makeBundle } from '../setup/factory';

const frames = [
  { t: 0, data: 'data:image/jpeg;base64,AAAA' },
  { t: 500, data: 'data:image/jpeg;base64,BBBB' },
  { t: 1000, data: 'data:image/jpeg;base64,CCCC' },
];

describe('review/screencast — mountScreencast', () => {
  it('renders an empty state when there are no frames', () => {
    const host = document.createElement('div');
    mountScreencast(host, makeBundle());
    expect(host.textContent).toContain('No screencast frames');
  });

  it('renders the first frame, transport controls and the fidelity note', () => {
    const host = document.createElement('div');
    mountScreencast(host, makeBundle({ screencast: frames }));
    const img = host.querySelector('img.screencast-img') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
    expect(host.querySelector('.replay-play')).toBeTruthy();
    expect(host.querySelector('.replay-scrubber')).toBeTruthy();
    expect(host.querySelector('.replay-note')?.textContent).toContain('True-pixel');
  });

  it('scrubbing shows the nearest preceding frame', () => {
    const host = document.createElement('div');
    mountScreencast(host, makeBundle({ screencast: frames }));
    const scrubber = host.querySelector<HTMLInputElement>('.replay-scrubber')!;
    const img = host.querySelector('img.screencast-img') as HTMLImageElement;
    scrubber.value = '700';
    scrubber.dispatchEvent(new Event('input'));
    // 700ms → last frame at/before is the 500ms one (BBBB)
    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,BBBB');
    scrubber.value = '1000';
    scrubber.dispatchEvent(new Event('input'));
    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,CCCC');
  });

  it('toggles play/pause', () => {
    const host = document.createElement('div');
    mountScreencast(host, makeBundle({ screencast: frames }));
    const play = host.querySelector<HTMLButtonElement>('.replay-play')!;
    expect(play.textContent).toBe('▶');
    play.click();
    expect(play.textContent).toBe('⏸');
    play.click();
    expect(play.textContent).toBe('▶');
  });
});
