// Appearance tab: pick/edit/create presets with live overlay updates.
import type { AnimationStyle, BackgroundStyle, ContextCount, DockMode, Preset } from "../../shared/settings";
import type { SettingsCtx, Tab } from "../tab";
import { button, checkbox, colorInput, el, field, numberInput, range, section, select } from "../ui";

const COMMON_FONTS = [
  "Segoe UI",
  "Arial",
  "Calibri",
  "Consolas",
  "Georgia",
  "Tahoma",
  "Verdana",
  "Times New Roman",
];

function fontDatalist(): HTMLDataListElement {
  const list = el("datalist", { id: "font-list" });
  for (const f of COMMON_FONTS) list.append(el("option", { value: f }));
  return list;
}

function render(ctx: SettingsCtx): HTMLElement {
  const s = ctx.settings;
  const presetNames = Object.keys(s.presets);
  const preset = s.presets[s.activePreset] ?? s.presets[presetNames[0]!]!;
  const root = el("div");

  root.append(el("h1", { textContent: "Appearance" }));

  // Preset selector + create/delete.
  const selector = select(
    presetNames.map((n) => ({ value: n, label: n })),
    s.activePreset,
    (v) => void ctx.update((n) => (n.activePreset = v)),
  );
  const createBtn = button("Save as new…", () => {
    const name = prompt("New preset name:")?.trim();
    if (!name) return;
    void ctx.update((n) => {
      n.presets[name] = { ...structuredClone(preset), name };
      n.activePreset = name;
    });
  });
  const deleteBtn = button("Delete", () => {
    if (presetNames.length <= 1) return;
    void ctx.update((n) => {
      delete n.presets[s.activePreset];
      n.activePreset = Object.keys(n.presets)[0]!;
    });
  });
  root.append(field("Active preset", selector), field("", el("span", {}, [createBtn, deleteBtn])));

  // Live control edits: persist + broadcast without re-rendering (keeps focus).
  const edit = (fn: (p: Preset) => void): void =>
    void ctx.patch((n) => fn(n.presets[n.activePreset]!));

  root.append(section("Font"));
  const fontInput = el("input", { type: "text", value: preset.font.family });
  fontInput.setAttribute("list", "font-list");
  fontInput.addEventListener("input", () => edit((p) => (p.font.family = fontInput.value)));
  root.append(fontDatalist(), field("Family", fontInput));
  root.append(
    field("Size (px)", numberInput(preset.font.sizePx, (v) => edit((p) => (p.font.sizePx = v)), { min: 8, max: 160 })),
    field("Weight", numberInput(preset.font.weight, (v) => edit((p) => (p.font.weight = v)), { min: 100, max: 900, step: 100 })),
    field("Line spacing", numberInput(preset.lineSpacing, (v) => edit((p) => (p.lineSpacing = v)), { min: 1, max: 3, step: 0.05 })),
  );

  root.append(section("Colors"));
  root.append(
    field("Base text", colorInput(preset.colors.base, (v) => edit((p) => (p.colors.base = v)))),
    field("Fill / highlight", colorInput(preset.colors.fill, (v) => edit((p) => (p.colors.fill = v)))),
    field("Text shadow", checkbox(preset.colors.textShadow, (v) => edit((p) => (p.colors.textShadow = v)))),
    field("Outline", checkbox(preset.colors.outline, (v) => edit((p) => (p.colors.outline = v)))),
  );

  root.append(section("Background & layout"));
  root.append(
    field(
      "Dock",
      select<DockMode>(
        [
          { value: "float", label: "Float (drag in edit mode)" },
          { value: "top", label: "Top bar (full width)" },
          { value: "bottom", label: "Bottom bar (full width)" },
        ],
        preset.dock ?? "float",
        (v) => edit((p) => (p.dock = v)),
      ),
    ),
    field("Bar height (px)", numberInput(preset.size.h, (v) => edit((p) => (p.size.h = v)), { min: 40, max: 400 })),
    field(
      "Background",
      select<BackgroundStyle>(
        [
          { value: "none", label: "None" },
          { value: "glass", label: "Glass (blur)" },
          { value: "solid", label: "Solid" },
        ],
        preset.background,
        (v) => edit((p) => (p.background = v)),
      ),
    ),
    field("Background color", colorInput(preset.backgroundColor, (v) => edit((p) => (p.backgroundColor = v)))),
    field(
      "Opacity",
      range(preset.opacity, 0.1, 1, 0.05, (v) => edit((p) => (p.opacity = v))),
      preset.opacity.toFixed(2),
    ),
    field("Context lines before", contextSelect(preset.contextLines.before, (v) => edit((p) => (p.contextLines.before = v)))),
    field("Context lines after", contextSelect(preset.contextLines.after, (v) => edit((p) => (p.contextLines.after = v)))),
    field(
      "Animation",
      select<AnimationStyle>(
        [
          { value: "fill", label: "Word fill" },
          { value: "fade", label: "Line fade" },
          { value: "none", label: "None" },
        ],
        preset.animation,
        (v) => edit((p) => (p.animation = v)),
      ),
    ),
  );

  root.append(section("General"));
  root.append(
    field("Global offset (ms)", numberInput(s.globalOffsetMs, (v) => void ctx.patch((n) => (n.globalOffsetMs = v)), { step: 50 })),
    field("Auto-hide when paused", checkbox(s.autoHide.enabled, (v) => void ctx.patch((n) => (n.autoHide.enabled = v)))),
    field("Auto-hide delay (s)", numberInput(s.autoHide.delaySec, (v) => void ctx.patch((n) => (n.autoHide.delaySec = v)), { min: 1, max: 60 })),
  );

  return root;
}

function contextSelect(value: ContextCount, onChange: (v: ContextCount) => void): HTMLSelectElement {
  return select(
    [
      { value: "0", label: "0" },
      { value: "1", label: "1" },
      { value: "2", label: "2" },
    ],
    String(value) as "0" | "1" | "2",
    (v) => onChange(Number(v) as ContextCount),
  );
}

export const appearanceTab: Tab = { id: "appearance", label: "Appearance", render };
