// Overlay bootstrap. Milestone 3: drive an on-screen debug readout from the
// interpolated PlaybackClock (rAF loop). The karaoke renderer (M6) replaces the
// raw text view later.
import { loadSettings } from "../shared/store";
import { onPlaybackState, onTimeline, onTrackChanged } from "../shared/ipc";
import type { TrackInfo } from "../shared/types";
import { applyPresetVars } from "./apply";
import { PlaybackClock } from "./clock";

const lyricsEl = document.getElementById("lyrics") as HTMLDivElement;
const statusEl = document.getElementById("status-chip") as HTMLDivElement;

const clock = new PlaybackClock();
let track: TrackInfo | null = null;

let titleEl: HTMLDivElement | null = null;
let debugEl: HTMLDivElement | null = null;

function buildDom(): void {
  lyricsEl.innerHTML = "";
  titleEl = document.createElement("div");
  titleEl.className = "lyric-line";
  lyricsEl.appendChild(titleEl);
  debugEl = document.createElement("div");
  debugEl.className = "lyric-line context";
  lyricsEl.appendChild(debugEl);
}

function frame(): void {
  if (titleEl) {
    titleEl.textContent = track ? `${track.title} — ${track.artist}` : "♪ Lyricify-OSS";
  }
  if (debugEl && track) {
    const est = clock.estimate(Date.now());
    const pos = (est / 1000).toFixed(2);
    const dur = (track.durationMs / 1000).toFixed(0);
    debugEl.textContent = `${clock.isPlaying() ? "▶" : "⏸"} est ${pos}s / ${dur}s · off ${clock.getUserOffset()}ms`;
  } else if (debugEl) {
    debugEl.textContent = "";
  }
  requestAnimationFrame(frame);
}

async function boot(): Promise<void> {
  const settings = await loadSettings();
  clock.setUserOffset(settings.globalOffsetMs);
  applyPresetVars(settings);
  buildDom();

  await onTrackChanged((t) => {
    track = t;
    statusEl.hidden = true;
  });
  await onPlaybackState((p) => clock.setPlaying(p.playing, Date.now()));
  await onTimeline((t) => clock.update(t, Date.now()));

  statusEl.textContent = "waiting for a player…";
  statusEl.hidden = false;
  requestAnimationFrame(frame);
}

void boot();
