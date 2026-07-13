// Overlay bootstrap. Milestone 1: prove transparency + always-on-top by
// rendering placeholder text. Event wiring and the karaoke renderer are added
// in later milestones.
import { loadSettings } from "../shared/store";
import { applyPresetVars } from "./apply";

const lyricsEl = document.getElementById("lyrics") as HTMLDivElement;

function renderPlaceholder(): void {
  lyricsEl.innerHTML = "";
  const line = document.createElement("div");
  line.className = "lyric-line";
  line.textContent = "♪ Lyricify-OSS";
  lyricsEl.appendChild(line);
}

async function boot(): Promise<void> {
  const settings = await loadSettings();
  applyPresetVars(settings);
  renderPlaceholder();
}

void boot();
