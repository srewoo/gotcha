import type { ConsoleEntry, NetworkEntry, ReproStep, ReplayEvent } from '@shared/types';
import type { CaptureStatus } from '@shared/messaging';

// Bounded ring buffers. They live in the page/content context — NOT the
// service worker — so nothing is lost when the MV3 worker is evicted.
//
// Two eviction modes coexist:
//  - Count cap (always): never hold more than `max` items (memory ceiling).
//  - Age cap (opt-in, for always-on Instant Replay): drop items older than
//    `maxAgeMs` relative to the newest item, so the buffer is a rolling window
//    ("snapshots deleted every 2 minutes"). The replay ring additionally keeps
//    the newest seed frame before the cutoff so a slice is always renderable.
// Age eviction runs at most once per second of timeline advance: a full pass
// per push is O(n²) over an always-on session on the page's main thread, and
// the rolling window only needs coarse precision.
const EVICT_INTERVAL_MS = 1000;

class Ring<T> {
  private items: T[] = [];
  private maxAgeMs: number | null = null;
  private keepAnchor: ((item: T) => boolean) | null = null;
  // Newest-item timestamp at the last age-eviction pass (amortization).
  private lastEvictTs: number | null = null;
  // An optional permanently-retained head item (e.g. the replay's initial styled
  // snapshot), kept out of the rolling `items` so it is never evicted by count
  // or age. Surfaced at the front of all().
  private pinned: T | null = null;

  constructor(
    private readonly max: number,
    // Timestamp accessor — absolute `ts` for console/network/steps, relative
    // `t` for replay. Eviction is relative to the newest item either way.
    private readonly tsOf?: (item: T) => number,
  ) {}

  configureAge(maxAgeMs: number | null, keepAnchor?: (item: T) => boolean): void {
    this.maxAgeMs = maxAgeMs;
    this.keepAnchor = keepAnchor ?? null;
    this.lastEvictTs = null; // re-arm so the new window applies on the next push
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.max) this.items.shift();
    this.evictByAge();
  }

  private evictByAge(): void {
    if (this.maxAgeMs == null || !this.tsOf || this.items.length === 0) return;
    const tsOf = this.tsOf;
    const newest = tsOf(this.items[this.items.length - 1]!);
    // Amortize: skip the pass until the timeline has advanced ≥1s since the
    // last one — expired items may linger up to EVICT_INTERVAL_MS, which is
    // immaterial for a multi-second rolling window.
    if (this.lastEvictTs != null && newest - this.lastEvictTs < EVICT_INTERVAL_MS) return;
    this.lastEvictTs = newest;
    const cutoff = newest - this.maxAgeMs;

    // Items arrive in time order, so binary-search the first surviving index
    // and drop everything before it in a single splice (no full double-scan).
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tsOf(this.items[mid]!) >= cutoff) hi = mid;
      else lo = mid + 1;
    }
    if (lo === 0) return; // nothing expired

    // The newest pre-cutoff item matching keepAnchor (e.g. a snapshot) is the
    // seed for a renderable slice — retain it even though it's "expired".
    let anchor: T | null = null;
    if (this.keepAnchor) {
      for (let i = lo - 1; i >= 0; i--) {
        const it = this.items[i]!;
        if (this.keepAnchor(it)) {
          anchor = it;
          break;
        }
      }
    }

    this.items.splice(0, lo);
    if (anchor) this.items.unshift(anchor);
  }

  // Permanently retain `item` as the head, never evicted. Held separately from
  // `items` so it survives count/age eviction.
  pin(item: T): void {
    this.pinned = item;
  }

  all(): readonly T[] {
    if (!this.pinned) return this.items;
    // Dedup defensively in case the pinned item was also pushed into items.
    return [this.pinned, ...this.items.filter((it) => it !== this.pinned)];
  }
  clear(): void {
    this.items = [];
    this.pinned = null;
    this.lastEvictTs = null;
  }
}

export class BufferStore {
  // Sized for busy enterprise SPAs: a chatty page can emit hundreds of console
  // lines / requests on load, and the entries the bug report exists to capture
  // (the error, the failed request) must not be evicted before the user finishes.
  readonly console = new Ring<ConsoleEntry>(2000, (e) => e.ts);
  readonly network = new Ring<NetworkEntry>(1000, (e) => e.ts);
  readonly steps = new Ring<ReproStep>(400, (e) => e.ts);
  // Replay events are higher-frequency (mutations/scroll), so a larger ring.
  readonly replay = new Ring<ReplayEvent>(5000, (e) => e.t);
  recording = false;
  startedAt: number | null = null;
  // Wall-clock time the replay recorder's relative timeline (`event.t`) started.
  // Estimated from the first replay event so we can map a wall-clock window onto
  // the relative timeline in sliceWindow(). Null until the first replay event.
  replayEpoch: number | null = null;
  // Timestamp of the pinned initial snapshot, so the readable→enriched re-emit
  // at the same t updates the pin (richest wins) but later keyframes don't.
  private pinnedReplayT: number | null = null;

  // Turn on rolling age-based retention on every ring (always-on Instant Replay).
  // Idempotent; safe to call after reset().
  enableRetention(maxAgeMs: number): void {
    this.console.configureAge(maxAgeMs);
    this.network.configureAge(maxAgeMs);
    this.steps.configureAge(maxAgeMs);
    // Keep the newest snapshot before the cutoff as a seed frame.
    this.replay.configureAge(maxAgeMs, (e) => e.kind === 'snapshot');
  }

  // Push a replay event, learning the recorder's epoch from the first one.
  //
  // The initial snapshot (and its same-t enriched re-emit) is PINNED rather than
  // pushed into the ring, so it is never evicted in a long session/always-on run.
  // That guarantees the player always has a styled, full-document seed at the
  // front — without it, once the ring rolled past the only snapshot, the replay
  // went unstyled and lost its seed. Later keyframes (t > initial) ring normally.
  pushReplay(event: ReplayEvent): void {
    if (this.replayEpoch == null) this.replayEpoch = Date.now() - event.t;
    if (
      event.kind === 'snapshot' &&
      (this.pinnedReplayT === null || event.t === this.pinnedReplayT)
    ) {
      this.pinnedReplayT = event.t;
      this.replay.pin(event); // richest snapshot at the initial t wins
      return; // do not also ring it (avoids a duplicate at the front)
    }
    this.replay.push(event);
  }

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
    this.replayEpoch = null;
    this.pinnedReplayT = null;
  }

  // Build a detached BufferStore holding only the trailing `windowMs` of data,
  // with the replay timeline re-based to start at 0 so the review player works
  // unchanged. Used by "Share last minute" and retroactive Instant Replay finish.
  //
  // Replay is seeded from the newest *snapshot* keyframe at/before the window
  // start (for inlined CSS + a full document), then every event from that
  // keyframe onward is included and re-based against the keyframe. The slice may
  // therefore include up to one keyframe interval of styled lead-in — a faithful,
  // renderable replay matters more than a byte-exact 60s boundary.
  sliceWindow(windowMs: number): BufferStore {
    const now = Date.now();
    const cutoff = now - windowMs;
    const out = new BufferStore();

    for (const e of this.console.all()) if (e.ts >= cutoff) out.console.push(e);
    for (const e of this.network.all()) if (e.ts >= cutoff) out.network.push(e);
    for (const e of this.steps.all()) if (e.ts >= cutoff) out.steps.push(e);

    if (this.replayEpoch != null) {
      const startRel = now - this.replayEpoch - windowMs;
      const evs = this.replay.all();

      // Newest snapshot keyframe at/before the window start (the styled seed).
      let seedIdx = -1;
      for (let i = 0; i < evs.length; i++) {
        if (evs[i]!.kind === 'snapshot' && evs[i]!.t <= startRel) seedIdx = i;
      }
      // No keyframe before the window — fall back to the earliest snapshot we have.
      if (seedIdx === -1) seedIdx = evs.findIndex((e) => e.kind === 'snapshot');

      if (seedIdx >= 0) {
        const base = evs[seedIdx]!.t;
        for (let i = seedIdx; i < evs.length; i++) {
          out.replay.push({ ...evs[i]!, t: Math.max(0, evs[i]!.t - base) });
        }
      }
    }

    return out;
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
