// Canvas screenshot annotator (MVP feature 2): box, arrow, blur, and numbered
// comment pins. Composites annotations over the captured screenshot and exports
// a flattened PNG. Kept dependency-free — just 2D canvas, plus a single floating
// <input> for typing a pin's comment.

export type Tool = 'box' | 'arrow' | 'blur' | 'pin';

interface Shape {
  tool: Tool;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  // Pin-only: 1-based marker number and its (optional) comment text.
  n?: number;
  note?: string;
}

const RED = '#e0483d';

export class Annotator {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly base = new Image();
  private readonly shapes: Shape[] = [];
  private draft: Shape | null = null;
  private tool: Tool = 'box';
  private scale = 1;
  private ready = false;
  private pinCount = 0;
  // The floating comment editor for the pin currently being labelled.
  private editor: HTMLInputElement | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    dataUrl: string,
    private readonly maxWidth: number,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.base.onload = () => this.onImageLoad();
    this.base.src = dataUrl;
    this.bindPointer();
  }

  setTool(tool: Tool): void {
    this.tool = tool;
  }

  // Number of comment pins placed (for the review UI's caption / counts).
  get pinCount_(): number {
    return this.pinCount;
  }

  // All pin comments in placement order, e.g. ["1. Wrong total", "2. ..."].
  comments(): string[] {
    return this.shapes
      .filter((s) => s.tool === 'pin')
      .map((s) => `${s.n}. ${s.note?.trim() || '(no comment)'}`);
  }

  get dirty(): boolean {
    return this.shapes.length > 0;
  }

  undo(): void {
    const removed = this.shapes.pop();
    if (removed?.tool === 'pin' && this.pinCount > 0) this.pinCount--;
    this.redraw();
  }

  // Flattened PNG at native screenshot resolution.
  export(): string {
    return this.canvas.toDataURL('image/png');
  }

  private onImageLoad(): void {
    this.canvas.width = this.base.naturalWidth;
    this.canvas.height = this.base.naturalHeight;
    // CSS scales the canvas down to fit; pointer coords are mapped back up.
    this.scale = Math.min(1, this.maxWidth / this.base.naturalWidth);
    this.canvas.style.width = `${this.base.naturalWidth * this.scale}px`;
    this.ready = true;
    this.redraw();
  }

  private toCanvas(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * this.canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * this.canvas.height,
    };
  }

  private bindPointer(): void {
    let drawing = false;
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.ready) return;
      // A comment pin is a single click, not a drag: place it and open the
      // inline comment editor right away.
      if (this.tool === 'pin') {
        const p = this.toCanvas(e);
        this.placePin(p.x, p.y, e);
        return;
      }
      drawing = true;
      const p = this.toCanvas(e);
      this.draft = { tool: this.tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!drawing || !this.draft) return;
      const p = this.toCanvas(e);
      this.draft.x2 = p.x;
      this.draft.y2 = p.y;
      this.redraw();
    });
    const finish = (): void => {
      if (this.draft) {
        const { x1, y1, x2, y2 } = this.draft;
        if (Math.abs(x2 - x1) > 4 || Math.abs(y2 - y1) > 4) this.shapes.push(this.draft);
        this.draft = null;
      }
      drawing = false;
      this.redraw();
    };
    this.canvas.addEventListener('pointerup', finish);
    this.canvas.addEventListener('pointercancel', finish);
  }

  // Drop a numbered pin and float a text input next to it for the comment. The
  // comment is stored on the shape and flattened into the exported PNG, so it
  // rides along with the screenshot when the report is filed — no extra plumbing.
  private placePin(x: number, y: number, e: PointerEvent): void {
    const shape: Shape = { tool: 'pin', x1: x, y1: y, x2: x, y2: y, n: ++this.pinCount, note: '' };
    this.shapes.push(shape);
    this.redraw();
    this.openEditor(shape, e.clientX, e.clientY);
  }

  private openEditor(shape: Shape, clientX: number, clientY: number): void {
    this.closeEditor();
    const host = this.canvas.parentElement;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    const input = document.createElement('input');
    input.className = 'anno-comment-input';
    input.placeholder = `Comment for pin ${shape.n}…`;
    input.value = shape.note ?? '';
    input.style.position = 'absolute';
    input.style.left = `${clientX - hostRect.left + 10}px`;
    input.style.top = `${clientY - hostRect.top + 10}px`;
    const commit = (): void => {
      shape.note = input.value;
      this.closeEditor();
      this.redraw();
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        commit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this.closeEditor();
        this.redraw();
      }
    });
    input.addEventListener('blur', commit);
    host.appendChild(input);
    this.editor = input;
    input.focus();
  }

  private closeEditor(): void {
    if (this.editor) {
      this.editor.remove();
      this.editor = null;
    }
  }

  private redraw(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.base, 0, 0);
    for (const s of this.shapes) this.drawShape(s);
    if (this.draft) this.drawShape(this.draft);
  }

  private drawShape(s: Shape): void {
    switch (s.tool) {
      case 'box':
        return this.drawBox(s);
      case 'arrow':
        return this.drawArrow(s);
      case 'blur':
        return this.drawBlur(s);
      case 'pin':
        return this.drawPin(s);
    }
  }

  // A numbered red marker; when a comment exists, a label bubble to its right.
  // Sizes scale with the screenshot resolution so pins read at any DPR.
  private drawPin(s: Shape): void {
    const ctx = this.ctx;
    const r = Math.max(11, this.canvas.width / 90);
    const font = Math.round(r * 1.1);
    // Marker disc.
    ctx.beginPath();
    ctx.fillStyle = RED;
    ctx.arc(s.x1, s.y1, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, r / 7);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    // Number.
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${font}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(s.n ?? ''), s.x1, s.y1 + 1);
    // Comment bubble.
    const note = s.note?.trim();
    if (note) {
      const padX = r * 0.7;
      const labelFont = Math.round(r * 1.05);
      ctx.font = `600 ${labelFont}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = 'left';
      const textW = Math.min(ctx.measureText(note).width, this.canvas.width * 0.5);
      const bx = s.x1 + r + 6;
      const by = s.y1 - r;
      const bw = textW + padX * 2;
      const bh = r * 2;
      ctx.fillStyle = 'rgba(20,18,16,0.92)';
      ctx.beginPath();
      const rad = r * 0.4;
      ctx.roundRect(bx, by, bw, bh, rad);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(note, bx + padX, by + bh / 2 + 1, textW);
    }
    // Reset alignment so other shapes draw predictably.
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  private drawBox(s: Shape): void {
    const ctx = this.ctx;
    ctx.lineWidth = Math.max(2, this.canvas.width / 400);
    ctx.strokeStyle = RED;
    ctx.strokeRect(s.x1, s.y1, s.x2 - s.x1, s.y2 - s.y1);
  }

  private drawArrow(s: Shape): void {
    const ctx = this.ctx;
    const head = Math.max(10, this.canvas.width / 80);
    const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
    ctx.strokeStyle = RED;
    ctx.fillStyle = RED;
    ctx.lineWidth = Math.max(2, this.canvas.width / 350);
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.x2, s.y2);
    ctx.lineTo(s.x2 - head * Math.cos(angle - Math.PI / 6), s.y2 - head * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(s.x2 - head * Math.cos(angle + Math.PI / 6), s.y2 - head * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }

  private drawBlur(s: Shape): void {
    const ctx = this.ctx;
    const x = Math.min(s.x1, s.x2);
    const y = Math.min(s.y1, s.y2);
    const w = Math.abs(s.x2 - s.x1);
    const h = Math.abs(s.y2 - s.y1);
    if (w < 1 || h < 1) return;
    // Pixelate by downscaling the region through a tiny offscreen canvas and
    // scaling it back up — a redaction-grade blur that can't be un-blurred.
    const tmp = document.createElement('canvas');
    const tctx = tmp.getContext('2d');
    if (!tctx) return;
    // Reduce the region to at most MAX_CELLS averaged blocks across its shorter
    // side, with each block ≥ MIN_BLOCK source px. WHY: the old factor floored to
    // 1 for regions under 8px, so a small redaction (e.g. a one-line value) got
    // NO pixelation and stayed readable — defeating the tool. Tiny regions now
    // collapse to a single solid block; large ones still pixelate to ~8 blocks.
    const MIN_BLOCK = 6;
    const MAX_CELLS = 8;
    const shortSide = Math.min(w, h);
    const cells = Math.max(1, Math.min(MAX_CELLS, Math.floor(shortSide / MIN_BLOCK)));
    const scale = cells / shortSide;
    tmp.width = Math.max(1, Math.round(w * scale));
    tmp.height = Math.max(1, Math.round(h * scale));
    tctx.drawImage(this.canvas, x, y, w, h, 0, 0, tmp.width, tmp.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h);
    ctx.imageSmoothingEnabled = true;
  }
}
