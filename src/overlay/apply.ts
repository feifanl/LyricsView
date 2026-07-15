// Maps the active preset onto the overlay's CSS variables and container
// classes. Pure DOM side-effects; called on boot and on settings change.
import { activePreset, type Settings } from "../shared/settings";

export function applyPresetVars(settings: Settings): void {
  const p = activePreset(settings);
  const root = document.documentElement;
  root.style.setProperty("--base-color", p.colors.base);
  root.style.setProperty("--fill-color", p.colors.fill);
  root.style.setProperty("--font-size", `${p.font.sizePx}px`);
  root.style.setProperty("--font-family", `"${p.font.family}", system-ui, sans-serif`);
  root.style.setProperty("--font-weight", String(p.font.weight));
  root.style.setProperty("--line-spacing", String(p.lineSpacing));

  const overlayRoot = document.querySelector<HTMLElement>(".overlay-root");
  if (overlayRoot) overlayRoot.style.opacity = String(p.opacity);

  const lyrics = document.getElementById("lyrics");
  if (lyrics) {
    lyrics.classList.remove("bg-none", "bg-glass", "bg-solid");
    lyrics.classList.add(`bg-${p.background}`);
    lyrics.style.setProperty("--bg-color", p.backgroundColor);
  }

  const body = document.body;
  body.classList.toggle("text-shadow", p.colors.textShadow);
  body.classList.toggle("outline", p.colors.outline);

  const dock = p.dock ?? "float";
  body.classList.toggle("docked", dock !== "float");
  body.classList.toggle("dock-top", dock === "top");
  body.classList.toggle("dock-bottom", dock === "bottom");
}
