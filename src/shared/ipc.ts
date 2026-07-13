import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  CacheInfo,
  LyricsDoc,
  PlaybackStatePayload,
  SearchCandidate,
  SessionInfo,
  SourceId,
  TimelinePayload,
  ToastPayload,
  TrackInfo,
  TrackMeta,
} from "./types";
import type { HotkeyAction, Settings } from "./settings";

// ---- Commands (typed wrappers over Tauri invoke) ----

export const cmd = {
  fetchLyrics(track: TrackInfo, force: boolean): Promise<LyricsDoc | null> {
    return invoke("fetch_lyrics", { track, force });
  },
  searchProvider(provider: SourceId, query: string): Promise<SearchCandidate[]> {
    return invoke("search_provider", { provider, query });
  },
  fetchCandidate(candidate: SearchCandidate): Promise<LyricsDoc | null> {
    return invoke("fetch_candidate", { candidate });
  },
  saveManualLyrics(trackKey: string, lrcText: string): Promise<LyricsDoc> {
    return invoke("save_manual_lyrics", { trackKey, lrcText });
  },
  setPreferredSource(trackKey: string, source: SourceId): Promise<void> {
    return invoke("set_preferred_source", { trackKey, source });
  },
  setTrackOffset(trackKey: string, offsetMs: number): Promise<void> {
    return invoke("set_track_offset", { trackKey, offsetMs });
  },
  getTrackMeta(trackKey: string): Promise<TrackMeta> {
    return invoke("get_track_meta", { trackKey });
  },
  translateLines(lines: string[]): Promise<string[]> {
    return invoke("translate_lines", { lines });
  },
  listSmtcSessions(): Promise<SessionInfo[]> {
    return invoke("list_smtc_sessions");
  },
  setPinnedSession(appId: string | null): Promise<void> {
    return invoke("set_pinned_session", { appId });
  },
  setClickThrough(enabled: boolean): Promise<void> {
    return invoke("set_click_through", { enabled });
  },
  getCacheInfo(): Promise<CacheInfo> {
    return invoke("get_cache_info");
  },
  clearCache(): Promise<void> {
    return invoke("clear_cache");
  },
  exportLrc(trackKey: string): Promise<boolean> {
    return invoke("export_lrc", { trackKey });
  },
  currentTrack(): Promise<TrackInfo | null> {
    return invoke("current_track");
  },
  shareLineImage(png: number[]): Promise<void> {
    return invoke("share_line_image", { png });
  },
  applyHotkeys(): Promise<void> {
    return invoke("apply_hotkeys");
  },
  applyCandidate(trackKey: string, candidate: SearchCandidate): Promise<LyricsDoc | null> {
    return invoke("apply_candidate", { trackKey, candidate });
  },
  // Window/overlay helpers implemented in Rust.
  setEditMode(enabled: boolean): Promise<void> {
    return invoke("set_edit_mode", { enabled });
  },
  currentTrackKey(): Promise<string | null> {
    return invoke("current_track_key");
  },
};

// ---- Events ----

export const EVT = {
  trackChanged: "smtc://track-changed",
  playbackState: "smtc://playback-state",
  timeline: "smtc://timeline",
  settingsChanged: "settings://changed",
  toast: "overlay://toast",
  hotkey: "overlay://hotkey",
  reloadLyrics: "overlay://reload-lyrics",
} as const;

export function onTrackChanged(cb: (t: TrackInfo) => void): Promise<UnlistenFn> {
  return listen<TrackInfo>(EVT.trackChanged, (e) => cb(e.payload));
}
export function onPlaybackState(
  cb: (p: PlaybackStatePayload) => void,
): Promise<UnlistenFn> {
  return listen<PlaybackStatePayload>(EVT.playbackState, (e) => cb(e.payload));
}
export function onTimeline(cb: (t: TimelinePayload) => void): Promise<UnlistenFn> {
  return listen<TimelinePayload>(EVT.timeline, (e) => cb(e.payload));
}
export function onSettingsChanged(cb: (s: Settings) => void): Promise<UnlistenFn> {
  return listen<Settings>(EVT.settingsChanged, (e) => cb(e.payload));
}
export function onToast(cb: (t: ToastPayload) => void): Promise<UnlistenFn> {
  return listen<ToastPayload>(EVT.toast, (e) => cb(e.payload));
}
export function onHotkey(cb: (action: HotkeyAction) => void): Promise<UnlistenFn> {
  return listen<{ action: HotkeyAction }>(EVT.hotkey, (e) => cb(e.payload.action));
}

export function onReloadLyrics(cb: () => void): Promise<UnlistenFn> {
  return listen(EVT.reloadLyrics, () => cb());
}

/** Broadcast updated settings to all windows (settings window -> overlay). */
export function emitSettingsChanged(settings: Settings): Promise<void> {
  return emit(EVT.settingsChanged, settings);
}
