// Overlay bootstrap. Milestone 6: the karaoke Renderer drives line/word DOM and
// progressive fill from the interpolated clock.
import { activePreset, type Settings } from "../shared/settings";
import { loadSettings } from "../shared/store";
import { cmd, onPlaybackState, onTimeline, onTrackChanged } from "../shared/ipc";
import type { LyricsDoc, TrackInfo } from "../shared/types";
import { applyPresetVars } from "./apply";
import { PlaybackClock } from "./clock";
import { Renderer } from "./renderer";

const lyricsEl = document.getElementById("lyrics") as HTMLDivElement;
const statusEl = document.getElementById("status-chip") as HTMLDivElement;

const clock = new PlaybackClock();
const renderer = new Renderer(lyricsEl);
let hasDoc = false;

function applyLayout(settings: Settings): void {
  const p = activePreset(settings);
  renderer.setLayout({
    before: p.contextLines.before,
    after: p.contextLines.after,
    animation: p.animation,
  });
}

function frame(): void {
  if (hasDoc) renderer.render(clock.estimate(Date.now()));
  requestAnimationFrame(frame);
}

async function loadLyrics(t: TrackInfo): Promise<void> {
  hasDoc = false;
  renderer.setDoc(null);
  setStatus("searching lyrics…");
  try {
    const doc: LyricsDoc | null = await cmd.fetchLyrics(t, false);
    if (doc && (doc.lines.length > 0 || doc.plain)) {
      renderer.setDoc(doc);
      hasDoc = true;
      setStatus(null);
    } else {
      setStatus("♪ no lyrics");
    }
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
  applyLayout(settings);

  await onTrackChanged((t) => void loadLyrics(t));
  await onPlaybackState((p) => clock.setPlaying(p.playing, Date.now()));
  await onTimeline((t) => clock.update(t, Date.now()));

  setStatus("waiting for a player…");
  requestAnimationFrame(frame);
}

void boot();
