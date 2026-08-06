// Appearance / control pane: a live preview plus grouped controls for color,
// type, placement and highlight style, with the overlay updating in real time.
import { cmd } from "../../shared/ipc";
import type { AnimationStyle, BackgroundStyle, ContextCount, DockMode, Preset } from "../../shared/settings";
import { ROMANIZATION_OFF, romanizationOn, systemChromeColor } from "../../shared/settings";
import { availableFontGroups } from "../fonts";
import { LyricPreview } from "../preview";
import type { SettingsCtx, Tab } from "../tab";
import { button, card, checkbox, colorInput, el, field, numberInput, range, segmented, select } from "../ui";

// One live preview instance; cancel the previous loop when the tab re-renders.
let live: LyricPreview | null = null;

/**
 * Font picker: a grouped dropdown of the faces actually installed, each option
 * drawn in its own typeface.
 *
 * This used to be a bare text box with a hidden datalist, so the only way to
 * discover a font was to guess its name and hope autocomplete caught it — which
 * reads as the app shipping exactly one font. A name typed by hand still works:
 * an unrecognised current value is kept as its own option rather than silently
 * snapping to something else.
 */
function fontSelect(current: string, onPick: (family: string) => void): HTMLSelectElement {
  const sel = el("select", { className: "font-select" });
  const groups = availableFontGroups();
  const known = groups.some((g) => g.fonts.includes(current));

  if (!known && current) {
    const og = el("optgroup");
    og.label = "Current";
    const opt = el("option", { value: current, textContent: current });
    opt.style.fontFamily = `"${current}", sans-serif`;
    opt.selected = true;
    og.append(opt);
    sel.append(og);
  }

  for (const g of groups) {
    const og = el("optgroup");
    og.label = g.label;
    for (const f of g.fonts) {
      const opt = el("option", { value: f, textContent: f });
      opt.style.fontFamily = `"${f}", sans-serif`; // show the face, not just its name
      if (f === current) opt.selected = true;
      og.append(opt);
    }
    sel.append(og);
  }

  sel.addEventListener("change", () => onPick(sel.value));
  return sel;
}

function render(ctx: SettingsCtx): HTMLElement {
  const s = ctx.settings;
  const presetNames = Object.keys(s.presets);
  const preset = s.presets[s.activePreset] ?? s.presets[presetNames[0]!]!;
  const root = el("div", { className: "ap" });

  live?.stop();
  const preview = new LyricPreview();
  live = preview;
  preview.update(preset);

  // A working copy so the preview reflects edits synchronously (patch persists
  // to the store asynchronously; we don't want to wait on it to redraw).
  const working = structuredClone(preset);
  const edit = (fn: (p: Preset) => void): void => {
    fn(working);
    preview.update(working);
    void ctx.patch((n) => fn(n.presets[n.activePreset]!));
  };

  // ---- Header: title + preset toolbar --------------------------------------
  root.append(
    el("div", { className: "ap-head" }, [
      el("div", {}, [
        el("h1", { textContent: "Overlay" }),
        el("p", { className: "ap-sub", textContent: "Tune how lyrics look and where they sit. Changes apply live." }),
      ]),
    ]),
  );

  const selector = select(
    presetNames.map((n) => ({ value: n, label: n })),
    s.activePreset,
    (v) => void ctx.update((n) => (n.activePreset = v)),
  );
  const saveBtn = button("Save as new", () => {
    const name = prompt("Name this preset:")?.trim();
    if (!name) return;
    void ctx.update((n) => {
      n.presets[name] = { ...structuredClone(working), name };
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
  root.append(
    el("div", { className: "ap-toolbar" }, [
      el("label", { className: "ap-toolbar-label", textContent: "Preset" }),
      selector,
      el("span", { className: "ap-toolbar-spacer" }),
      saveBtn,
      deleteBtn,
    ]),
  );

  // ---- The live preview (signature element) --------------------------------
  root.append(preview.el);

  // ---- Quick actions -------------------------------------------------------
  const docked = (working.dock ?? "float") !== "float";
  const moveBtn = button("Move overlay", () => void cmd.setEditMode(true), "primary");
  moveBtn.disabled = docked;
  const actions = el("div", { className: "ap-actions" }, [
    moveBtn,
    button("Show / hide", () => void cmd.toggleOverlay()),
  ]);
  if (docked) {
    actions.append(el("span", { className: "ap-hint", textContent: "Set placement to Float to drag the overlay freely." }));
  }
  root.append(actions);

  // ---- Control cards -------------------------------------------------------
  const grid = el("div", { className: "card-grid" });

  grid.append(
    card("Highlight", [
      el("p", { className: "card-note", textContent: "How the words light up as they're sung." }),
      segmented<AnimationStyle>(
        [
          { value: "none", label: "None" },
          { value: "fill", label: "Karaoke" },
          { value: "spotlight", label: "Spotlight" },
        ],
        working.animation === "fade" ? "none" : working.animation,
        (v) => edit((p) => (p.animation = v)),
      ),
    ]),
  );

  grid.append(
    card("Type", [
      field(
        "Font",
        fontSelect(working.font.family, (family) => edit((p) => (p.font.family = family))),
      ),
      field("Size", numberInput(working.font.sizePx, (v) => edit((p) => (p.font.sizePx = v)), { min: 8, max: 160 })),
      field("Weight", numberInput(working.font.weight, (v) => edit((p) => (p.font.weight = v)), { min: 100, max: 900, step: 100 })),
      field("Line spacing", numberInput(working.lineSpacing, (v) => edit((p) => (p.lineSpacing = v)), { min: 1, max: 3, step: 0.05 })),
    ]),
  );

  grid.append(
    card("Color", [
      field("Text", colorInput(working.colors.base, (v) => edit((p) => (p.colors.base = v)))),
      field("Highlight", colorInput(working.colors.fill, (v) => edit((p) => (p.colors.fill = v)))),
      field("Text shadow", checkbox(working.colors.textShadow, (v) => edit((p) => (p.colors.textShadow = v)))),
      field("Outline", checkbox(working.colors.outline, (v) => edit((p) => (p.colors.outline = v)))),
    ]),
  );

  grid.append(
    card("Text", [
      field("Opacity", range(working.textOpacity, 0.1, 1, 0.05, (v) => edit((p) => (p.textOpacity = v))), working.textOpacity.toFixed(2)),
      field("Brightness", range(working.textBrightness, 0.5, 1.5, 0.05, (v) => edit((p) => (p.textBrightness = v))), working.textBrightness.toFixed(2)),
    ]),
  );

  grid.append(
    card("Lyrics language", [
      el("p", {
        className: "card-note",
        textContent:
          "Shown beside the lyric: romaji on the left, translation on the right. Prefers built-in translations; AI fills the rest when set up in Language.",
      }),
      field(
        "Show romaji",
        checkbox(romanizationOn(s.romanization), (v) =>
          void ctx.patch((n) => {
            // Off clears the per-script overrides too, otherwise an advanced
            // override from the Language tab would keep romaji on screen.
            n.romanization = v ? { ...n.romanization, auto: true } : { ...ROMANIZATION_OFF };
          }),
        ),
        "Romanized reading for non-Latin lyrics (Japanese, Chinese, Korean, Russian).",
      ),
      field(
        "Show translation",
        checkbox(s.translation.show, (v) => void ctx.patch((n) => (n.translation.show = v))),
      ),
    ]),
  );

  grid.append(
    card("Placement", [
      field(
        "Dock",
        select<DockMode>(
          [
            { value: "float", label: "Float (drag freely)" },
            { value: "top", label: "Top bar" },
            { value: "bottom", label: "Bottom bar" },
          ],
          working.dock ?? "float",
          (v) => void ctx.update((n) => (n.presets[n.activePreset]!.dock = v)),
        ),
      ),
      field("Bar height", numberInput(working.size.h, (v) => edit((p) => (p.size.h = v)), { min: 40, max: 400 })),
      ...(docked
        ? [
            field(
              "Reserve space",
              checkbox(working.reserveSpace ?? false, (v) =>
                void ctx.update((n) => (n.presets[n.activePreset]!.reserveSpace = v)),
              ),
            ),
            el("p", {
              className: "card-note",
              textContent:
                "Give the bar its own strip of desktop, like the taskbar. Maximised windows resize around it instead of being covered, and the bar no longer sits on top of the taskbar or your browser tabs.",
            }),
            // "Follow the system theme" is the *absence* of a stored colour
            // (see apply.ts), but a colour input always holds one — so touching
            // the picker pinned the strip to a fixed shade with no way back, and
            // the theme-following default became unreachable for good. The
            // checkbox is that way back: it clears the value rather than writing
            // a new one.
            field(
              "Match system theme",
              checkbox(working.stripColor === undefined, (v) =>
                void ctx.update((n) => {
                  const p = n.presets[n.activePreset]!;
                  if (v) delete p.stripColor;
                  else p.stripColor = systemChromeColor(); // start from what's on screen
                }),
              ),
              "Follows Windows light/dark, and moves with it.",
            ),
            ...(working.stripColor === undefined
              ? []
              : [
                  field(
                    "Strip fill",
                    colorInput(working.stripColor, (v) => edit((p) => (p.stripColor = v))),
                  ),
                ]),
            field(
              "Strip opacity",
              range(working.stripOpacity ?? 1, 0, 1, 0.05, (v) =>
                edit((p) => (p.stripOpacity = v)),
              ),
              (working.stripOpacity ?? 1) === 0
                ? "wallpaper"
                : (working.stripOpacity ?? 1).toFixed(2),
            ),
            el("p", {
              className: "card-note",
              textContent:
                "Fills the whole bar, behind the lyric box. At 0 the wallpaper shows through.",
            }),
          ]
        : []),
      field("Lines above", contextSelect(working.contextLines.before, (v) => edit((p) => (p.contextLines.before = v)))),
      field("Lines below", contextSelect(working.contextLines.after, (v) => edit((p) => (p.contextLines.after = v)))),
    ]),
  );

  grid.append(
    card("Background", [
      field(
        "Style",
        select<BackgroundStyle>(
          [
            { value: "none", label: "None" },
            { value: "glass", label: "Glass (blur)" },
            { value: "solid", label: "Solid" },
          ],
          working.background,
          (v) => edit((p) => (p.background = v)),
        ),
      ),
      field("Color", colorInput(working.backgroundColor, (v) => edit((p) => (p.backgroundColor = v)))),
      field("Opacity", range(working.opacity, 0.1, 1, 0.05, (v) => edit((p) => (p.opacity = v))), working.opacity.toFixed(2)),
    ]),
  );

  grid.append(
    card("Timing & visibility", [
      field("Global offset (ms)", numberInput(s.globalOffsetMs, (v) => void ctx.patch((n) => (n.globalOffsetMs = v)), { step: 50 })),
      field("Hide when paused", checkbox(s.autoHide.enabled, (v) => void ctx.patch((n) => (n.autoHide.enabled = v)))),
      field("Hide delay (s)", numberInput(s.autoHide.delaySec, (v) => void ctx.patch((n) => (n.autoHide.delaySec = v)), { min: 1, max: 60 })),
    ]),
  );

  root.append(grid);
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

export const appearanceTab: Tab = { id: "appearance", label: "Overlay", render };
