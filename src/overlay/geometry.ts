// Overlay geometry persistence. Positions are stored relative to a monitor's
// origin so saved layouts survive monitor rearrangement; on restore they are
// clamped back into the visible area.
import {
  availableMonitors,
  currentMonitor,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
  type Monitor,
} from "@tauri-apps/api/window";
import type { Preset } from "../shared/settings";

export interface Geometry {
  monitor: number | null;
  position: { x: number; y: number };
  size: { w: number; h: number };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

async function pickMonitor(index: number | null): Promise<Monitor | null> {
  const monitors = await availableMonitors();
  if (index !== null && monitors[index]) return monitors[index]!;
  return (await currentMonitor()) ?? monitors[0] ?? null;
}

/** Apply a preset's size + position to the overlay window. */
export async function restoreGeometry(preset: Preset): Promise<void> {
  const win = getCurrentWindow();
  const { w, h } = preset.size;
  await win.setSize(new PhysicalSize(Math.round(w), Math.round(h)));

  const mon = await pickMonitor(preset.monitor);
  if (!mon) return;

  const defX = Math.round((mon.size.width - w) / 2);
  const defY = Math.round((mon.size.height - h) * 0.8);
  const relX = preset.position?.x ?? defX;
  const relY = preset.position?.y ?? defY;

  const x = clamp(mon.position.x + relX, mon.position.x, mon.position.x + mon.size.width - w);
  const y = clamp(mon.position.y + relY, mon.position.y, mon.position.y + mon.size.height - h);
  await win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
}

/** Read the overlay's current geometry, relative to its monitor. */
export async function captureGeometry(): Promise<Geometry> {
  const win = getCurrentWindow();
  const pos = await win.outerPosition();
  const size = await win.outerSize();
  const monitors = await availableMonitors();
  const cur = await currentMonitor();

  let monitorIdx: number | null = cur
    ? monitors.findIndex(
        (m) => m.position.x === cur.position.x && m.position.y === cur.position.y,
      )
    : -1;
  if (monitorIdx === -1) monitorIdx = null;

  const base = (monitorIdx !== null ? monitors[monitorIdx] : cur) ?? null;
  return {
    monitor: monitorIdx,
    position: {
      x: base ? pos.x - base.position.x : pos.x,
      y: base ? pos.y - base.position.y : pos.y,
    },
    size: { w: size.width, h: size.height },
  };
}
