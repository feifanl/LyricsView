// Lyric lines tab: which forms show (romaji / original / translation), their
// order, and the layout (inline row, stacked rows, or a single cycled form).
import type { LyricForm } from "../../shared/settings";
import type { SettingsCtx, Tab } from "../tab";
import { button, checkbox, el, field, section, segmented } from "../ui";

const FORM_LABEL: Record<LyricForm, string> = {
  romaji: "Romaji",
  original: "Original",
  translation: "Translation",
};

function moveForm(order: LyricForm[], from: number, to: number): void {
  if (to < 0 || to >= order.length) return;
  const [f] = order.splice(from, 1);
  order.splice(to, 0, f!);
}

function render(ctx: SettingsCtx): HTMLElement {
  const s = ctx.settings;
  const ll = s.lyricLines;
  const root = el("div");
  root.append(el("h1", { textContent: "Lyric lines" }));

  root.append(section("Layout"));
  root.append(
    el("div", {
      className: "hint",
      textContent:
        "Inline shows the chosen forms side by side on one line. Stacked puts each on its own line (bulkier). Single shows one form; cycle between them with the form hotkeys (default Alt+Shift+Up/Down).",
    }),
    field(
      "Arrangement",
      segmented(
        [
          { value: "inline", label: "Inline" },
          { value: "stacked", label: "Stacked" },
          { value: "single", label: "Single" },
        ],
        ll.layout,
        (v) => void ctx.update((n) => (n.lyricLines.layout = v)),
      ),
    ),
  );

  root.append(section("Forms & order"));
  root.append(
    el("div", {
      className: "hint",
      textContent:
        "Toggle which forms appear and reorder them (top = first / leftmost). Romaji needs romanization on; translation needs it available for the track.",
    }),
  );

  ll.order.forEach((form, i) => {
    const up = button("↑", () => void ctx.update((n) => moveForm(n.lyricLines.order, i, i - 1)), "ghost icon");
    const down = button("↓", () => void ctx.update((n) => moveForm(n.lyricLines.order, i, i + 1)), "ghost icon");
    up.disabled = i === 0;
    down.disabled = i === ll.order.length - 1;
    const toggle = checkbox(ll.enabled[form], (v) => void ctx.patch((n) => (n.lyricLines.enabled[form] = v)));
    const controls = el("span", { className: "row-controls" }, [up, down, toggle]);
    root.append(field(FORM_LABEL[form], controls));
  });

  return root;
}

export const lyricLinesTab: Tab = { id: "lyricLines", label: "Lyric lines", render };
