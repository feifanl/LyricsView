// Search tab: query any provider explicitly, preview a candidate, and pick one
// as the preferred source for the current track.
import { cmd } from "../../shared/ipc";
import type { LyricsDoc, SearchCandidate, SourceId } from "../../shared/types";
import type { SettingsCtx, Tab } from "../tab";
import { button, el, field, section, select, textInput } from "../ui";

const PROVIDERS: { value: SourceId; label: string }[] = [
  { value: "lrclib", label: "LRCLIB" },
  { value: "musixmatch", label: "Musixmatch" },
  { value: "netease", label: "NetEase" },
  { value: "applemusic", label: "Apple Music" },
];

function render(_ctx: SettingsCtx): HTMLElement {
  const root = el("div");
  root.append(el("h1", { textContent: "Search" }));

  let provider: SourceId = "lrclib";
  let query = "";
  let trackKey: string | null = null;

  const note = el("div", { className: "hint", textContent: "Loading current track…" });
  void cmd.currentTrackKey().then((k) => {
    trackKey = k;
    note.textContent = k ? "Picking a result sets it as the preferred source for the current track." : "No track playing — start a track to save a pick.";
  });

  const queryInput = textInput("", (v) => (query = v));
  (queryInput as HTMLInputElement).placeholder = "title artist";
  const providerSel = select(PROVIDERS, provider, (v) => (provider = v));

  const results = el("div", { className: "search-results" });
  const preview = el("pre", { className: "lyrics-preview" });

  const doSearch = async (): Promise<void> => {
    results.textContent = "Searching…";
    preview.textContent = "";
    try {
      const cands = await cmd.searchProvider(provider, query);
      renderResults(cands);
    } catch (e) {
      results.textContent = "Search failed.";
      console.error(e);
    }
  };

  function renderResults(cands: SearchCandidate[]): void {
    results.replaceChildren();
    if (cands.length === 0) {
      results.textContent = "No results.";
      return;
    }
    for (const c of cands) {
      const meta = [
        c.artist,
        c.album,
        c.durationMs ? `${Math.round(c.durationMs / 1000)}s` : null,
        c.hasWordTiming ? "word-level" : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const row = el("div", { className: "result-row" }, [
        el("div", {}, [el("strong", { textContent: c.title }), el("div", { className: "hint", textContent: meta })]),
        button("Preview", () => void doPreview(c)),
        button("Use for track", () => void useCandidate(c), "primary"),
      ]);
      results.append(row);
    }
  }

  async function doPreview(c: SearchCandidate): Promise<void> {
    preview.textContent = "Loading…";
    const doc = await cmd.fetchCandidate(c);
    preview.textContent = docToText(doc);
  }

  async function useCandidate(c: SearchCandidate): Promise<void> {
    if (!trackKey) {
      note.textContent = "No current track to save to.";
      return;
    }
    const doc = await cmd.applyCandidate(trackKey, c);
    note.textContent = doc ? "Saved as preferred source. Overlay updated." : "Could not load that candidate.";
  }

  root.append(
    field("Provider", providerSel),
    field("Query", queryInput),
    field("", button("Search", () => void doSearch(), "primary")),
    note,
    section("Results"),
    results,
    section("Preview"),
    preview,
  );
  return root;
}

function docToText(doc: LyricsDoc | null): string {
  if (!doc) return "(no lyrics)";
  if (doc.lines.length > 0) return doc.lines.map((l) => l.text).join("\n");
  return doc.plain ?? "(empty)";
}

export const searchTab: Tab = { id: "search", label: "Search", render };
