// Language tab: romanization toggles + user-API translation.
import type { SettingsCtx, Tab } from "../tab";
import { checkbox, el, field, section, select, textInput } from "../ui";

function render(ctx: SettingsCtx): HTMLElement {
  const s = ctx.settings;
  const root = el("div");
  root.append(el("h1", { textContent: "Language" }));

  root.append(section("Romanization (offline)"));
  root.append(
    el("div", {
      className: "hint",
      textContent: "Shows a romanized sub-line under matching lyrics. Applied live.",
    }),
    field("Japanese → romaji", checkbox(s.romanization.ja, (v) => void ctx.patch((n) => (n.romanization.ja = v)))),
    field(
      "Japanese furigana",
      checkbox(s.romanization.jaFurigana, (v) => void ctx.patch((n) => (n.romanization.jaFurigana = v))),
      "Ruby above kanji; Japanese lines use whole-line highlight.",
    ),
    field("Chinese → pinyin", checkbox(s.romanization.zh, (v) => void ctx.patch((n) => (n.romanization.zh = v)))),
    field("Korean → romaja", checkbox(s.romanization.ko, (v) => void ctx.patch((n) => (n.romanization.ko = v)))),
    field("Russian → translit", checkbox(s.romanization.ru, (v) => void ctx.patch((n) => (n.romanization.ru = v)))),
  );

  root.append(section("Translation (your API key)"));
  root.append(
    el("div", {
      className: "notice warn",
      textContent:
        "API key is stored locally in plain text. Lines are translated once per track (batched) and cached — never re-translated during playback.",
    }),
    field("Enabled", checkbox(s.translation.enabled, (v) => void ctx.update((n) => (n.translation.enabled = v)))),
    field(
      "Provider",
      select(
        [
          { value: "deepl", label: "DeepL" },
          { value: "google", label: "Google Cloud" },
          { value: "openai", label: "OpenAI-compatible" },
        ],
        s.translation.provider,
        (v) => void ctx.patch((n) => (n.translation.provider = v)),
      ),
    ),
    field("Target language", textInput(s.translation.targetLang, (v) => void ctx.patch((n) => (n.translation.targetLang = v)))),
    field("API key", textInput(s.translation.apiKey, (v) => void ctx.patch((n) => (n.translation.apiKey = v)))),
    field("Base URL (optional)", textInput(s.translation.baseUrl ?? "", (v) => void ctx.patch((n) => (n.translation.baseUrl = v)))),
    field("Model (OpenAI)", textInput(s.translation.model ?? "", (v) => void ctx.patch((n) => (n.translation.model = v)))),
  );

  return root;
}

export const languageTab: Tab = { id: "language", label: "Language", render };
