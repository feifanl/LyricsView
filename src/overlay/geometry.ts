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
import { cmd } from "../shared/ipc";
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

  // Docked: full-width bar pinned flush to the monitor's top or bottom edge.
  // Saved position/width are ignored; only the bar height is preset-driven.
  const dock = preset.dock ?? "float";
  if (dock !== "float") {
    const mon = await pickMonitor(preset.monitor);
    if (!mon) return;
    const barH = Math.round(h);

    // Reserving space hands the placement to the shell: it slides the strip
    // clear of the taskbar and any other appbar, then positions the window
    // itself. Doing our own setSize/setPosition afterwards would fight it.
    if (preset.reserveSpace) {
      try {
        const granted = await cmd.setReservedBar(
          dock,
          {
            left: mon.position.x,
            top: mon.position.y,
            right: mon.position.x + mon.size.width,
            bottom: mon.position.y + mon.size.height,
          },
          barH,
        );
        if (granted) {
          const [gl, gt, gr, gb] = granted;
          // Place the window from the granted rect here, not in the Rust call.
          // SHAppBarMessage moves it too, but on a re-apply something lands
          // after that and leaves the window exactly one thickness above the
          // strip it reserved. Setting it last from this side is what makes the
          // position stick.
          await win.setSize(new PhysicalSize(gr - gl, gb - gt));
          await win.setPosition(new PhysicalPosition(gl, gt));

          const pos = await win.outerPosition();
          const size = await win.outerSize();
          // Flat string on purpose: the console collapses nested arrays to
          // "Array(4)" and these numbers are the whole point.
          console.info(
            `[overlay] strip edge=${dock} asked=${barH} ` +
              `monitor=(${mon.position.x},${mon.position.y} ${mon.size.width}x${mon.size.height}) ` +
              `granted=(${gl},${gt} -> ${gr},${gb} = ${gr - gl}x${gb - gt}) ` +
              `window=(${pos.x},${pos.y} ${size.width}x${size.height})`,
          );
          return;
        }
        console.warn("[overlay] reserve returned no rect — falling back to overlap");
      } catch (e) {
        console.error("[overlay] could not reserve desktop space", e);
      }
      // Fall through and place it ourselves — an overlapping bar beats none.
    } else {
      await cmd.setReservedBar(null, { left: 0, top: 0, right: 0, bottom: 0 }, 0);
    }

    await win.setSize(new PhysicalSize(mon.size.width, barH));
    const y = dock === "top" ? mon.position.y : mon.position.y + mon.size.height - barH;
    await win.setPosition(new PhysicalPosition(mon.position.x, y));
    return;
  }

  // Float mode never reserves; release anything a docked preset left behind.
  await cmd.setReservedBar(null, { left: 0, top: 0, right: 0, bottom: 0 }, 0);
  await win.setSize(new PhysicalSize(Math.round(w), Math.round(h)));

  const mon = await pickMonitor(preset.monitor);
  if (!mon) return;

  // Default: docked near the top-center of the work area.
  const defX = Math.round((mon.size.width - w) / 2);
  const defY = Math.round(mon.size.height * 0.04);
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
