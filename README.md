# LyricsView

A free **floating karaoke-lyrics overlay for Windows** — a transparent, borderless,
always-on-top window that shows word-by-word synced lyrics for whatever is playing in
**any SMTC-compatible player** (Spotify, YouTube Music in a browser, Apple Music for
Windows, foobar2000 v2+, …).

Built with **Tauri 2** (Rust core) + **vanilla TypeScript / Vite** frontend.

> Lyrics are fetched live per track and cached locally on your machine — never
> bundled, never redistributed. This project ships no lyrics data of any kind.

## Screenshots

_(placeholder — add overlay/settings screenshots here)_

- `docs/overlay.png` — karaoke overlay over a game / browser
- `docs/settings.png` — settings window

## Features

- Word-by-word karaoke fill driven by an interpolated, drift-corrected playback clock.
- Providers with fallback: **LRCLIB** (line-level) → 
  **Musixmatch** richsync (word-level) → **NetEase** yrc (word-level, strong CJK) →
  **Apple Music** syllable TTML. Line-only lyrics still get smooth per-word fill via
  interpolation.
- Local per-track cache (works fully offline on replay), preferred-source pick,
  per-track offset and drift correction.
- Click-through "locked" mode and an "edit" mode for drag/resize; multi-monitor,
  position persists across restarts.
- Global hotkeys (offset nudge, drift nudge, line jump, reload, toggle overlay/edit).
- Presets (Gaming / Karaoke / Subtitle) + full live appearance customization.
- Offline romanization: Japanese romaji + furigana, Chinese pinyin, Korean romaja,
  Russian transliteration.
- Optional translation via **your own** DeepL / Google / OpenAI-compatible API key
  (batched once per track, cached).
- Timestamp editor with tap-to-stamp and `.lrc` export; paste/import lyrics.
- Share the current line as a PNG card (clipboard + save).

## Setup

Requirements: **Node 18+**, **Rust (stable, MSVC)**, and the Windows build tools
(Visual Studio C++ / Build Tools + WebView2, which ships with Windows 11).

```bash
npm install
```

```bash
npm run tauri dev
```

```bash
npm run tauri build
```

The kuromoji dictionary (for Japanese) is copied into `public/kuromoji-dict` by a
`predev`/`prebuild` script; no manual step needed.

## Lyrics providers

**LRCLIB and NetEase are enabled out of the box.** LRCLIB is an open, public,
no-authentication lyrics API built to be used exactly this way. NetEase supplies the
word-level timings and bundled translations that LRCLIB does not carry.

Musixmatch and Apple Music ship **disabled**. Musixmatch needs no account — it is off
because it is the most exposed of the undocumented endpoints, not because it is hard to
use. Apple Music needs your own subscription tokens. Musixmatch, NetEase and Apple Music
all reach undocumented endpoints belonging to commercial services, and using them is
subject to those services' terms:

| Provider | Default | Notes |
|---|---|---|
| LRCLIB | **on** | Open public API, line-level |
| NetEase | **on** | Undocumented endpoint; word-level yrc, bundled translations, strong CJK |
| Musixmatch | off | Undocumented endpoint; word-level richsync **and translations**; no account needed |
| Apple Music | off | Requires your own subscription tokens |

Change any of them in Settings → Providers.

## Apple Music (optional, off by default)

Apple Music syllable lyrics require **your own Apple Music subscription tokens** — no
token is shipped. To enable:

1. Sign in at <https://music.apple.com> in a browser.
2. Open DevTools → Network, play a song, and inspect a request to
   `amp-api.music.apple.com`:
   - **`Authorization: Bearer …`** → your *developer token*.
   - **`Music-User-Token: …`** request header → your *media-user-token*.
3. In Settings → Providers → Apple Music, paste both tokens and set your storefront
   (e.g. `us`), then enable the Apple Music provider.

Tokens are stored locally in plain text and are only ever sent to Apple's own API.

## Translation (optional)

Settings → Language → Translation. Choose DeepL, Google Cloud Translation, or an
OpenAI-compatible endpoint (configurable base URL + model), paste your API key, set a
target language. Lines are translated once per track in a single batched request and
cached.

Without a key, translations come from whichever provider supplies them:

- **Musixmatch** carries translations in many languages, including English. It needs no
  account, but ships disabled — enable it in Settings → Providers.
- **NetEase** carries `tlyric`, written for a Chinese-reading audience. It only appears
  when your target language is Chinese; a Chinese translation is not shown to someone
  reading English.

With neither enabled and no API key, the translated line stays blank. The overlay says so
once rather than leaving you guessing.

## Global hotkeys (defaults, rebindable in Settings)

| Action | Default |
|---|---|
| Toggle overlay visibility | `Alt+Shift+L` |
| Toggle edit mode | `Alt+Shift+E` |
| Offset −100 ms | `Alt+Shift+[` |
| Offset +100 ms | `Alt+Shift+]` |
| Drift −0.25% | `Alt+Shift+,` |
| Drift +0.25% | `Alt+Shift+.` |
| Jump to previous line | `Alt+Shift+←` |
| Jump to next line | `Alt+Shift+→` |
| Cycle lyric form (prev / next) | `Alt+Shift+↑` / `Alt+Shift+↓` |
| Sync: tap as a line starts | `Alt+Shift+S` |
| Sync: reset this track | `Alt+Shift+0` |
| Reload lyrics (bypass cache) | `Alt+Shift+R` |

## Known limitations

- **Windows only.**
- The overlay appears over borderless-windowed games but **cannot appear over
  exclusive-fullscreen applications** — a Windows compositing limitation, not a bug.
- Requires **foobar2000 v2+** (older versions don't expose SMTC).
- **Musixmatch / NetEase / Apple Music are unofficial** endpoints: they can break,
  rate-limit, or return a captcha at any time. They fail silently and fall back to the
  next provider, and can each be disabled in Settings → Providers.
- Some players (Spotify) don't emit continuous timeline events; the app polls timeline
  properties every second to compensate. On tracks where the player never republishes
  its position the clock free-runs from a single anchor, so a stale anchor offsets the
  whole song. Per-track offset correction exists for this.
- A lyrics file may be timed to a different release than the one you are playing. The
  symptom is drift that grows linearly through the song. Tap `Alt+Shift+S` as a line
  begins, then again a minute or more later, and the correction is solved from the two
  taps. `Alt+Shift+0` clears it.

## Legal

This is an unofficial, independent project. It is **not affiliated with, endorsed by,
or connected to** Spotify, Apple, Musixmatch, NetEase, LRCLIB, or any other service it
can talk to. All trademarks belong to their respective owners.

The project contains **no lyrics data**. Lyrics are fetched at runtime from whichever
provider you enable, and cached locally on your own machine as private data. Nothing is
bundled, uploaded, or redistributed. There is no telemetry, no account, and no
auto-update.

You are responsible for your own use of the third-party services this client can reach,
including any credentials you supply and the terms those services impose. LRCLIB
and NetEase are enabled by default; the rest are opt-in for that reason.

## License

MIT — see [LICENSE](LICENSE).
