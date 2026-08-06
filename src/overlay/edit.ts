// Edit-mode chrome: whole-surface drag, edge/corner resize, and geometry
// persistence on exit. Locked vs edit is a hard toggle (click-through and
// drag/resize are mutually exclusive) driven by Rust via the edit-mode event.
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cmd } from "../shared/ipc";
import { pauseAutoWidth } from "./autowidth";
import { activePreset } from "../shared/settings";
import { loadSettings, saveSettings } from "../shared/store";
import { captureGeometry } from "./geometry";

type ResizeDir = Parameters<ReturnType<typeof getCurrentWindow>["startResizeDragging"]>[0];

export function initEditMode(): void {
  const chrome = document.getElementById("edit-chrome") as HTMLElement;
  const doneBtn = document.getElementById("edit-done") as HTMLButtonElement;
  const root = document.getElementById("overlay-root") as HTMLElement;
  const win = getCurrentWindow();
  let editing = false;

  void listen<{ enabled: boolean }>("overlay://edit-mode", (e) => void setEdit(e.payload.enabled));

  root.addEventListener("pointerdown", (ev) => {
    if (!editing) return;
    const target = ev.target as HTMLElement;
    if (target.closest(".edit-done") || target.closest(".grip")) return;
    void win.startDragging();
  });

  chrome.querySelectorAll<HTMLElement>(".grip").forEach((grip) => {
    grip.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void win.startResizeDragging(grip.dataset.dir as ResizeDir);
    });
  });

  doneBtn.addEventListener("click", () => void cmd.setEditMode(false));

  // Persist as the window actually moves, not only when edit mode is dismissed.
  // Saving on exit alone meant a drag survived exactly one way out: switching
  // preset from the settings window, or quitting while still in edit mode, threw
  // the new position away and the overlay went back to where it had been. The
  // timer coalesces the flood of events a single drag produces into one write.
  const PERSIST_DEBOUNCE_MS = 400;
  let persistTimer = 0;
  function schedulePersist(): void {
    if (!editing) return; // ignore programmatic moves (dock, preset restore)
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => void persistGeometry(), PERSIST_DEBOUNCE_MS);
  }
  void win.onMoved(schedulePersist);
  void win.onResized(schedulePersist);

  async function setEdit(on: boolean): Promise<void> {
    editing = on;
    chrome.hidden = !on;
    root.classList.toggle("editing", on);
    // Hands the preset width back before the user drags, so the size they see
    // (and the one persisted below) isn't an auto-widened one.
    await pauseAutoWidth(on);
    if (!on) {
      // Drop any pending debounce: it would land after `editing` went false and
      // write the same geometry a second time, or worse, after a preset switch
      // had already moved the window.
      window.clearTimeout(persistTimer);
      await persistGeometry();
    }
  }

  async function persistGeometry(): Promise<void> {
    try {
      const geo = await captureGeometry();
      const settings = await loadSettings();
      const preset = activePreset(settings);
      // Docked bars derive their geometry from the monitor edge; persisting a
      // drag would corrupt the saved bar height/width.
      if ((preset.dock ?? "float") !== "float") return;
      preset.monitor = geo.monitor;
      preset.position = geo.position;
      preset.size = geo.size;
      await saveSettings(settings);
    } catch (e) {
      console.error("[overlay] persist geometry failed", e);
    }
  }
}
