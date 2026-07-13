// Timestamp editor: one row per line (timestamp · text · ±100 ms nudge). Tap
// mode stamps the current estimated playback position onto the next unstamped
// line — the way you build an LRC from plain text. Export to .lrc or save for
// the current track (as manual, preferred). Row text edits drop that row's word
// timing (it will be re-interpolated).
import { PlaybackClock } from "../../overlay/clock";
import { cmd, onPlaybackState, onTimeline } from "../../shared/ipc";
import type { LyricWord } from "../../shared/types";
import type { SettingsCtx, Tab } from "../tab";
import { button, el, field } from "../ui";

interface Row {
  startMs: number | null;
  text: string;
  words?: LyricWord[];
}

// A settings-window clock fed by the same SMTC events as the overlay.
const clock = new PlaybackClock();
void onTimeline((t) => clock.update(t, Date.now()));
void onPlaybackState((p) => clock.setPlaying(p.playing, Date.now()));

// Single global Space handler; the active editor render wires its stamp fn here.
let activeStamp: (() => void) | null = null;
window.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  if (e.code === "Space" && tag !== "INPUT" && tag !== "TEXTAREA" && activeStamp) {
    e.preventDefault();
    activeStamp();
  }
});

function fmtTs(ms: number | null): string {
  if (ms === null) return "--:--.--";
  const cs = Math.floor((ms % 1000) / 10);
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function toLrc(rows: Row[]): string {
  return rows
    .filter((r) => r.startMs !== null)
    .map((r) => {
      const ts = `[${fmtTs(r.startMs)}]`;
      if (r.words && r.words.length > 0) {
        return ts + r.words.map((w) => `<${fmtTs(w.start)}>${w.text}`).join("");
      }
      return ts + r.text;
    })
    .join("\n");
}

function render(_ctx: SettingsCtx): HTMLElement {
  const root = el("div");
  root.append(el("h1", { textContent: "Timestamp editor" }));

  let rows: Row[] = [];
  let trackKey: string | null = null;
  const status = el("div", { className: "hint", textContent: "Load the current track or paste lines below." });
  const tableWrap = el("div", { className: "editor-table" });

  void cmd.currentTrackKey().then((k) => (trackKey = k));

  const draw = (): void => {
    tableWrap.replaceChildren();
    const table = el("table", { className: "grid" });
    table.append(
      el("tr", {}, [
        el("th", { textContent: "#" }),
        el("th", { textContent: "Time" }),
        el("th", { textContent: "Nudge" }),
        el("th", { textContent: "Text" }),
      ]),
    );
    rows.forEach((r, i) => {
      const time = el("td", { textContent: fmtTs(r.startMs) });
      const minus = button("−", () => {
        if (r.startMs !== null) r.startMs = Math.max(0, r.startMs - 100);
        time.textContent = fmtTs(r.startMs);
      });
      const plus = button("+", () => {
        if (r.startMs !== null) r.startMs += 100;
        time.textContent = fmtTs(r.startMs);
      });
      const input = el("input", { type: "text", value: r.text });
      input.style.width = "100%";
      input.addEventListener("input", () => {
        r.text = input.value;
        r.words = undefined; // editing text invalidates word timing
      });
      table.append(
        el("tr", {}, [
          el("td", { textContent: String(i + 1) }),
          time,
          el("td", {}, [minus, plus]),
          el("td", {}, [input]),
        ]),
      );
    });
    tableWrap.append(table);
  };

  const loadCurrent = async (): Promise<void> => {
    const track = await cmd.currentTrack();
    if (!track) {
      status.textContent = "No track playing.";
      return;
    }
    const doc = await cmd.fetchLyrics(track, false);
    if (!doc || doc.lines.length === 0) {
      status.textContent = "No synced lyrics found; paste plain text instead.";
      return;
    }
    rows = doc.lines.map((l) => ({ startMs: l.start, text: l.text, words: l.words }));
    status.textContent = `Loaded ${rows.length} lines.`;
    draw();
  };

  const paste = el("textarea", { className: "paste-area" });
  paste.rows = 6;
  paste.placeholder = "Paste plain lyrics (one line each) to stamp from scratch";
  const loadPaste = (): void => {
    rows = paste.value
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => ({ startMs: null, text: t }));
    status.textContent = `Loaded ${rows.length} plain lines — use Tap to stamp.`;
    draw();
  };

  const stamp = (): void => {
    const next = rows.find((r) => r.startMs === null);
    if (!next) {
      status.textContent = "All lines stamped.";
      return;
    }
    next.startMs = Math.round(clock.estimate(Date.now()));
    status.textContent = `Stamped at ${fmtTs(next.startMs)}.`;
    draw();
  };

  activeStamp = stamp;

  const saveForTrack = async (): Promise<void> => {
    if (!trackKey) {
      status.textContent = "No current track to save to.";
      return;
    }
    await cmd.saveManualLyrics(trackKey, toLrc(rows));
    status.textContent = "Saved for this track (manual). Overlay updated.";
  };

  const exportFile = async (): Promise<void> => {
    if (!trackKey) return;
    await cmd.saveManualLyrics(trackKey, toLrc(rows));
    const ok = await cmd.exportLrc(trackKey);
    status.textContent = ok ? "Exported .lrc." : "Export cancelled.";
  };

  root.append(
    field("", el("span", {}, [
      button("Load current lyrics", () => void loadCurrent(), "primary"),
      button("Tap / Stamp (Space)", stamp),
      button("Save for track", () => void saveForTrack()),
      button("Export .lrc", () => void exportFile()),
    ])),
    status,
    tableWrap,
    field("", paste),
    field("", button("Load pasted lines", loadPaste)),
  );
  return root;
}

export const editorTab: Tab = { id: "editor", label: "Editor", render };
