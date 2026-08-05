// Paste tab: import raw LRC / Enhanced-LRC / plain text as manual lyrics for
// the current track (cached as source "manual" and set preferred).
import { cmd } from "../../shared/ipc";
import type { SettingsCtx, Tab } from "../tab";
import { button, el, field } from "../ui";

function render(_ctx: SettingsCtx): HTMLElement {
  const root = el("div");
  root.append(el("h1", { textContent: "Paste lyrics" }));

  let trackKey: string | null = null;
  const note = el("div", { className: "hint", textContent: "Loading current track…" });
  void cmd.currentTrackKey().then((k) => {
    trackKey = k;
    note.textContent = k
      ? "Paste LRC, Enhanced-LRC or plain text; it is saved for the current track."
      : "No track playing — start a track first.";
  });

  const area = el("textarea", { className: "paste-area" });
  area.rows = 16;
  area.placeholder = "[00:12.00]first line of the lyrics\n[00:16.50]second line of the lyrics";

  const status = el("span", { className: "hint" });
  const save = button(
    "Save for this track",
    () => {
      if (!trackKey) {
        status.textContent = "No current track.";
        return;
      }
      void cmd
        .saveManualLyrics(trackKey, area.value)
        .then((doc) => {
          status.textContent = `Saved ${doc.lines.length} lines (source: manual). Overlay updated.`;
        })
        .catch((e) => {
          status.textContent = `Parse failed: ${e}`;
        });
    },
    "primary",
  );

  root.append(note, field("", area), field("", el("span", {}, [save, status])));
  return root;
}

export const pasteTab: Tab = { id: "paste", label: "Paste", render };
