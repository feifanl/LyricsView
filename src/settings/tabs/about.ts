// About tab: app info, UI theme toggle, legal note.
import type { SettingsCtx, Tab } from "../tab";
import { el, field, section, select } from "../ui";

function render(ctx: SettingsCtx): HTMLElement {
  const root = el("div");
  root.append(
    el("h1", { textContent: "LyricsView" }),
    el("p", { className: "hint", textContent: "Free floating karaoke lyrics overlay for Windows · v0.1.0" }),
  );

  root.append(section("Interface"));
  root.append(
    field(
      "Settings theme",
      select(
        [
          { value: "dark", label: "Dark" },
          { value: "light", label: "Light" },
        ],
        ctx.settings.uiTheme,
        (v) => void ctx.update((n) => (n.uiTheme = v)),
      ),
      "Overlay colors are set per preset, not themed.",
    ),
  );

  root.append(section("Notes"));
  root.append(
    el("div", {
      className: "notice",
      textContent:
        "Private use only. Lyrics are fetched live per track and cached locally — never bundled or redistributed. The overlay cannot appear over exclusive-fullscreen apps (a Windows limitation).",
    }),
  );
  return root;
}

export const aboutTab: Tab = { id: "about", label: "About", render };
