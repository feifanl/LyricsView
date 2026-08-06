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
        "LRCLIB and NetEase are on by default — LRCLIB for line-level lyrics, NetEase for " +
        "word-level timings and Chinese translations. Musixmatch, NetEase and Apple Music all " +
        "reach undocumented endpoints belonging to commercial services, so using them is " +
        "subject to those services' terms. They can break or rate-limit at any time, and they " +
        "fail silently and fall back to the next provider.",
    }),
  );
  root.append(musixmatchCallout(ctx));

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

/**
 * One-click enable for Musixmatch, shown only while it is off.
 *
 * It is the only provider that supplies translations outside Chinese and needs
 * nothing from the user — no account, no token, just an anonymous handshake. It
 * ships disabled anyway, so without saying this plainly the translated line is
 * blank on most songs with no indication that a switch exists.
 */
function musixmatchCallout(ctx: SettingsCtx): HTMLElement {
  const wrap = el("div", { className: "notice" });
  if (ctx.settings.providersEnabled.musixmatch) {
    wrap.textContent =
      "Musixmatch is on: word-by-word timing and English translations, no account needed.";
    return wrap;
  }
  wrap.append(
    el("span", {
      textContent:
        "Translations in languages other than Chinese come from Musixmatch, which is off. " +
        "It needs no account or token. Enabling it also gives word-by-word karaoke timing on " +
        "most songs. Already-cached songs need a reload (Alt+Shift+R) to pick it up.",
    }),
    button("Enable Musixmatch", () => {
      void ctx.patch((n) => (n.providersEnabled.musixmatch = true)).then(() => ctx.rerender());
    }),
  );
  return wrap;
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
