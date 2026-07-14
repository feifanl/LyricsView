// Lightweight control HUD: media transport (via SMTC), overlay toggle/edit,
// sync nudge + line jump + reload, and a live preset switcher. A compact
// companion to the full Settings window.
import {
  cmd,
  emitOverlayHotkey,
  emitReloadLyrics,
  emitSettingsChanged,
  onPlaybackState,
  onTrackChanged,
} from "../shared/ipc";
import { loadSettings, saveSettings } from "../shared/store";
import type { Settings } from "../shared/settings";
import type { TrackInfo } from "../shared/types";

const root = document.getElementById("control-root") as HTMLElement;

let settings: Settings | null = null;
let playing = false;

function btn(label: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function section(title: string): HTMLElement {
  const h = document.createElement("div");
  h.className = "sec";
  h.textContent = title;
  return h;
}

let titleEl: HTMLElement;
let playBtn: HTMLButtonElement;

function render(): void {
  root.replaceChildren();

  // Now-playing header.
  const header = document.createElement("div");
  header.className = "now";
  titleEl = document.createElement("div");
  titleEl.className = "now-title";
  titleEl.textContent = "No track";
  header.append(titleEl);
  root.append(header);

  // Media transport.
  root.append(section("Playback"));
  const media = document.createElement("div");
  media.className = "row";
  playBtn = btn("⏯", () => void cmd.mediaControl("toggle"), "big");
  media.append(
    btn("⏮", () => void cmd.mediaControl("prev"), "big"),
    playBtn,
    btn("⏭", () => void cmd.mediaControl("next"), "big"),
  );
  root.append(media);

  // Overlay.
  root.append(section("Overlay"));
  const ov = document.createElement("div");
  ov.className = "row";
  ov.append(
    btn("Show / Hide", () => void cmd.toggleOverlay()),
    btn("Edit position", () => void cmd.setEditMode(true)),
  );
  root.append(ov);

  // Sync.
  root.append(section("Sync"));
  const sync = document.createElement("div");
  sync.className = "row";
  sync.append(
    btn("offset −100", () => void emitOverlayHotkey("offsetMinus")),
    btn("offset +100", () => void emitOverlayHotkey("offsetPlus")),
  );
  const sync2 = document.createElement("div");
  sync2.className = "row";
  sync2.append(
    btn("← line", () => void emitOverlayHotkey("prevLine")),
    btn("line →", () => void emitOverlayHotkey("nextLine")),
    btn("reload", () => void emitReloadLyrics()),
  );
  root.append(sync, sync2);

  // Preset switcher.
  root.append(section("Preset"));
  const sel = document.createElement("select");
  if (settings) {
    for (const name of Object.keys(settings.presets)) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      opt.selected = name === settings.activePreset;
      sel.append(opt);
    }
  }
  sel.addEventListener("change", () => void switchPreset(sel.value));
  root.append(sel);

  const footer = document.createElement("div");
  footer.className = "row footer";
  footer.append(btn("Full settings…", () => void cmd.openSettings()));
  root.append(footer);

  updateNow();
}

async function switchPreset(name: string): Promise<void> {
  if (!settings) return;
  settings = { ...settings, activePreset: name };
  await saveSettings(settings);
  await emitSettingsChanged(settings);
}


function updateNow(track?: TrackInfo | null): void {
  if (track) titleEl.textContent = `${track.title} — ${track.artist}`;
  if (playBtn) playBtn.textContent = playing ? "⏸" : "▶";
}

async function boot(): Promise<void> {
  settings = await loadSettings();
  document.documentElement.dataset.theme = "dark";
  render();

  await onTrackChanged((t) => updateNow(t));
  await onPlaybackState((p) => {
    playing = p.playing;
    updateNow();
  });
}

void boot();
