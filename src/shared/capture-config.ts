// Shared capture/replay timing constants. Used by the always-on "Instant Replay"
// recorder, the rolling retention buffers, and the "Share last minute" slice.

// Rolling local retention for always-on capture ("snapshots deleted every 2 min").
export const RETENTION_MS = 120_000;

// The trailing window shared by the "Share last minute" action.
export const SHARE_WINDOW_MS = 60_000;

// How often the always-on recorder emits a full (CSS-inlined) keyframe snapshot,
// so any trailing slice has a recent, seedable, *styled* frame to start from.
// Must be < SHARE_WINDOW_MS so a one-minute slice always contains a keyframe.
export const KEYFRAME_INTERVAL_MS = 30_000;

// Boolean setting keys persisted in chrome.storage.local. captureUserEvents
// defaults ON (preserves existing repro-step recording); the other two default
// OFF (privacy/perf — they turn on always-on visual recording).
export const CAPTURE_SETTING_KEYS = ['instantReplay', 'shareLastMinute', 'captureUserEvents'] as const;
export type CaptureSettingKey = (typeof CAPTURE_SETTING_KEYS)[number];

// Stored-report limits. Reports are heavy (screenshot/DOM/replay) and held in a
// local IndexedDB, so the list is capped: at MAX_REPORTS the oldest is
// auto-evicted on save; at WARN_REPORTS the UI nudges the user to clear space
// before that happens (loading many reports also costs memory/time).
export const MAX_REPORTS = 100;
export const WARN_REPORTS = 80;
