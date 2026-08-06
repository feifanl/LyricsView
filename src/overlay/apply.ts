// Maps the active preset onto the overlay's CSS variables and container
// classes. Pure DOM side-effects; called on boot and on settings change.
import { activePreset, systemChromeColor, type Settings } from "../shared/settings";

/** `#rrggbb` plus a 0–1 alpha, as rgba(). Anything else is passed through, so a
 *  colour already carrying its own alpha still works. */
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const n = Number.parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function applyPresetVars(settings: Settings): void {
  const p = activePreset(settings);
  const root = document.documentElement;
  root.style.setProperty("--base-color", p.colors.base);
  root.style.setProperty("--fill-color", p.colors.fill);
  root.style.setProperty("--font-size-base", `${p.font.sizePx}px`);
  root.style.setProperty("--font-family", `"${p.font.family}", system-ui, sans-serif`);
  root.style.setProperty("--font-weight", String(p.font.weight));
  root.style.setProperty("--line-spacing", String(p.lineSpacing));
  root.style.setProperty("--text-opacity", String(p.textOpacity ?? 1));
  root.style.setProperty("--text-brightness", String(p.textBrightness ?? 1));

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

  // Fill behind the whole docked strip. Only the CSS rule is gated on `docked`,
  // so a float preset keeps its transparent window whatever this is set to.
  root.style.setProperty(
    "--strip-bg",
    withAlpha(p.stripColor ?? systemChromeColor(), p.stripOpacity ?? 1),
  );

  const dock = p.dock ?? "float";
  body.classList.toggle("docked", dock !== "float");
  body.classList.toggle("dock-top", dock === "top");
  body.classList.toggle("dock-bottom", dock === "bottom");
}
