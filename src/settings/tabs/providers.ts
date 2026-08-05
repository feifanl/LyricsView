// Providers tab: chain order + enable toggles, prefer-word-level, Apple Music
// tokens, SMTC session pin, and cache info / clear.
import { cmd } from "../../shared/ipc";
import type { SourceId } from "../../shared/types";
import type { SettingsCtx, Tab } from "../tab";
import { button, checkbox, el, field, section, textInput } from "../ui";

const LABELS: Record<SourceId, string> = {
  lrclib: "LRCLIB",
  musixmatch: "Musixmatch (word-level)",
  netease: "NetEase (word-level)",
  applemusic: "Apple Music (token required)",
  manual: "Manual",
};

function render(ctx: SettingsCtx): HTMLElement {
  const s = ctx.settings;
  const root = el("div");
  root.append(el("h1", { textContent: "Providers" }));
  root.append(
    el("div", {
      className: "notice",
      textContent:
        "LRCLIB is on by default: it is an open, public lyrics API meant to be used this way. " +
        "Musixmatch, NetEase and Apple Music are off by default — they reach undocumented " +
        "endpoints belonging to commercial services, so enabling them is your call and is " +
        "subject to those services' terms. They can break or rate-limit at any time, and they " +
        "fail silently and fall back to the next provider.",
    }),
  );

  root.append(section("Fallback order"));
  s.providerOrder.forEach((id, i) => {
    const enabled = s.providersEnabled[id] ?? true;
    const up = button("↑", () => void ctx.update((n) => moveItem(n.providerOrder, i, -1)));
    const down = button("↓", () => void ctx.update((n) => moveItem(n.providerOrder, i, 1)));
    const enable = checkbox(enabled, (v) => void ctx.patch((n) => (n.providersEnabled[id] = v)));
    const row = el("div", { className: "field" }, [
      el("label", { textContent: `${i + 1}. ${LABELS[id]}` }),
      enable,
      up,
      down,
    ]);
    root.append(row);
  });

  root.append(
    field(
      "Prefer word-level",
      checkbox(s.preferWordLevel, (v) => void ctx.patch((n) => (n.preferWordLevel = v))),
      "Keep scanning for word timing even after a line-level hit.",
    ),
  );

  root.append(section("Apple Music (optional)"));
  root.append(
    el("div", {
      className: "notice warn",
      textContent:
        "Requires your own Apple Music subscription tokens (media-user-token + developer token from music.apple.com). Stored locally in plain text. See the README.",
    }),
    field("Media user token", textInput(s.appleMusic.mediaUserToken, (v) => void ctx.patch((n) => (n.appleMusic.mediaUserToken = v)))),
    field("Developer token", textInput(s.appleMusic.developerToken, (v) => void ctx.patch((n) => (n.appleMusic.developerToken = v)))),
    field("Storefront", textInput(s.appleMusic.storefront, (v) => void ctx.patch((n) => (n.appleMusic.storefront = v)))),
  );

  root.append(section("Now-playing source"));
  root.append(sessionPinField(ctx));

  root.append(section("Cache"));
  root.append(cacheField());

  return root;
}

function moveItem<T>(arr: T[], i: number, dir: -1 | 1): void {
  const j = i + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j]!, arr[i]!];
}

function sessionPinField(ctx: SettingsCtx): HTMLElement {
  const sel = el("select");
  sel.append(el("option", { value: "", textContent: "Automatic (current session)" }));
  sel.addEventListener("change", () => {
    void cmd.setPinnedSession(sel.value === "" ? null : sel.value);
  });
  void cmd.listSmtcSessions().then((sessions) => {
    for (const s of sessions) {
      sel.append(el("option", { value: s.appId, textContent: s.appId + (s.isCurrent ? " (current)" : "") }));
    }
  });
  const refresh = button("Refresh", () => ctx.rerender());
  return field("Pin source app", el("span", {}, [sel, refresh]));
}

function cacheField(): HTMLElement {
  const info = el("span", { className: "hint", textContent: "…" });
  const load = (): void => {
    void cmd.getCacheInfo().then((c) => {
      info.textContent = `${c.entries} tracks · ${(c.bytes / 1024).toFixed(1)} KiB`;
    });
  };
  load();
  const clear = button("Clear cache", () => {
    void cmd.clearCache().then(load);
  });
  return field("Cached lyrics", el("span", {}, [clear, info]));
}

export const providersTab: Tab = { id: "providers", label: "Providers", render };
