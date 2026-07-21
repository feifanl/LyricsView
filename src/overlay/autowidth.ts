// Float-mode auto-width: grow the overlay window sideways when the current row
// (romaji | lyric | translation) wants more room than the preset width gives,
// and fall back to the preset width when it doesn't. Docked bars already span
// the monitor, so they're left alone.
//
// The window keeps its centre while it grows, otherwise the text would appear to
// slide right as the right edge moves out.
import { LogicalPosition, LogicalSize, availableMonitors, currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { activePreset, type Settings } from "../shared/settings";

/** Ignore width changes smaller than this (CSS px) — sub-pixel text measurement
 *  differences shouldn't move the window. */
const MIN_DELTA = 12;
/** Don't resize more often than this (ms); line changes can come in bursts. */
const MIN_INTERVAL = 120;

let enabled = false;
let baseW = 0; // preset width, in CSS px
let monLeft = 0;
let monW = 0;
let paused = false; // edit mode: the user is dragging/resizing, keep out of it
let applying = false;
let lastApplied = 0;

/** Re-read the preset and monitor. Call on boot and whenever settings change. */
export async function configureAutoWidth(settings: Settings): Promise<void> {
  const preset = activePreset(settings);
  enabled = (preset.dock ?? "float") === "float";
  lastApplied = 0;
  if (!enabled) return;
  try {
    const win = getCurrentWindow();
    const sf = await win.scaleFactor();
    baseW = preset.size.w / sf;
    const monitors = await availableMonitors();
    const mon = (preset.monitor !== null ? monitors[preset.monitor] : null) ?? (await currentMonitor());
    if (mon) {
      monLeft = mon.position.x / sf;
      monW = mon.size.width / sf;
    }
  } catch (e) {
    console.error("[overlay] auto-width setup failed", e);
    enabled = false;
  }
}

/** Edit mode owns the geometry while it's on, and persists whatever size the
 *  window has on exit — so hand back the preset width before stepping aside,
 *  otherwise an auto-widened window would be saved as the user's preset. */
export async function pauseAutoWidth(on: boolean): Promise<void> {
  paused = on;
  if (!on || !enabled || baseW <= 0) return;
  const curW = window.innerWidth;
  if (Math.abs(curW - baseW) >= MIN_DELTA) await applyWidth(Math.round(baseW), curW);
}

/** Renderer callback: `wants` is the row's unclipped width, `avail` the width it
 *  was given, both CSS px. `wants` is 0 when the line has no side columns. */
export function requestWidth(wants: number, avail: number): void {
  if (!enabled || paused || applying || baseW <= 0) return;
  const curW = window.innerWidth;
  // Everything the box spends that isn't row: window padding, box padding and
  // the fit's safety margin. Constant because the box tracks the window 1:1.
  const chrome = curW - avail;
  const target = Math.round(Math.min(Math.max(wants + chrome, baseW), monW || baseW));
  if (Math.abs(target - curW) < MIN_DELTA) return;
  if (Date.now() - lastApplied < MIN_INTERVAL) return;
  lastApplied = Date.now();
  applying = true;
  void applyWidth(target, curW).finally(() => {
    applying = false;
  });
}

async function applyWidth(target: number, curW: number): Promise<void> {
  try {
    const win = getCurrentWindow();
    const sf = await win.scaleFactor();
    const size = (await win.outerSize()).toLogical(sf);
    const pos = (await win.outerPosition()).toLogical(sf);
    await win.setSize(new LogicalSize(target, size.height));
    // Grow/shrink around the centre, then keep the window on its monitor.
    let x = pos.x - (target - curW) / 2;
    if (monW > 0) x = Math.min(Math.max(x, monLeft), monLeft + monW - target);
    await win.setPosition(new LogicalPosition(Math.round(x), Math.round(pos.y)));
  } catch (e) {
    console.error("[overlay] auto-width resize failed", e);
  }
}
