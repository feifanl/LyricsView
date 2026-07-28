// Settings window shell: tab navigation + a live-update context. Every change
// persists to the store and broadcasts `settings://changed` so the overlay
// re-applies immediately.
import { emitSettingsChanged } from "../shared/ipc";
import type { Settings } from "../shared/settings";
import { loadSettings, saveSettings } from "../shared/store";
import type { SettingsCtx, Tab } from "./tab";
import { aboutTab } from "./tabs/about";
import { appearanceTab } from "./tabs/appearance";
import { editorTab } from "./tabs/editor";
import { hotkeysTab } from "./tabs/hotkeys";
import { languageTab } from "./tabs/language";
import { lyricLinesTab } from "./tabs/lyricLines";
import { pasteTab } from "./tabs/paste";
import { providersTab } from "./tabs/providers";
import { searchTab } from "./tabs/search";

const tabsEl = document.getElementById("tabs") as HTMLElement;
const contentEl = document.getElementById("tab-content") as HTMLElement;

const tabs: Tab[] = [
  appearanceTab,
  providersTab,
  searchTab,
  pasteTab,
  editorTab,
  languageTab,
  lyricLinesTab,
  hotkeysTab,
  aboutTab,
];

async function boot(): Promise<void> {
  let settings = await loadSettings();
  document.documentElement.dataset.theme = settings.uiTheme;
  let active = tabs[0]!.id;

  // Writes are serialized: controls fire faster than a store round-trip, and two
  // overlapping read-modify-writes would drop the earlier edit.
  let writes: Promise<void> = Promise.resolve();

  async function persist(mutator: (s: Settings) => void): Promise<void> {
    writes = writes.then(async () => {
      // Re-read rather than mutating the boot-time copy: the overlay writes the
      // preset's geometry straight to the store when the user finishes dragging
      // in edit mode, and this window would otherwise write that drag back out.
      const next = await loadSettings();
      mutator(next);
      settings = next;
      ctx.settings = next;
      document.documentElement.dataset.theme = next.uiTheme;
      await saveSettings(next);
      await emitSettingsChanged(next);
    });
    await writes;
  }

  const ctx: SettingsCtx = {
    settings,
    async update(mutator) {
      await persist(mutator);
      renderActive();
    },
    async patch(mutator) {
      await persist(mutator);
    },
    rerender: () => renderActive(),
  };

  function renderNav(): void {
    const brand = document.createElement("div");
    brand.className = "brand";
    const mark = Object.assign(document.createElement("span"), { className: "brand-mark" });
    for (let i = 0; i < 3; i++) mark.append(document.createElement("i"));
    brand.append(
      mark,
      Object.assign(document.createElement("span"), { className: "brand-name", textContent: "Lyricify" }),
    );
    tabsEl.replaceChildren(
      brand,
      ...tabs.map((t) => {
        const b = document.createElement("button");
        b.className = "tab-btn" + (t.id === active ? " active" : "");
        b.textContent = t.label;
        b.addEventListener("click", () => {
          active = t.id;
          renderNav();
          renderActive();
        });
        return b;
      }),
    );
  }

  function renderActive(): void {
    const tab = tabs.find((t) => t.id === active) ?? tabs[0]!;
    contentEl.replaceChildren(tab.render(ctx));
  }

  renderNav();
  renderActive();
}

void boot();
