// Hotkeys tab: rebind each action by capturing a key chord, then ask Rust to
// re-register the global shortcuts.
import { cmd } from "../../shared/ipc";
import type { HotkeyAction } from "../../shared/settings";
import type { SettingsCtx, Tab } from "../tab";
import { button, el, field } from "../ui";

const ACTIONS: { id: HotkeyAction; label: string }[] = [
  { id: "toggleOverlay", label: "Toggle overlay" },
  { id: "toggleEditMode", label: "Toggle edit mode" },
  { id: "offsetMinus", label: "Offset −100 ms" },
  { id: "offsetPlus", label: "Offset +100 ms" },
  { id: "driftMinus", label: "Drift − (lyrics run slower)" },
  { id: "driftPlus", label: "Drift + (lyrics run faster)" },
  { id: "prevLine", label: "Jump to previous line" },
  { id: "nextLine", label: "Jump to next line" },
  { id: "reloadLyrics", label: "Reload lyrics" },
  { id: "cycleFormPrev", label: "Previous form (single-line layout)" },
  { id: "cycleFormNext", label: "Next form (single-line layout)" },
  { id: "syncMark", label: "Sync: tap as a line starts (twice, far apart)" },
  { id: "resetSync", label: "Sync: reset this track" },
];

const ARROWS: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  " ": "Space",
};

function accelerator(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return null; // modifier only
  let key = ARROWS[e.key] ?? e.key;
  if (key.length === 1) key = key.toUpperCase();
  return [...mods, key].join("+");
}

function render(ctx: SettingsCtx): HTMLElement {
  const root = el("div");
  root.append(el("h1", { textContent: "Hotkeys" }));
  root.append(el("div", { className: "hint", textContent: "Click a binding, then press the new key combination." }));

  for (const { id, label } of ACTIONS) {
    const current = ctx.settings.hotkeys[id];
    const btn = button(current, () => beginCapture(btn, id, ctx));
    btn.dataset.action = id;
    root.append(field(label, btn));
  }
  return root;
}

function beginCapture(btn: HTMLButtonElement, action: HotkeyAction, ctx: SettingsCtx): void {
  btn.textContent = "press keys…";
  const onKey = (e: KeyboardEvent): void => {
    e.preventDefault();
    const accel = accelerator(e);
    if (!accel) return; // wait for a non-modifier key
    window.removeEventListener("keydown", onKey, true);
    void (async () => {
      await ctx.patch((s) => (s.hotkeys[action] = accel));
      await cmd.applyHotkeys();
      ctx.rerender();
    })();
  };
  window.addEventListener("keydown", onKey, true);
}

export const hotkeysTab: Tab = { id: "hotkeys", label: "Hotkeys", render };
