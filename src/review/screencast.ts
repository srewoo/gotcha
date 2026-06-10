// True-pixel screencast player (deep-capture feature). Unlike the DOM replay,
// these are actual rendered JPEG frames from chrome.debugger's Page screencast,
// so canvas/WebGL/<video>/iframes all show faithfully. We play them back by
// swapping an <img> src on a requestAnimationFrame loop along the frame
// timeline, with a play/pause button + scrubber — same transport as the replay.

import type { CaptureBundle, ScreencastFrame } from '@shared/types';

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Index of the last frame at or before targetT (frames are time-ordered).
function frameIndexAt(frames: readonly ScreencastFrame[], targetT: number): number {
  let idx = 0;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i]!.t <= targetT) idx = i;
    else break;
  }
  return idx;
}

export function mountScreencast(host: HTMLElement, bundle: CaptureBundle): void {
  const frames = bundle.screencast ?? [];
  if (frames.length === 0) {
    host.innerHTML = '<p class="replay-empty">No screencast frames in this capture.</p>';
    return;
  }
  const duration = frames[frames.length - 1]!.t;

  host.innerHTML = '';
  host.className = 'replay-host';

  const viewportWrap = document.createElement('div');
  viewportWrap.className = 'replay-viewport-wrap';
  const img = document.createElement('img');
  img.className = 'replay-iframe screencast-img';
  img.alt = 'Screencast frame';
  img.src = frames[0]!.data;
  viewportWrap.appendChild(img);

  const bar = document.createElement('div');
  bar.className = 'replay-bar';
  const playBtn = document.createElement('button');
  playBtn.className = 'replay-btn replay-play';
  playBtn.type = 'button';
  playBtn.textContent = '▶';
  playBtn.setAttribute('aria-label', 'Play');
  const scrubber = document.createElement('input');
  scrubber.type = 'range';
  scrubber.className = 'replay-scrubber';
  scrubber.min = '0';
  scrubber.max = String(Math.max(duration, 1));
  scrubber.value = '0';
  scrubber.setAttribute('aria-label', 'Playback position');
  const timeEl = document.createElement('span');
  timeEl.className = 'replay-time';
  timeEl.textContent = `0:00 / ${fmt(duration)}`;
  bar.append(playBtn, scrubber, timeEl);

  const note = document.createElement('p');
  note.className = 'replay-note';
  note.textContent = `True-pixel recording (${frames.length} frames) — faithful for canvas/WebGL, video, and iframes.`;

  host.append(viewportWrap, bar, note);

  let playing = false;
  let currentT = 0;
  let wallStart = 0;
  let timelineAtPlay = 0;
  let raf = 0;

  function showAt(t: number): void {
    currentT = Math.max(0, Math.min(t, duration));
    img.src = frames[frameIndexAt(frames, currentT)]!.data;
    scrubber.value = String(currentT);
    timeEl.textContent = `${fmt(currentT)} / ${fmt(duration)}`;
  }

  function tick(): void {
    if (!playing) return;
    currentT = Math.min(timelineAtPlay + (performance.now() - wallStart), duration);
    showAt(currentT);
    if (currentT >= duration) {
      pause();
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  function play(): void {
    if (playing) return;
    if (currentT >= duration) showAt(0);
    playing = true;
    wallStart = performance.now();
    timelineAtPlay = currentT;
    playBtn.textContent = '⏸';
    playBtn.setAttribute('aria-label', 'Pause');
    raf = requestAnimationFrame(tick);
  }

  function pause(): void {
    playing = false;
    cancelAnimationFrame(raf);
    playBtn.textContent = '▶';
    playBtn.setAttribute('aria-label', 'Play');
  }

  playBtn.addEventListener('click', () => (playing ? pause() : play()));
  scrubber.addEventListener('input', () => {
    pause();
    showAt(Number(scrubber.value));
  });
}
