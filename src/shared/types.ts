// Shared type contract mirroring the Rust models. Keep in sync with
// src-tauri/src/providers/mod.rs and commands.rs.

export type SourceId =
  | "lrclib"
  | "musixmatch"
  | "netease"
  | "applemusic"
  | "manual";

export interface TrackInfo {
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  sourceAppId: string;
}

export interface SearchCandidate {
  source: SourceId;
  id: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number | null;
  hasWordTiming: boolean | null;
}

export interface SessionInfo {
  appId: string;
  isCurrent: boolean;
}

export interface LyricWord {
  start: number;
  end: number;
  text: string;
}

export interface LyricLine {
  start: number;
  end: number;
  text: string;
  words?: LyricWord[];
  /** Optional bundled translation (e.g. NetEase tlyric), populated by Rust. */
  translation?: string;
}

export interface LyricsDoc {
  source: SourceId;
  trackKey: string;
  lines: LyricLine[];
  plain?: string;
  hasWordTiming: boolean;
  /** Duration of the release this timeline was timed against, when the provider
   *  reports one. Drives automatic drift correction (see overlay/drift.ts). */
  sourceDurationMs?: number;
}

export interface TrackMeta {
  preferredSource?: SourceId;
  offsetMs: number;
  /** Manual per-track drift correction, parts-per-million of position (0 =
   *  none). Added on top of any automatic correction. */
  stretchPpm: number;
}

export interface CacheInfo {
  entries: number;
  bytes: number;
}

// Event payloads (Rust -> frontend).
export interface TimelinePayload {
  positionMs: number;
  reportedAtMs: number;
  rate: number;
}

export interface PlaybackStatePayload {
  playing: boolean;
}

export interface ToastPayload {
  text: string;
}
