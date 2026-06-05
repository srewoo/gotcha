import type { CaptureStatus } from '@shared/messaging';

// In-page recording widget (prototype screen 2). Rendered in a closed Shadow
// DOM so the host page's styles and scripts can neither see nor restyle it.
// All capture state still lives in the content script's buffers — this is
// purely a view + a Finish trigger.

const HOST_ID = '__gotcha_widget_host__';
const POS_KEY = 'gotchaWidgetPos';

const STYLE = `
  :host { all: initial; }
  .w {
    position: fixed; bottom: 22px; right: 22px; z-index: 2147483647;
    background: #1a1a1a; color: #faf8f3; border-radius: 9px; padding: 13px;
    width: 226px; box-shadow: 0 14px 36px rgba(0,0,0,.28);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif;
    touch-action: none;
  }
  .w.dragging { box-shadow: 0 18px 44px rgba(0,0,0,.4); }
  .rec { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 700; margin-bottom: 11px; cursor: grab; user-select: none; }
  .w.dragging .rec { cursor: grabbing; }
  .grip { margin-left: auto; opacity: .45; font-size: 13px; letter-spacing: 1px; }
  .blink { width: 8px; height: 8px; border-radius: 50%; background: #e0483d; animation: blink 1.1s infinite; }
  @keyframes blink { 50% { opacity: .25; } }
  .live { font-size: 11.5px; display: flex; justify-content: space-between; padding: 3px 0; color: #cbc7bc; }
  .live b { color: #fff; }
  .btns { display: flex; gap: 7px; margin-top: 10px; }
  .finish {
    flex: 1; padding: 9px; border: none; border-radius: 6px;
    background: #e0483d; color: #fff; font-weight: 700; cursor: pointer; font-size: 13px;
  }
  .finish:hover { background: #c93a30; }
  .finish:disabled { opacity: .6; cursor: default; }
  .pause {
    padding: 9px 12px; border: 1px solid #4a4a4a; border-radius: 6px;
    background: transparent; color: #cbc7bc; font-weight: 600; cursor: pointer; font-size: 13px;
  }
  .pause:hover { background: #2a2a2a; }
`;

export class CaptureWidget {
  private host: HTMLDivElement | null = null;
  private root: ShadowRoot | null = null;
  private timer: number | null = null;
  private startedAt = 0;

  private paused = false;

  constructor(
    private readonly onFinish: () => void,
    private readonly onTogglePause?: (paused: boolean) => void,
  ) {}

  get mounted(): boolean {
    return this.host !== null;
  }

  mount(startedAt: number): void {
    if (this.host) return;
    this.startedAt = startedAt;
    this.paused = false;
    const host = document.createElement('div');
    host.id = HOST_ID;
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>${STYLE}</style>
      <div class="w">
        <div class="rec"><span class="blink"></span> <span data-rec>Recording — 00:00</span><span class="grip" title="Drag to move">⠿</span></div>
        <div class="live"><span>Console</span><b data-console>0 · 0 errors</b></div>
        <div class="live"><span>Network</span><b data-network>0 failed</b></div>
        <div class="live"><span>Steps</span><b data-steps>0 recorded</b></div>
        <div class="btns">
          <button class="pause" data-pause>Pause</button>
          <button class="finish" data-finish>Finish &amp; review →</button>
        </div>
      </div>`;
    root.querySelector('[data-finish]')?.addEventListener('click', () => {
      const btn = root.querySelector<HTMLButtonElement>('[data-finish]');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Packaging…';
      }
      this.onFinish();
    });
    root.querySelector('[data-pause]')?.addEventListener('click', () => this.togglePause());
    (document.body ?? document.documentElement).appendChild(host);
    this.host = host;
    this.root = root;
    const card = root.querySelector<HTMLElement>('.w');
    const handle = root.querySelector<HTMLElement>('.rec');
    if (card && handle) {
      this.installDrag(card, handle);
      void this.restorePosition(card);
    }
    this.tick();
    this.timer = window.setInterval(() => this.tickClock(), 1000);
  }

  // Drag by the header. Pointer capture keeps events flowing even when the
  // cursor passes over page iframes mid-drag. Switches from bottom/right anchor
  // to left/top on first move, and persists the final spot.
  private installDrag(card: HTMLElement, handle: HTMLElement): void {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      card.classList.add('dragging');
      const rect = card.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      startX = e.clientX;
      startY = e.clientY;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.place(card, originLeft + (e.clientX - startX), originTop + (e.clientY - startY));
    });

    const end = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      card.classList.remove('dragging');
      handle.releasePointerCapture(e.pointerId);
      const rect = card.getBoundingClientRect();
      void chrome.storage.local.set({ [POS_KEY]: { left: rect.left, top: rect.top } });
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // Position by left/top, clamped to stay fully on-screen, dropping the
  // bottom/right anchor.
  private place(card: HTMLElement, left: number, top: number): void {
    const rect = card.getBoundingClientRect();
    const maxLeft = Math.max(4, window.innerWidth - rect.width - 4);
    const maxTop = Math.max(4, window.innerHeight - rect.height - 4);
    card.style.left = `${Math.min(Math.max(4, left), maxLeft)}px`;
    card.style.top = `${Math.min(Math.max(4, top), maxTop)}px`;
    card.style.right = 'auto';
    card.style.bottom = 'auto';
  }

  private async restorePosition(card: HTMLElement): Promise<void> {
    const stored = (await chrome.storage.local.get(POS_KEY))[POS_KEY] as
      | { left: number; top: number }
      | undefined;
    if (stored && typeof stored.left === 'number' && typeof stored.top === 'number') {
      this.place(card, stored.left, stored.top);
    }
  }

  update(status: CaptureStatus): void {
    if (!this.root) return;
    const c = status.counts;
    this.set('[data-console]', `${c.console} · ${c.errors} errors`);
    this.set('[data-network]', `${c.failed} failed`);
    this.set('[data-steps]', `${c.steps} recorded`);
  }

  private tick(): void {
    this.tickClock();
  }

  private togglePause(): void {
    this.paused = !this.paused;
    const btn = this.root?.querySelector<HTMLButtonElement>('[data-pause]');
    if (btn) btn.textContent = this.paused ? 'Resume' : 'Pause';
    const blink = this.root?.querySelector<HTMLElement>('.blink');
    if (blink) blink.style.animationPlayState = this.paused ? 'paused' : 'running';
    this.onTogglePause?.(this.paused);
    this.tickClock();
  }

  private tickClock(): void {
    if (this.paused) {
      this.set('[data-rec]', 'Paused');
      return;
    }
    const secs = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    this.set('[data-rec]', `Recording — ${mm}:${ss}`);
  }

  private set(sel: string, text: string): void {
    const el = this.root?.querySelector(sel);
    if (el) el.textContent = text;
  }

  unmount(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.host?.remove();
    this.host = null;
    this.root = null;
  }
}
