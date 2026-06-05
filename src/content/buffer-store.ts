import type { ConsoleEntry, NetworkEntry, ReproStep, ReplayEvent } from '@shared/types';
import type { CaptureStatus } from '@shared/messaging';

// Bounded ring buffers. They live in the page/content context — NOT the
// service worker — so nothing is lost when the MV3 worker is evicted.
class Ring<T> {
  private readonly items: T[] = [];
  constructor(private readonly max: number) {}
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.max) this.items.shift();
  }
  all(): readonly T[] {
    return this.items;
  }
  clear(): void {
    this.items.length = 0;
  }
}

export class BufferStore {
  readonly console = new Ring<ConsoleEntry>(500);
  readonly network = new Ring<NetworkEntry>(300);
  readonly steps = new Ring<ReproStep>(200);
  // Replay events are higher-frequency (mutations/scroll), so a larger ring.
  readonly replay = new Ring<ReplayEvent>(3000);
  recording = false;
  startedAt: number | null = null;

  start(): void {
    this.recording = true;
    this.startedAt = Date.now();
  }

  stop(): void {
    this.recording = false;
  }

  reset(): void {
    this.console.clear();
    this.network.clear();
    this.steps.clear();
    this.replay.clear();
    this.recording = false;
    this.startedAt = null;
  }

  status(): CaptureStatus {
    const console = this.console.all();
    const network = this.network.all();
    return {
      recording: this.recording,
      startedAt: this.startedAt,
      counts: {
        console: console.length,
        errors: console.filter((c) => c.level === 'error').length,
        network: network.length,
        failed: network.filter((n) => n.failed).length,
        steps: this.steps.all().length,
      },
    };
  }
}
