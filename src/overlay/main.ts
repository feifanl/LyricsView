// Overlay bootstrap. Milestone 5: fetch real lyrics on track change and show
// the current line, driven by the interpolated clock. The full karaoke renderer
// (word fill, context lines) arrives in M6.
import { loadSettings } from "../shared/store";
import { cmd, onPlaybackState, onTimeline, onTrackChanged } from "../shared/ipc";
import type { LyricsDoc, TrackInfo } from "../shared/types";
import { applyPresetVars } from "./apply";
import { PlaybackClock } from "./clock";

const lyricsEl = document.getElementById("lyrics") as HTMLDivElement;
const statusEl = document.getElementById("status-chip") as HTMLDivElement;

const clock = new PlaybackClock();
let track: TrackInfo | null = null;
let doc: LyricsDoc | null = null;

const lineEl = document.createElement("div");
lineEl.className = "lyric-line";
const debugEl = document.createElement("div");
debugEl.className = "lyric-line context";
lyricsEl.append(lineEl, debugEl);

/** Index of the active line at position `pos` (ms), or -1. */
function currentLineIndex(pos: number): number {
  if (!doc || doc.lines.length === 0) return -1;
  let lo = 0;
  let hi = doc.lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (doc.lines[mid]!.start <= pos) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function frame(): void {
  const pos = clock.estimate(Date.now());
  if (doc && doc.lines.length > 0) {
    const idx = currentLineIndex(pos);
    lineEl.textContent = idx >= 0 ? doc.lines[idx]!.text : "♪";
  } else if (doc?.plain) {
    lineEl.textContent = track ? `${track.title} — ${track.artist}` : "";
  } else {
    lineEl.textContent = track ? `${track.title} — ${track.artist}` : "♪ Lyricify-OSS";
  }
  debugEl.textContent = track
    ? `${clock.isPlaying() ? "▶" : "⏸"} ${(pos / 1000).toFixed(1)}s · ${doc ? doc.source : "…"}${doc?.hasWordTiming ? " (word)" : ""}`
    : "";
  requestAnimationFrame(frame);
}

async function loadLyrics(t: TrackInfo): Promise<void> {
  doc = null;
  setStatus("searching lyrics…");
  try {
    doc = await cmd.fetchLyrics(t, false);
    setStatus(doc ? null : "♪ no lyrics");
  } catch (e) {
    console.error("[overlay] fetch_lyrics failed", e);
    setStatus("lyrics error");
  }
}

function setStatus(text: string | null): void {
  if (text === null) {
    statusEl.hidden = true;
  } else {
    statusEl.textContent = text;
    statusEl.hidden = false;
  }
}

async function boot(): Promise<void> {
  const settings = await loadSettings();
  clock.setUserOffset(settings.globalOffsetMs);
  applyPresetVars(settings);

  await onTrackChanged((t) => {
    track = t;
    void loadLyrics(t);
  });
  await onPlaybackState((p) => clock.setPlaying(p.playing, Date.now()));
  await onTimeline((t) => clock.update(t, Date.now()));

  setStatus("waiting for a player…");
  requestAnimationFrame(frame);
}

void boot();
