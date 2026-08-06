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

interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Widest work area seen per monitor — see `freeWorkArea`. */
const freeEdges = new Map<string, Edges>();

function monitorKey(m: Monitor): string {
  return `${m.position.x},${m.position.y},${m.size.width}x${m.size.height}`;
}

/**
 * The work area as it is when we hold no strip of our own.
 *
 * `mon.workArea` cannot be used directly for placement: while our strip is
 * registered, our own band is subtracted from it. Re-reading it to place the bar
 * therefore measured from the inner edge of the bar itself, and every re-apply —
 * every keystroke in the Bar height field — walked the bar another height
 * inward. Releasing and re-reserving is what appeared to "fix" it, because that
 * gave back the space before the next read.
 *
 * Reading it after releasing doesn't work either: ABM_REMOVE returns at once but
 * the work area is a cached metric the shell republishes later, so the value is
 * still stale.
 *
 * So track the widest work area ever seen for this monitor. Our reservation can
 * only ever shrink it, which makes the widest observation the one taken without
 * our strip — no timing assumptions required. Cleared on release so a genuine
 * change (the user resizing their taskbar) can settle to a new value.
 */
function freeWorkArea(mon: Monitor): Edges {
  const wa = mon.workArea;
  const seen: Edges = {
    left: wa.position.x,
    top: wa.position.y,
    right: wa.position.x + wa.size.width,
    bottom: wa.position.y + wa.size.height,
  };
  const key = monitorKey(mon);
  const prev = freeEdges.get(key);
  const widest: Edges = prev
    ? {
        left: Math.min(prev.left, seen.left),
        top: Math.min(prev.top, seen.top),
        right: Math.max(prev.right, seen.right),
        bottom: Math.max(prev.bottom, seen.bottom),
      }
    : seen;
  freeEdges.set(key, widest);
  return widest;
}

/** Hand back any reserved strip, leaving the window where it is. */
export async function releaseStrip(): Promise<void> {
  await cmd.setReservedBar(null, { left: 0, top: 0, right: 0, bottom: 0 }, 0);
  // Let the remembered edges settle again from scratch: with nothing of ours
  // reserved, whatever is measured next is the truth, including a taskbar the
  // user has since resized.
  freeEdges.clear();
}

/**
 * Apply a preset's size + position to the overlay window.
 *
 * `reserve` is what actually claims desktop space, and the caller decides when:
 * the strip is only worth holding while a song is playing. Reserving shrinks
 * every maximised window on the desktop, so doing it for the whole time the app
 * happens to be running rearranges the user's screen over a bar showing nothing.
 * With it false the bar still sits flush to the edge — it just overlaps rather
 * than displacing.
 */
export async function restoreGeometry(preset: Preset, reserve = false): Promise<void> {
  const win = getCurrentWindow();
  const { w, h } = preset.size;

  // Docked: full-width bar pinned flush to the monitor's top or bottom edge.
  // Saved position/width are ignored; only the bar height is preset-driven.
  const dock = preset.dock ?? "float";
  if (dock !== "float") {
    const mon = await pickMonitor(preset.monitor);
    if (!mon) return;
    // "Bar height" is entered in the settings window alongside the font size, so
    // it means CSS pixels — the unit the bar's contents are laid out in. The
    // shell and the window API want device pixels. Passing the number through
    // unconverted made the setting mean something different on every display: on
    // a 125% screen a bar set to 74 gave the lyric only 59 CSS pixels to sit in,
    // so the text looked shrunken inside an over-tall strip, and the same
    // setting looked right at 100%.
    const barH = Math.round(h * mon.scaleFactor);

    const edge = freeWorkArea(mon);

    if (preset.reserveSpace && reserve) {
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
        // Flat string on purpose: the console collapses nested arrays to
        // "Array(4)" and these numbers are the whole point.
        console.info(
          `[overlay] strip edge=${dock} asked=${barH} ` +
            `monitor=(${mon.position.x},${mon.position.y} ${mon.size.width}x${mon.size.height}) ` +
            `freeWorkArea=(${edge.top} -> ${edge.bottom}) ` +
            `granted=${granted ? `(${granted[1]} -> ${granted[3]})` : "none"}`,
        );
        if (!granted) {
          console.warn("[overlay] reserve returned no rect — falling back to overlap");
        }
      } catch (e) {
        console.error("[overlay] could not reserve desktop space", e);
      }
      // Placement falls through either way. Where the bar sits is our decision,
      // not the shell's: it books the space, but the rect it books can stop
      // short of the taskbar, and a window placed there floats above it with
      // bare desktop showing through the gap.
    } else {
      await releaseStrip();
    }

    // One placement rule, reserved or not: flush inside the work area read
    // above. Claiming and releasing the strip then moves the bar not at all —
    // only whether other windows lay out around it.
    await win.setSize(new PhysicalSize(edge.right - edge.left, barH));
    const y = dock === "top" ? edge.top : edge.bottom - barH;
    await win.setPosition(new PhysicalPosition(edge.left, y));
    return;
  }

  // Float mode never reserves; release anything a docked preset left behind.
  await releaseStrip();
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
